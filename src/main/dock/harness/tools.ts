/**
 * The dock harness's five tools + path confinement.
 *
 * Ported from claude-dock `src/main/harness/tools.js`. Everything the agent
 * touches stays inside the folder the user picked for the session.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Tool output that lands back in the model's context. Anything larger is
// truncated rather than silently blowing up the conversation.
//
// The server needs this number too: read-back verification of a written file
// cannot compare a truncated read against a whole-file digest, so it treats
// anything past this cap as unverifiable. It lives in `@lore/contracts` as
// `EXECUTOR_MAX_OUTPUT_CHARS`, which this file may not import — the synced OSS
// surface must compile standalone — so the value is duplicated deliberately and
// `dockExecutorClient.test.ts` fails if the two ever drift. Changing it here
// means changing it there, in the same commit.
export const MAX_OUTPUT = 20000
const COMMAND_TIMEOUT_MS = 60_000
// Exported so a test can schedule against the same numbers the code uses,
// rather than re-declaring them and drifting. Both are deadlines, so both are
// reached through `ShellExecDependencies.scheduleDeadline`.
export const TERMINATION_GRACE_MS = 2_000
export const TERMINATION_OBSERVATION_MS = 2_000
// zsh on macOS (the product target); plain sh elsewhere so the hermetic
// tests also run on Linux CI, which has no /bin/zsh.
const SHELL = process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh'

// Image formats a tool result may carry, and the per-response caps on carrying
// them. Duplicated from `@lore/contracts` for the same reason `MAX_OUTPUT` is —
// this file may not import it — and pinned the same way: `dockExecutorClient.test.ts`
// fails if these and `executorImageSchema` / `EXECUTOR_MAX_IMAGE_BYTES` /
// `EXECUTOR_MAX_IMAGES_PER_RESPONSE` ever disagree.
//
// The media types are a value rather than a bare union so the drift test has
// something to compare; a union type alone is invisible from outside the file.
// The set is closed to raster formats deliberately: `image/svg+xml` is an image
// type that can carry a script, on a path whose producer screenshots untrusted
// web pages.
export const TOOL_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
// A budget for one response, not for one image: `MAX_IMAGE_BYTES` bounds the
// sum of every image's decoded bytes. Decoded, not base64 — measuring the
// encoded form would bound something the artifact store never writes.
export const MAX_IMAGE_BYTES = 5_000_000
export const MAX_IMAGES_PER_RESPONSE = 4

/**
 * One image riding a tool result: the ephemeral bytes the model sees plus the
 * digest that binds them to the durable copy. `data` is base64 with no `data:`
 * prefix, while `digest` and `byteLength` describe the *decoded* bytes.
 * `artifactRef` is nullable rather than optional because its absence is a real
 * outcome — the durable write failed — that the result still has to report,
 * not a field an older producer forgot.
 */
export interface ToolImage {
  mediaType: (typeof TOOL_IMAGE_MEDIA_TYPES)[number]
  data: string
  digest: string
  byteLength: number
  width: number
  height: number
  artifactRef: string | null
}

export interface ToolResult {
  ok: boolean
  output: string
  /**
   * Absent unless a tool actually produced images — the bytes never ride the
   * `output` string, and every existing tool leaves this alone.
   */
  images?: ToolImage[]
}

export interface ShellTerminationEvidence {
  trigger: 'cancelled' | 'primitive_timeout'
  requestedSignal: 'SIGTERM'
  escalatedToSigkill: boolean
  observed:
    | { kind: 'exit'; code: number }
    | { kind: 'signal'; signal: string }
    | { kind: 'unconfirmed' }
}

/** A shell result additionally records whether the child process reached `spawn`. */
export interface ShellToolResult extends ToolResult {
  started: boolean
  termination?: ShellTerminationEvidence
}

export interface ShellExecDependencies {
  /** Test seam for deterministic signal-delivery failures; production uses process.kill. */
  killProcessGroup(pid: number, signal: NodeJS.Signals): void
  /**
   * Every *deadline* on the termination path goes through here: the command's
   * own timeout, the SIGTERM->SIGKILL grace, and the post-SIGKILL observation
   * window. One seam for all three, so a test drives elapsed time instead of
   * waiting it out — `TERMINATION_GRACE_MS` and `TERMINATION_OBSERVATION_MS`
   * are two seconds each, and a test that races them against a real process is
   * asserting the machine's speed rather than this file's behavior.
   *
   * Returns the canceller rather than a handle so the caller never has to know
   * whether the underlying timer came from `setTimeout` or a test's queue.
   *
   * Deliberately *not* covering the 10ms group-exit poll in
   * `finishWhenGroupExits`. That one waits for a condition (the group is gone)
   * rather than for a duration, so it settles on the OS's schedule no matter
   * what a clock says, and faking it would only hide the wait.
   */
  scheduleDeadline(run: () => void, ms: number): () => void
}

const DEFAULT_SHELL_EXEC_DEPENDENCIES: ShellExecDependencies = {
  killProcessGroup: (pid, signal) => process.kill(-pid, signal),
  scheduleDeadline: (run, ms) => {
    const handle = setTimeout(run, ms)
    return () => clearTimeout(handle)
  },
}

/**
 * Thrown by `resolveInRoot` when a model-supplied path escapes the session
 * folder. A distinct type (rather than a bare `Error`) so the executor client
 * can map confinement failures to a `denied` error code, separate from an
 * ordinary `exec_failed`. Host-agnostic — no Lore/transport imports.
 */
export class PathDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathDeniedError'
  }
}

/** Missing read target, preserved so the executor can distinguish absence from failure. */
export class TargetNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TargetNotFoundError'
  }
}

export interface ToolInput {
  path?: string
  old_text?: string
  new_text?: string
  content?: string
  command?: string
  title?: string
}

export function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text
  // `text` is already a decoded JS string, so `.length` and `.slice` count
  // UTF-16 code units, not characters — an astral character (an emoji, or a
  // rare CJK-extension codepoint) is stored as a surrogate *pair*. Cutting
  // exactly at MAX_OUTPUT can therefore land between the two halves of one
  // pair, leaving a lone surrogate in the output. That is not a cosmetic
  // glitch: a lone surrogate is invalid UTF-16, and Node silently rewrites it
  // to U+FFFD the moment this string is encoded to UTF-8 bytes (e.g. for the
  // JSON/IPC transport this result travels over), so the model would receive
  // mojibake anyway, just introduced one step later. Back the cut off by one
  // so the character is either whole or entirely omitted, never split.
  let cut = MAX_OUTPUT
  const high = text.charCodeAt(cut - 1)
  const low = text.charCodeAt(cut)
  if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
    cut -= 1
  }
  const omitted = text.length - cut
  return `${text.slice(0, cut)}\n\n[... ${omitted} more characters omitted ...]`
}

/**
 * Resolve a model-supplied path against the session's root folder.
 *
 * The path comes from the model, so it is untrusted: `..`, absolute paths, and
 * symlinks that escape the root are all rejected.
 */
export function resolveInRoot(root: string, relative: unknown): string {
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new Error('A path is required.')
  }
  const realRoot = fs.realpathSync(root)
  const target = path.resolve(realRoot, relative)

  // realpath the deepest part that exists, so a symlink in any parent that
  // points outside the root is caught even when the leaf does not exist yet.
  let probe = target
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
    probe = path.dirname(probe)
  }
  const realProbe = fs.realpathSync(probe)
  const suffix = path.relative(probe, target)
  const resolved = path.resolve(realProbe, suffix)

  const rel = path.relative(realRoot, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathDeniedError(`Path escapes the session folder: ${relative}`)
  }
  return resolved
}

function listFiles(root: string, relative = '.'): string {
  const dir = resolveInRoot(root, relative || '.')
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const lines = entries
    .filter((e) => !e.name.startsWith('.') || e.name === '.env.example')
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort()
  if (lines.length === 0) return '(empty folder)'
  return lines.join('\n')
}

/**
 * `read_file` has no extension allowlist — the model must stay able to read
 * any *text* file in the folder — so a binary file (PDF, `.docx`, images, …)
 * is only caught here, by actually failing to decode. Byte-scraping a
 * compressed or binary format (PDF content streams are FlateDecode-deflated,
 * `.docx` is a ZIP) recovers nothing by construction, so returning `ok: true`
 * with the raw bytes reinterpreted as UTF-8 is worse than refusing outright:
 * it hands the model confident-looking mojibake instead of a clear failure.
 *
 * Matches the decision already made for the human-facing preview path
 * (`dockSourcePreview.ts`): decode with a *fatal* UTF-8 decoder and treat the
 * throw as a distinct, named failure rather than inventing a heuristic. A
 * successful decode is still not proof of "text" on its own — a NUL byte is
 * legal in a UTF-8 byte sequence but never appears in text a person would
 * write — so that case is rejected too.
 */
function decodeAsText(buffer: Buffer, relative: unknown): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new Error(
      `${String(relative)} is not valid UTF-8 text, so it cannot be read this way — either it is a binary or ` +
        'compressed format (such as a PDF, image, or Word document), or it is a text file saved in a different ' +
        'encoding (such as UTF-16 or Latin-1). Only plain UTF-8 text can be read this way; open it with an ' +
        'appropriate application, or re-save it as UTF-8, instead.',
    )
  }
  if (text.includes('\u0000')) {
    throw new Error(
      `${String(relative)} contains binary data (a NUL byte), not plain text, so it cannot be read this way. ` +
        'Only plain-text files can be read; open it with an appropriate application instead.',
    )
  }
  return text
}

function readFile(root: string, relative: unknown): string {
  const file = resolveInRoot(root, relative)
  let buffer: Buffer
  try {
    buffer = fs.readFileSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TargetNotFoundError(`Path not found: ${String(relative)}`)
    }
    throw error
  }
  // Decode before truncating: truncation operates on the decoded string, not
  // raw bytes, so a multi-byte character is never split into an invalid
  // sequence by the length cap.
  return truncate(decodeAsText(buffer, relative))
}

/** The destination's current permission bits, or null when it does not exist. */
function currentMode(file: string): number | null {
  try {
    return fs.statSync(file).mode & 0o7777
  } catch {
    return null
  }
}

/**
 * Replace a file's contents atomically: write them in full to a temporary
 * sibling, then `rename` that over the destination.
 *
 * Truncate-then-write has no safe interruption point — a process killed, or a
 * disk full, partway through leaves the destination destroyed and no way to tell
 * that from a write that never started. Renaming instead means the destination
 * is never open for writing, so an interrupted replace leaves exactly two
 * observable states: the old file intact (the rename had not run) or the new
 * contents complete (it had). `rename(2)` within one directory is atomic, so
 * there is no third state, and a caller can therefore report honestly whether
 * the change committed.
 */
function writeFileAtomic(file: string, content: string): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  // A sibling of the destination for two reasons: the rename stays inside one
  // filesystem (a cross-device rename is a copy, which is not atomic), and the
  // dot prefix keeps a leftover from a killed process out of `list_files`.
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    // 'wx' so a colliding name is an error rather than a silent overwrite.
    const fd = fs.openSync(temp, 'wx')
    try {
      fs.writeFileSync(fd, content)
      // The contents are on disk before the file has this name, so nothing that
      // survives can be a half-written destination. This does not make the
      // *naming* durable: the directory entry the rename creates is not fsynced,
      // so a power cut can still lose the rename after an outcome was recorded
      // for it. Bounding a killed process is what this write owes; surviving a
      // power cut is reconciliation's job, and paying for a directory fsync on
      // every write is not warranted by anything measured here.
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    // The rename installs a different file object, so permissions do not carry
    // over on their own — without this an executable script rewritten by the
    // agent would come back non-executable.
    const mode = currentMode(file)
    if (mode !== null) fs.chmodSync(temp, mode)
    fs.renameSync(temp, file)
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // Best effort: the original failure is the one worth reporting.
    }
    throw err
  }
}

/**
 * The observable result of a successful write. Pure and exported so a caller
 * that must answer for a write it did NOT perform — a duplicate delivery of an
 * Effect already known to have committed — can reproduce the first delivery's
 * result exactly instead of paraphrasing it.
 */
export function describeWriteResult(relative: unknown, content: string): string {
  return `Wrote ${content.length} characters to ${relative}`
}

function writeFile(root: string, relative: unknown, content: string): string {
  const file = resolveInRoot(root, relative)
  writeFileAtomic(file, content)
  return describeWriteResult(relative, content)
}

export function editFile(root: string, relative: unknown, oldStr: string, newStr: string): string {
  const file = resolveInRoot(root, relative)

  if (oldStr === '') {
    writeFileAtomic(file, newStr)
    return `Created ${relative}`
  }

  // The SAME refusal `read_file` makes, through the same helper — refusing to
  // READ a binary while happily REWRITING one is an incoherent pair, and the
  // rewrite is the more destructive half. A non-fatal `'utf8'` decode turns
  // every non-UTF-8 byte into U+FFFD, and `writeFileAtomic` below then writes
  // that lossy decode back, so a model targeting a unique ASCII run inside a
  // binary (`%PDF-1.4`, an XMP fragment) silently destroys the file. That is
  // not hypothetical here: convert-at-bind deliberately archives the user's
  // ORIGINAL `.pdf`/`.docx` inside this model-reachable root, under
  // `.lore/sources/originals/`, and nothing ever removes it — so what a lossy
  // rewrite destroys may be the user's only copy.
  const content = decodeAsText(fs.readFileSync(file), relative)
  const first = content.indexOf(oldStr)
  if (first === -1) throw new Error(`Text to replace was not found in ${relative}`)
  if (content.indexOf(oldStr, first + oldStr.length) !== -1) {
    throw new Error(
      `Text to replace appears more than once in ${relative}. Include more surrounding context to make it unique.`,
    )
  }
  writeFileAtomic(file, content.replace(oldStr, newStr))
  return `Edited ${relative}`
}

function runCommand(
  root: string,
  command: unknown,
  timeoutMs = COMMAND_TIMEOUT_MS,
  signal?: AbortSignal,
  dependencies: Partial<ShellExecDependencies> = {},
): Promise<ShellToolResult> {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('A command is required.')
  }
  // Merged rather than substituted, so a test overriding one seam keeps the
  // production behavior of the others.
  const deps: ShellExecDependencies = { ...DEFAULT_SHELL_EXEC_DEPENDENCIES, ...dependencies }
  const timeout = timeoutMs > 0 ? timeoutMs : COMMAND_TIMEOUT_MS
  if (signal?.aborted) {
    return Promise.resolve({
      ok: false,
      output: 'Command cancelled before it started.',
      started: false,
      termination: {
        trigger: 'cancelled',
        requestedSignal: 'SIGTERM',
        escalatedToSigkill: false,
        observed: { kind: 'unconfirmed' },
      },
    })
  }
  return new Promise((resolve) => {
    let started = false
    let settled = false
    let termination: ShellTerminationEvidence | undefined
    // Deadlines are held as cancellers, not handles: `scheduleDeadline` may be
    // a test's queue rather than `setTimeout`, and only it knows how to undo.
    let cancelDeadline: (() => void) | undefined
    let cancelGrace: (() => void) | undefined
    let cancelObservationDeadline: (() => void) | undefined
    let groupExitPoll: NodeJS.Timeout | undefined
    let abortListenerAttached = false
    let leaderClosed = false
    let leaderObservation: ShellTerminationEvidence['observed'] = { kind: 'unconfirmed' }
    let stdout = ''
    let stderr = ''
    const maxBuffer = 8 * 1024 * 1024

    const processGroupStatus = (): 'exists' | 'absent' | 'unknown' => {
      if (!started || child.pid === undefined) return 'absent'
      try {
        process.kill(-child.pid, 0)
        return 'exists'
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ESRCH') return 'absent'
        if (code === 'EPERM') return 'exists'
        return 'unknown'
      }
    }

    const killGroup = (killSignal: NodeJS.Signals): boolean => {
      if (!started || child.pid === undefined) return false
      try {
        deps.killProcessGroup(child.pid, killSignal)
        return true
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ESRCH'
      }
    }

    const removeAbortListener = (): void => {
      if (!abortListenerAttached) return
      abortListenerAttached = false
      signal?.removeEventListener('abort', onAbort)
    }

    // One place that lets go of every timer, so a new deadline cannot be added
    // to the termination path and forgotten on one of the two settling routes.
    const clearTimers = (): void => {
      cancelDeadline?.()
      cancelGrace?.()
      cancelObservationDeadline?.()
      if (groupExitPoll) clearInterval(groupExitPoll)
    }

    const finishTermination = (): void => {
      if (settled || !termination) return
      settled = true
      clearTimers()
      removeAbortListener()
      termination.observed = leaderObservation
      const out = `${stdout}${stderr}`.trim()
      resolve({
        ok: false,
        output: truncate(
          `${termination.trigger === 'cancelled'
            ? 'Command cancelled.'
            : `Command timed out after ${Math.round(timeout / 1000)} seconds.`}\n${out}`,
        ),
        started,
        termination,
      })
    }

    const finishWhenGroupExits = (): void => {
      if (leaderClosed && processGroupStatus() === 'absent') {
        finishTermination()
        return
      }
      if (!groupExitPoll) {
        groupExitPoll = setInterval(() => {
          if (leaderClosed && processGroupStatus() === 'absent') finishTermination()
        }, 10)
      }
      if (!cancelObservationDeadline) {
        cancelObservationDeadline = deps.scheduleDeadline(finishTermination, TERMINATION_OBSERVATION_MS)
      }
    }

    const beginTermination = (trigger: ShellTerminationEvidence['trigger']): void => {
      if (termination) return
      termination = {
        trigger,
        requestedSignal: 'SIGTERM',
        escalatedToSigkill: false,
        observed: { kind: 'unconfirmed' },
      }
      killGroup('SIGTERM')
      cancelGrace = deps.scheduleDeadline(() => {
        if (!termination) return
        if (processGroupStatus() !== 'absent') {
          termination.escalatedToSigkill = true
          killGroup('SIGKILL')
        }
        finishWhenGroupExits()
      }, TERMINATION_GRACE_MS)
    }

    const onAbort = (): void => beginTermination('cancelled')
    const child = spawn(SHELL, ['-lc', command], { cwd: root, detached: true })
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBuffer) stdout += chunk.toString().slice(0, maxBuffer - stdout.length)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString().slice(0, maxBuffer - stderr.length)
    })
    child.once('spawn', () => {
      started = true
      signal?.addEventListener('abort', onAbort, { once: true })
      abortListenerAttached = signal !== undefined
      if (signal?.aborted) onAbort()
      cancelDeadline = deps.scheduleDeadline(() => beginTermination('primitive_timeout'), timeout)
    })
    child.once('error', (err) => {
      if (settled) return
      settled = true
      clearTimers()
      removeAbortListener()
      resolve({ ok: false, output: truncate(`${stdout}${stderr}`.trim() || err.message), started })
    })
    child.once('close', (code, observedSignal) => {
      if (settled) return
      leaderClosed = true
      cancelDeadline?.()
      removeAbortListener()
      if (termination) {
        if (code !== null) leaderObservation = { kind: 'exit', code }
        else if (observedSignal) leaderObservation = { kind: 'signal', signal: observedSignal }
        if (processGroupStatus() === 'absent') finishTermination()
        return
      }
      settled = true
      const out = `${stdout}${stderr}`.trim()
      if (code !== 0) {
        resolve({ ok: false, output: truncate(out || `Command exited with code ${code}.`), started })
        return
      }
      resolve({ ok: true, output: truncate(out || '(no output)'), started })
    })
  })
}

function deleteFile(root: string, relative: unknown): string {
  const file = resolveInRoot(root, relative)
  fs.rmSync(file, { recursive: true, force: false })
  return `Deleted ${relative}`
}

/**
 * Executor primitives — the host-agnostic fs/shell operations the server-side
 * actor loop drives over the executor WebSocket (see
 * `apps/desktop/src/main/dockExecutorClient.ts`). Each reuses the same confined
 * fs/shell logic as `executeTool` above. Filesystem operations return
 * `ToolResult`; shell execution additively returns `ShellToolResult`, whose
 * `started` marks the spawn boundary and whose optional `termination` records
 * observed cancellation/deadline Evidence. These remain host-agnostic rather
 * than protocol/transport types, so this file stays byte-syncable to the OSS
 * lore-workbench repo. A `PathDeniedError` propagates (rather than being swallowed
 * into `ok:false`) so the caller can distinguish confinement failures.
 */
async function runPrimitive(fn: () => string): Promise<ToolResult> {
  try {
    return { ok: true, output: fn() }
  } catch (err) {
    if (err instanceof PathDeniedError || err instanceof TargetNotFoundError) throw err
    return { ok: false, output: err instanceof Error ? err.message : String(err) }
  }
}

export function readFilePrimitive(root: string, relative: string): Promise<ToolResult> {
  return runPrimitive(() => readFile(root, relative))
}

export function writeFilePrimitive(root: string, relative: string, content: string): Promise<ToolResult> {
  return runPrimitive(() => writeFile(root, relative, content))
}

export function editFilePrimitive(
  root: string,
  relative: string,
  oldStr: string,
  newStr: string,
): Promise<ToolResult> {
  return runPrimitive(() => editFile(root, relative, oldStr, newStr))
}

export function readDirectoryPrimitive(root: string, relative: string): Promise<ToolResult> {
  return runPrimitive(() => listFiles(root, relative))
}

export function deletePrimitive(root: string, relative: string): Promise<ToolResult> {
  return runPrimitive(() => deleteFile(root, relative))
}

export function shellExecPrimitive(
  root: string,
  command: string,
  timeoutMs?: number,
  signal?: AbortSignal,
  dependencies?: Partial<ShellExecDependencies>,
): Promise<ShellToolResult> {
  return runCommand(root, command, timeoutMs ?? COMMAND_TIMEOUT_MS, signal, dependencies)
}

// File types the Artifact pane can render. HTML gets loaded directly, markdown
// and plain text are wrapped in a document view by the artifact protocol, and
// images are shown as-is. Anything else is a category error.
const ARTIFACT_EXTENSIONS = new Set([
  '.html', '.htm', '.md', '.markdown', '.txt', '.png', '.jpg', '.jpeg', '.svg', '.gif',
])

function showArtifact(root: string, relative: unknown, title: unknown): string {
  const file = resolveInRoot(root, relative)
  if (typeof title !== 'string' || !title.trim()) {
    throw new Error('A short title for the artifact is required.')
  }
  const ext = path.extname(file).toLowerCase()
  if (!ARTIFACT_EXTENSIONS.has(ext)) {
    throw new Error(
      `show_artifact only accepts HTML, markdown, text, or image files (.html, .htm, .md, .markdown, .txt, .png, .jpg, .jpeg, .svg, .gif); got "${relative}".`,
    )
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`File not found: ${relative}. Write the file first, then show it.`)
  }
  return `"${title.trim()}" is now visible to the user in the Artifact pane beside the conversation.`
}

// Descriptions are prescriptive about *when* to call each tool — recent models
// reach for tools conservatively, and trigger conditions measurably help.
export const TOOL_DEFINITIONS = [
  {
    name: 'list_files',
    description:
      'List the files and folders at a path inside the session folder. Call this first when you need to understand what is in the folder before reading or changing anything.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description:
      "Read a file's contents. Call this before editing a file, and whenever the answer depends on what a file actually contains rather than what you assume it contains.",
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path relative to the session folder.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact snippet of text in a file with new text. Prefer this over write_file for changing part of an existing file. The old text must appear exactly once — include surrounding lines to make it unique. Pass an empty old_text to create a new file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path relative to the session folder.' },
        old_text: {
          type: 'string',
          description: 'Exact text to replace. Empty string creates the file.',
        },
        new_text: { type: 'string', description: 'Text to put in its place.' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description:
      'Write a file, replacing it entirely if it exists. Use this for brand-new files or full rewrites; use edit_file to change part of an existing file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path relative to the session folder.' },
        content: { type: 'string', description: 'The full contents of the file.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command inside the session folder and return its output. Call this when the task needs something only a real command can do — running tests, installing packages, checking git status, building the project. Commands time out after 60 seconds.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'show_artifact',
    description:
      'Show a finished result to the user in the Artifact pane beside the conversation. Call this whenever you create or update something the user will read or look at: a document or plan (markdown), a dashboard, game, or page (self-contained HTML), or an image. The pane also refreshes automatically when you edit the shown file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'Path (relative to the session folder) of the HTML, markdown, text, or image file to display.',
        },
        title: {
          type: 'string',
          description: 'A short human title for the artifact, e.g. "Team dashboard".',
        },
        provenance: {
          type: 'object',
          properties: {
            inferences: { type: 'array', items: { type: 'string', maxLength: 280 }, maxItems: 8 },
            uncertainties: { type: 'array', items: { type: 'string', maxLength: 280 }, maxItems: 8 },
            derived_from: {
              type: 'array',
              items: {
                type: 'object',
                properties: { path: { type: 'string' }, finding: { type: 'string', maxLength: 160 } },
                required: ['path'],
                additionalProperties: false,
              },
              maxItems: 8,
            },
          },
          required: ['inferences', 'uncertainties', 'derived_from'],
          additionalProperties: false,
        },
      },
      required: ['path', 'title'],
      additionalProperties: false,
    },
  },
]

/** Human-readable one-liner for the activity chip in the UI. */
export function describeToolCall(name: string, input: ToolInput): string {
  switch (name) {
    case 'list_files':
      return `Looked in ${input.path && input.path !== '.' ? input.path : 'the folder'}`
    case 'read_file':
      return `Read ${path.basename(input.path || '')}`
    case 'edit_file':
      return input.old_text === ''
        ? `Created ${path.basename(input.path || '')}`
        : `Edited ${path.basename(input.path || '')}`
    case 'write_file':
      return `Wrote ${path.basename(input.path || '')}`
    case 'run_command':
      return `Ran a command`
    case 'show_artifact':
      return `Showed ${input.title || path.basename(input.path || '')}`
    default:
      return name
  }
}

/** Execute one tool call. Never throws — failures come back as `is_error` text. */
export async function executeTool(root: string, name: string, input: ToolInput): Promise<ToolResult> {
  try {
    switch (name) {
      case 'list_files':
        return { ok: true, output: listFiles(root, input.path) }
      case 'read_file':
        return { ok: true, output: readFile(root, input.path) }
      case 'edit_file':
        return { ok: true, output: editFile(root, input.path, input.old_text ?? '', input.new_text ?? '') }
      case 'write_file':
        return { ok: true, output: writeFile(root, input.path, input.content ?? '') }
      case 'run_command':
        return await runCommand(root, input.command)
      case 'show_artifact':
        return { ok: true, output: showArtifact(root, input.path, input.title) }
      default:
        return { ok: false, output: `Unknown tool: ${name}` }
    }
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) }
  }
}
