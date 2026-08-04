import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  MAX_OUTPUT,
  PathDeniedError,
  TERMINATION_GRACE_MS,
  TERMINATION_OBSERVATION_MS,
  TargetNotFoundError,
  deletePrimitive,
  describeToolCall,
  editFilePrimitive,
  executeTool,
  readDirectoryPrimitive,
  readFilePrimitive,
  resolveInRoot,
  shellExecPrimitive,
  truncate,
  writeFilePrimitive,
} from './tools'

function tmpRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lore-dock-tools-')))
}

// A real, committed, Flate-compressed single-page PDF (see __fixtures__/README.md
// for provenance). Its content streams are deflated, so their bytes are not
// valid UTF-8 — this is the exact shape that used to come back as a
// successful `read_file` full of mojibake before the fatal-decode change.
const REAL_PDF_FIXTURE = fileURLToPath(new URL('./__fixtures__/real-sample.pdf', import.meta.url))

async function waitForFile(file: string): Promise<string> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`File did not appear after 500 attempts: ${file}`)
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      process.kill(pid, 0)
      if (process.platform === 'linux') {
        const state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2]
        if (state === 'Z') return
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    } catch (err) {
      if (['ENOENT', 'ESRCH'].includes((err as NodeJS.ErrnoException).code ?? '')) return
      throw err
    }
  }
  throw new Error(`Process ${pid} did not exit after 1000 attempts`)
}

/**
 * A hand-driven `ShellExecDependencies.scheduleDeadline`.
 *
 * The termination path's two windows are two seconds each. A test that waits
 * them out is asserting that this machine takes longer than two seconds to
 * reap a process, which is a fact about the machine; advancing a virtual clock
 * asserts what the code does when they expire, which is a fact about the code.
 *
 * Only deadlines are virtual. The 10ms group-exit poll still runs on real
 * timers, because it waits for the OS to reap a real process — a condition, not
 * a duration — and the tests below await that condition rather than a delay.
 */
function virtualClock(): {
  scheduleDeadline(run: () => void, ms: number): () => void
  advance(ms: number): void
} {
  const pending = new Map<number, { at: number; run: () => void }>()
  let now = 0
  let nextId = 0
  return {
    scheduleDeadline(run, ms) {
      const id = nextId++
      pending.set(id, { at: now + ms, run })
      return () => pending.delete(id)
    },
    advance(ms) {
      now += ms
      // Snapshot first: a deadline that fires may schedule the next one, and
      // that successor is due later than the instant we just moved to.
      for (const [id, deadline] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (deadline.at <= now) {
          pending.delete(id)
          deadline.run()
        }
      }
    },
  }
}

function trackedSignal(): { controller: AbortController; removedListenerCount(): number } {
  const controller = new AbortController()
  const signal = controller.signal
  const removeEventListener = signal.removeEventListener.bind(signal)
  let removedListeners = 0
  signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
    if (args[0] === 'abort') removedListeners += 1
    return removeEventListener(...args)
  }) as AbortSignal['removeEventListener']
  return { controller, removedListenerCount: () => removedListeners }
}

// ---- path confinement (security-critical) ----------------------------------

test('resolveInRoot resolves a plain relative path', () => {
  const root = tmpRoot()
  assert.equal(resolveInRoot(root, 'a/b.txt'), path.join(root, 'a/b.txt'))
})

test('resolveInRoot rejects ..-traversal', () => {
  const root = tmpRoot()
  assert.throws(() => resolveInRoot(root, '../escape.txt'), /escapes the session folder/)
  assert.throws(() => resolveInRoot(root, 'a/../../escape.txt'), /escapes the session folder/)
})

test('resolveInRoot rejects an absolute path outside the root', () => {
  const root = tmpRoot()
  assert.throws(() => resolveInRoot(root, '/etc/passwd'), /escapes the session folder/)
})

test('resolveInRoot allows an absolute path inside the root', () => {
  const root = tmpRoot()
  const inside = path.join(root, 'ok.txt')
  assert.equal(resolveInRoot(root, inside), inside)
})

test('resolveInRoot rejects a symlink that points outside the root', () => {
  const root = tmpRoot()
  const outside = tmpRoot()
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret')
  fs.symlinkSync(outside, path.join(root, 'link'))
  assert.throws(() => resolveInRoot(root, 'link/secret.txt'), /escapes the session folder/)
})

test('resolveInRoot rejects a not-yet-existing path under an escaping symlink', () => {
  const root = tmpRoot()
  const outside = tmpRoot()
  fs.symlinkSync(outside, path.join(root, 'link'))
  assert.throws(() => resolveInRoot(root, 'link/new-file.txt'), /escapes the session folder/)
})

test('resolveInRoot rejects an empty or non-string path', () => {
  const root = tmpRoot()
  assert.throws(() => resolveInRoot(root, ''), /path is required/)
  assert.throws(() => resolveInRoot(root, null), /path is required/)
})

// ---- truncation -------------------------------------------------------------

test('truncate leaves short output alone', () => {
  assert.equal(truncate('hi'), 'hi')
})

test('truncate caps long output and says how much was dropped', () => {
  const out = truncate('x'.repeat(MAX_OUTPUT + 500))
  assert.ok(out.length < MAX_OUTPUT + 200)
  assert.ok(out.includes('500 more characters omitted'))
})

// ---- tool execution ---------------------------------------------------------

test('write_file then read_file round-trips', async () => {
  const root = tmpRoot()
  const w = await executeTool(root, 'write_file', { path: 'notes.txt', content: 'hello' })
  assert.equal(w.ok, true)
  const r = await executeTool(root, 'read_file', { path: 'notes.txt' })
  assert.deepEqual(r, { ok: true, output: 'hello' })
})

test('read_file round-trips multi-byte UTF-8: emoji, accented Latin, and CJK', async () => {
  const root = tmpRoot()
  const content = 'café 😀 日本語'
  fs.writeFileSync(path.join(root, 'multibyte.txt'), content, 'utf8')
  const r = await executeTool(root, 'read_file', { path: 'multibyte.txt' })
  assert.deepEqual(r, { ok: true, output: content })
})

test('read_file reads an empty file as an empty string', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'empty.txt'), '')
  const r = await executeTool(root, 'read_file', { path: 'empty.txt' })
  assert.deepEqual(r, { ok: true, output: '' })
})

test('read_file refuses a real PDF', async () => {
  const root = tmpRoot()
  const bytes = fs.readFileSync(REAL_PDF_FIXTURE)
  fs.writeFileSync(path.join(root, 'doc.pdf'), bytes)
  const r = await executeTool(root, 'read_file', { path: 'doc.pdf' })
  // This is the exact case measured failing before the fatal-decode change:
  // 12,778 chars of mojibake back with ok:true, 37.7% U+FFFD, and none of the
  // four known strings ("Q3 revenue was 4.2M.", "Owner: Dana.", "Due: Sept
  // 30.") recoverable. It must now fail loudly instead.
  assert.equal(r.ok, false)
  assert.match(r.output, /not valid UTF-8 text/)
  assert.doesNotMatch(r.output, /\.lore|lore\/sources/)
})

test('read_file refuses undecodable bytes shaped like a PDF magic header', async () => {
  const root = tmpRoot()
  // A synthetic fixture, not a real PDF: a PDF magic header followed by bytes
  // that are not valid UTF-8 on their own. This pins the decode-failure path
  // itself (deterministically, without depending on a real file's exact byte
  // layout) — coverage of an *actual* PDF is the fixture-backed test above.
  const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81])])
  fs.writeFileSync(path.join(root, 'doc.pdf'), bytes)
  const r = await executeTool(root, 'read_file', { path: 'doc.pdf' })
  assert.equal(r.ok, false)
  assert.match(r.output, /not valid UTF-8 text/)
  assert.doesNotMatch(r.output, /\.lore|lore\/sources/)
})

test('read_file refuses undecodable bytes shaped like a ZIP/.docx magic header', async () => {
  const root = tmpRoot()
  // Synthetic, same reasoning as the PDF-shaped case above: ZIP local-file-header
  // magic ("PK\x03\x04") followed by non-UTF-8 bytes. A .docx is a ZIP
  // container, so this pins the same undecodable-bytes shape without needing
  // a second committed binary fixture.
  const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0xff, 0xff, 0x80, 0x80, 0xc0, 0x00])])
  fs.writeFileSync(path.join(root, 'doc.docx'), bytes)
  const r = await executeTool(root, 'read_file', { path: 'doc.docx' })
  assert.equal(r.ok, false)
  assert.match(r.output, /not valid UTF-8 text/)
})

// Known gap, left deliberately: a PDF whose structure is plain ASCII and
// whose content streams are stored *uncompressed* (no FlateDecode) decodes
// cleanly as UTF-8, contains no NUL byte, and therefore still returns
// `ok: true` from read_file. That is acceptable, not a bug to patch here —
// such a file's decoded text genuinely *is* its text (the PDF operators and
// literal strings sit right there in the byte stream), and turning that into
// clean prose is the bind-time extraction pipeline's job (a later task in
// this plan), not read_file's. Do not "fix" this by adding an extension
// allowlist to read_file — that is explicitly out of scope; the only thing
// read_file is allowed to refuse on is undecodable content.

test('read_file refuses decodable text that contains a NUL byte', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'nul.txt'), Buffer.from('before\x00after', 'utf8'))
  const r = await executeTool(root, 'read_file', { path: 'nul.txt' })
  assert.equal(r.ok, false)
  assert.match(r.output, /NUL byte/)
  assert.doesNotMatch(r.output, /\.lore|lore\/sources/)
})

test('read_file truncation does not split an astral character at the MAX_OUTPUT boundary', async () => {
  // Not a decode-order test: readFile always decodes the whole buffer up
  // front (both before and after Task 2's fatal-decode change did this the
  // same way), so no input can distinguish "decode then truncate" from
  // "truncate then decode" here — the buffer is never truncated as bytes.
  // What this test actually pins is a real, separate boundary bug: `truncate`
  // slices the decoded JS string by UTF-16 code unit, and an astral character
  // (this 😀 emoji, or a rare CJK-extension codepoint) is stored as a
  // surrogate *pair* — two code units. Placing one at the exact cut point
  // used to leave a lone surrogate in the output, which is invalid UTF-16 and
  // silently becomes U+FFFD the moment the string is encoded to UTF-8 (as it
  // is for the JSON/IPC transport this result travels over) — the same
  // mojibake failure mode this task exists to catch, just introduced one step
  // later, inside truncate() rather than inside decode.
  const root = tmpRoot()
  const content = `${'a'.repeat(MAX_OUTPUT - 1)}😀${'b'.repeat(50)}`
  fs.writeFileSync(path.join(root, 'big.txt'), content, 'utf8')
  const r = await executeTool(root, 'read_file', { path: 'big.txt' })
  assert.equal(r.ok, true)
  const [prefix] = r.output.split('\n\n[...')
  // The character is either whole or entirely absent — never split.
  assert.ok(prefix.endsWith('😀') || !prefix.includes('\ud83d'), 'the astral character must not be split')
  // Encoding the prefix to UTF-8 must never introduce a replacement
  // character: a lone surrogate would silently turn into one here.
  const encoded = Buffer.from(prefix, 'utf8')
  assert.ok(!encoded.includes(Buffer.from('�', 'utf8')), 'truncation must not introduce U+FFFD')
})

test('edit_file refuses a real PDF and leaves it byte-identical', async () => {
  const root = tmpRoot()
  const bytes = fs.readFileSync(REAL_PDF_FIXTURE)
  // Where a real original actually lands: convert-at-bind archives the user's
  // picked `.pdf`/`.docx` under `.lore/sources/originals/` inside this very
  // root, permanently. That is the file this refusal protects.
  const target = path.join(root, '.lore', 'sources', 'originals', 'doc.pdf')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, bytes)

  const r = await executeTool(root, 'edit_file', {
    path: '.lore/sources/originals/doc.pdf',
    old_text: '%PDF-1.',
    new_text: '%PDF-2.',
  })

  assert.equal(r.ok, false)
  assert.match(r.output, /not valid UTF-8 text/)
  // The property that matters is non-destruction, not the failure: a lossy
  // 'utf8' read + write-back succeeds and rewrites every non-UTF-8 byte to
  // U+FFFD, so assert the BYTES, not just ok:false.
  assert.deepEqual(fs.readFileSync(target), bytes, 'a refused edit must not rewrite a single byte')
})

test('edit_file refuses a binary file whose targeted snippet is unique ASCII, leaving it byte-identical', async () => {
  const root = tmpRoot()
  // Synthetic and deterministic: a unique ASCII run the model could plausibly
  // target, surrounded by bytes that are not valid UTF-8. The old behavior
  // found the snippet, replaced it, and wrote back a decode in which all six
  // surrounding bytes had become U+FFFD.
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xfe, 0x80]),
    Buffer.from('<xmp:CreatorTool>Acrobat</xmp:CreatorTool>'),
    Buffer.from([0x81, 0xc0, 0x00]),
  ])
  const target = path.join(root, 'doc.pdf')
  fs.writeFileSync(target, bytes)

  const r = await executeTool(root, 'edit_file', {
    path: 'doc.pdf',
    old_text: '<xmp:CreatorTool>Acrobat</xmp:CreatorTool>',
    new_text: '<xmp:CreatorTool>Lore</xmp:CreatorTool>',
  })

  assert.equal(r.ok, false)
  assert.match(r.output, /not valid UTF-8 text/)
  assert.match(r.output, /open it with an appropriate application|re-save it as UTF-8/, 'the refusal says what to do instead')
  assert.deepEqual(fs.readFileSync(target), bytes, 'a refused edit must not rewrite a single byte')
})

test('edit_file refuses a decodable file containing a NUL byte, leaving it byte-identical', async () => {
  const root = tmpRoot()
  // The other half of `decodeAsText`: bytes that decode cleanly as UTF-8 but
  // are not text. `read_file` already refuses this; `edit_file` must agree.
  const bytes = Buffer.from('header\x00PAYLOAD\x00trailer', 'utf8')
  const target = path.join(root, 'blob.bin')
  fs.writeFileSync(target, bytes)

  const r = await executeTool(root, 'edit_file', { path: 'blob.bin', old_text: 'PAYLOAD', new_text: 'X' })

  assert.equal(r.ok, false)
  assert.match(r.output, /NUL byte/)
  assert.deepEqual(fs.readFileSync(target), bytes)
})

test('list_files shows folders with a trailing slash', async () => {
  const root = tmpRoot()
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'a.txt'), '')
  const r = await executeTool(root, 'list_files', {})
  assert.equal(r.output, 'a.txt\nsrc/')
})

test('list_files reports an empty folder', async () => {
  const r = await executeTool(tmpRoot(), 'list_files', {})
  assert.equal(r.output, '(empty folder)')
})

test('edit_file replaces a unique snippet', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'f.txt'), 'one two three')
  const r = await executeTool(root, 'edit_file', {
    path: 'f.txt',
    old_text: 'two',
    new_text: 'TWO',
  })
  assert.equal(r.ok, true)
  assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'one TWO three')
})

test('edit_file refuses an ambiguous snippet', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'f.txt'), 'dup dup')
  const r = await executeTool(root, 'edit_file', { path: 'f.txt', old_text: 'dup', new_text: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.output, /more than once/)
})

test('edit_file reports a missing snippet rather than silently doing nothing', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'f.txt'), 'abc')
  const r = await executeTool(root, 'edit_file', { path: 'f.txt', old_text: 'zzz', new_text: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.output, /was not found/)
})

test('edit_file with empty old_text creates the file', async () => {
  const root = tmpRoot()
  const r = await executeTool(root, 'edit_file', {
    path: 'sub/new.txt',
    old_text: '',
    new_text: 'fresh',
  })
  assert.equal(r.ok, true)
  assert.equal(fs.readFileSync(path.join(root, 'sub/new.txt'), 'utf8'), 'fresh')
})

test('a tool error comes back as ok:false, never as a throw', async () => {
  const root = tmpRoot()
  const r = await executeTool(root, 'read_file', { path: '../../etc/passwd' })
  assert.equal(r.ok, false)
  assert.match(r.output, /escapes the session folder/)
})

test('an unknown tool name is reported, not thrown', async () => {
  const r = await executeTool(tmpRoot(), 'launch_missiles', {})
  assert.equal(r.ok, false)
  assert.match(r.output, /Unknown tool/)
})

test('run_command captures stdout and runs inside the root', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'marker.txt'), '')
  const r = await executeTool(root, 'run_command', { command: 'ls' })
  assert.equal(r.ok, true)
  assert.match(r.output, /marker\.txt/)
})

test('run_command reports a failing command without throwing', async () => {
  const r = await executeTool(tmpRoot(), 'run_command', { command: 'exit 3' })
  assert.equal(r.ok, false)
})

// ---- executor primitives ----------------------------------------------------

test('readFilePrimitive reads a file inside the root', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'a.txt'), 'contents')
  const r = await readFilePrimitive(root, 'a.txt')
  assert.deepEqual(r, { ok: true, output: 'contents' })
})

test('writeFilePrimitive writes a file inside the root', async () => {
  const root = tmpRoot()
  const r = await writeFilePrimitive(root, 'sub/note.txt', 'hi there')
  assert.deepEqual(r, { ok: true, output: 'Wrote 8 characters to sub/note.txt' })
  assert.equal(fs.readFileSync(path.join(root, 'sub/note.txt'), 'utf8'), 'hi there')
})

// ---- atomic replace --------------------------------------------------------
//
// The destination is written by renaming a completed temporary file over it, so
// the file the model asked for is never open for writing. That is what bounds a
// mid-write crash to two states: the process dies before the rename and the old
// file is untouched, or after it and the new content is complete — `rename(2)`
// within one directory is atomic, so there is no third state to observe. The
// tests below pin both halves of that mechanism, which is why they never need to
// kill a process to know what a killed process would leave behind.

test('writeFilePrimitive replaces the destination instead of truncating it in place', async () => {
  const root = tmpRoot()
  const file = path.join(root, 'note.txt')
  fs.writeFileSync(file, 'the old content')
  const before = fs.statSync(file).ino
  // A second name for the old file object: it keeps resolving to the old bytes
  // for as long as they exist, exactly as a concurrent reader (or a crashed
  // write's leftovers) would.
  const previous = path.join(root, 'previous.link')
  fs.linkSync(file, previous)

  const result = await writeFilePrimitive(root, 'note.txt', 'the new content, longer')
  assert.equal(result.ok, true)
  assert.equal(fs.readFileSync(file, 'utf8'), 'the new content, longer')
  assert.equal(
    fs.readFileSync(previous, 'utf8'),
    'the old content',
    'the old file object must be replaced, never written through',
  )
  assert.notEqual(fs.statSync(file).ino, before, 'the destination must be a different file object')
})

test('writeFilePrimitive leaves no temporary file behind on success', async () => {
  const root = tmpRoot()
  await writeFilePrimitive(root, 'sub/note.txt', 'hi')
  assert.deepEqual(fs.readdirSync(root), ['sub'])
  assert.deepEqual(fs.readdirSync(path.join(root, 'sub')), ['note.txt'])
})

test('writeFilePrimitive removes its temporary file and leaves the destination alone when the replace fails', async () => {
  const root = tmpRoot()
  // A directory cannot be replaced by a file, so the rename fails after the
  // temporary file has been fully written — the one window a crash could expose.
  fs.mkdirSync(path.join(root, 'blocked'))
  fs.writeFileSync(path.join(root, 'blocked/kept.txt'), 'untouched')

  const result = await writeFilePrimitive(root, 'blocked', 'replacement')
  assert.equal(result.ok, false)
  assert.deepEqual(fs.readdirSync(root), ['blocked'], 'the temporary file must be cleaned up')
  assert.deepEqual(fs.readdirSync(path.join(root, 'blocked')), ['kept.txt'])
  assert.equal(fs.readFileSync(path.join(root, 'blocked/kept.txt'), 'utf8'), 'untouched')
})

test('writeFilePrimitive keeps the permissions the destination already had', async () => {
  const root = tmpRoot()
  const file = path.join(root, 'run.sh')
  fs.writeFileSync(file, 'echo old')
  fs.chmodSync(file, 0o755)

  await writeFilePrimitive(root, 'run.sh', 'echo new')
  assert.equal(fs.statSync(file).mode & 0o777, 0o755)
})

test('readDirectoryPrimitive lists entries inside the root', async () => {
  const root = tmpRoot()
  fs.mkdirSync(path.join(root, 'dir'))
  fs.writeFileSync(path.join(root, 'x.txt'), '')
  const r = await readDirectoryPrimitive(root, '.')
  assert.equal(r.output, 'dir/\nx.txt')
})

test('deletePrimitive removes a file inside the root', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'gone.txt'), '')
  const r = await deletePrimitive(root, 'gone.txt')
  assert.equal(r.ok, true)
  assert.equal(fs.existsSync(path.join(root, 'gone.txt')), false)
})

test('fs primitives throw PathDeniedError on ..-escape (not ok:false)', async () => {
  const root = tmpRoot()
  await assert.rejects(() => readFilePrimitive(root, '../escape.txt'), PathDeniedError)
  await assert.rejects(() => writeFilePrimitive(root, '../escape.txt', 'x'), PathDeniedError)
  await assert.rejects(() => deletePrimitive(root, '../escape.txt'), PathDeniedError)
})

test('readFilePrimitive preserves a missing target as a typed error', async () => {
  await assert.rejects(() => readFilePrimitive(tmpRoot(), 'missing.txt'), TargetNotFoundError)
})

test('shellExecPrimitive runs a command and captures stdout', async () => {
  const r = await shellExecPrimitive(tmpRoot(), 'echo hi')
  assert.equal(r.ok, true)
  assert.match(r.output, /hi/)
})

test('editFilePrimitive performs a surgical edit — every byte outside the replaced span is unchanged', async () => {
  const root = tmpRoot()
  const file = path.join(root, 'f.txt')
  fs.writeFileSync(file, 'one two three')
  const previous = path.join(root, 'previous.link')
  fs.linkSync(file, previous)
  const r = await editFilePrimitive(root, 'f.txt', 'two', 'TWO')
  assert.equal(r.ok, true)
  assert.equal(fs.readFileSync(file, 'utf8'), 'one TWO three')
  assert.equal(fs.readFileSync(previous, 'utf8'), 'one two three', 'edit must atomically replace the old file object')
  assert.notEqual(fs.statSync(file).ino, fs.statSync(previous).ino)
})

test('editFilePrimitive refuses an ambiguous old_text and leaves the file untouched', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'f.txt'), 'dup dup')
  const r = await editFilePrimitive(root, 'f.txt', 'dup', 'x')
  assert.equal(r.ok, false)
  assert.match(r.output, /more than once/)
  assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'dup dup')
})

test('editFilePrimitive refuses old_text absent from the file and leaves it untouched', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'f.txt'), 'abc')
  const r = await editFilePrimitive(root, 'f.txt', 'zzz', 'x')
  assert.equal(r.ok, false)
  assert.match(r.output, /was not found/)
  assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'abc')
})

test('editFilePrimitive with empty old_text creates the file', async () => {
  const root = tmpRoot()
  const r = await editFilePrimitive(root, 'sub/new.txt', '', 'fresh')
  assert.equal(r.ok, true)
  assert.equal(fs.readFileSync(path.join(root, 'sub/new.txt'), 'utf8'), 'fresh')
})

test('editFilePrimitive with empty old_text atomically replaces an existing file', async () => {
  const root = tmpRoot()
  const file = path.join(root, 'existing.txt')
  fs.writeFileSync(file, 'old')
  const previous = path.join(root, 'previous.link')
  fs.linkSync(file, previous)
  const r = await editFilePrimitive(root, 'existing.txt', '', 'fresh')
  assert.deepEqual(r, { ok: true, output: 'Created existing.txt' })
  assert.equal(fs.readFileSync(file, 'utf8'), 'fresh')
  assert.equal(fs.readFileSync(previous, 'utf8'), 'old')
})

test('shellExecPrimitive distinguishes startup failure from a started non-zero exit', async () => {
  const startup = await shellExecPrimitive(path.join(tmpRoot(), 'missing'), 'echo never')
  assert.equal(startup.ok, false)
  assert.equal(startup.started, false)
  const exited = await shellExecPrimitive(tmpRoot(), 'exit 7')
  assert.equal(exited.ok, false)
  assert.equal(exited.started, true)
})

test('shellExecPrimitive does not start a child for a pre-aborted cancellation', async () => {
  const root = tmpRoot()
  const controller = new AbortController()
  controller.abort()

  const result = await shellExecPrimitive(root, 'touch should-not-exist', undefined, controller.signal)

  assert.deepEqual(result, {
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
  assert.equal(fs.existsSync(path.join(root, 'should-not-exist')), false)
})

// Cancellation always arms grace, so this asserted `escalatedToSigkill: false`
// against a real two-second timer -- i.e. that this machine reaps a two-process
// group within two seconds. Same coupling as the escalation test below, weaker
// odds. With the clock never advanced, grace cannot fire at all, so what settles
// this is the group exiting: the condition the assertion is actually about.
test('shellExecPrimitive cancels a cooperative process group and its descendant', async () => {
  const root = tmpRoot()
  const controller = new AbortController()
  const clock = virtualClock()
  const resultPromise = shellExecPrimitive(
    root,
    `sleep 60 & echo $! > descendant.pid; echo ready > ready; wait`,
    undefined,
    controller.signal,
    { scheduleDeadline: clock.scheduleDeadline },
  )
  await waitForFile(path.join(root, 'ready'))
  const descendantPid = Number(await waitForFile(path.join(root, 'descendant.pid')))

  controller.abort()
  const result = await resultPromise
  await waitForProcessExit(descendantPid)

  assert.equal(result.ok, false)
  assert.equal(result.started, true)
  assert.deepEqual(result.termination, {
    trigger: 'cancelled',
    requestedSignal: 'SIGTERM',
    escalatedToSigkill: false,
    observed: { kind: 'signal', signal: 'SIGTERM' },
  })
})

test('shellExecPrimitive escalates an uncooperative process group after grace', async () => {
  const root = tmpRoot()
  const controller = new AbortController()
  const clock = virtualClock()
  const signals: NodeJS.Signals[] = []
  // "Uncooperative" is expressed through the kill seam, not through a shell
  // trap. `trap '' TERM` is not portable for this purpose: POSIX preserves
  // SIG_IGN across exec, so under /bin/sh a backgrounded `sleep` inherits the
  // ignored TERM and the group outlives SIGTERM — but zsh, which is SHELL on
  // the product's own platform, resets the disposition in the forked job, so
  // the descendant dies on SIGTERM and the leader's `wait` returns. The same
  // fixture therefore escalated on Linux and never escalated on macOS.
  //
  // Swallowing SIGTERM at the seam makes the group uncooperative on every
  // shell, while SIGKILL is still delivered for real — so the SIGKILL evidence
  // this asserts on is observed from a process that actually died of it.
  const resultPromise = shellExecPrimitive(root, 'echo ready > ready; exec sleep 60', undefined, controller.signal, {
    scheduleDeadline: clock.scheduleDeadline,
    killProcessGroup(pid, signal) {
      signals.push(signal)
      if (signal !== 'SIGTERM') process.kill(-pid, signal)
    },
  })
  await waitForFile(path.join(root, 'ready'))

  controller.abort()
  clock.advance(TERMINATION_GRACE_MS)
  const result = await resultPromise

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'grace must escalate exactly once')
  assert.equal(result.started, true)
  assert.deepEqual(result.termination, {
    trigger: 'cancelled',
    requestedSignal: 'SIGTERM',
    escalatedToSigkill: true,
    observed: { kind: 'signal', signal: 'SIGKILL' },
  })
})

test('shellExecPrimitive contains SIGTERM delivery failure and still performs bounded escalation', async () => {
  const root = tmpRoot()
  const tracked = trackedSignal()
  const clock = virtualClock()
  const signals: NodeJS.Signals[] = []
  const resultPromise = shellExecPrimitive(root, 'echo $$ > leader.pid; echo ready > ready; exec sleep 60', undefined, tracked.controller.signal, {
    scheduleDeadline: clock.scheduleDeadline,
    killProcessGroup(pid, signal) {
      signals.push(signal)
      if (signal === 'SIGTERM') throw Object.assign(new Error('term denied'), { code: 'EPERM' })
      process.kill(-pid, signal)
    },
  })
  await waitForFile(path.join(root, 'ready'))
  const leaderPid = Number(await waitForFile(path.join(root, 'leader.pid')))

  assert.doesNotThrow(() => tracked.controller.abort())
  clock.advance(TERMINATION_GRACE_MS)
  const result = await resultPromise
  await waitForProcessExit(leaderPid)

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(tracked.removedListenerCount(), 1)
  assert.deepEqual(result.termination, {
    trigger: 'cancelled',
    requestedSignal: 'SIGTERM',
    escalatedToSigkill: true,
    observed: { kind: 'signal', signal: 'SIGKILL' },
  })
})

test('shellExecPrimitive settles unconfirmed and releases ownership when SIGKILL delivery also fails', async () => {
  const root = tmpRoot()
  const tracked = trackedSignal()
  const clock = virtualClock()
  const signals: NodeJS.Signals[] = []
  let leaderPid = 0
  try {
    const resultPromise = shellExecPrimitive(root, 'echo $$ > leader.pid; echo ready > ready; exec sleep 60', undefined, tracked.controller.signal, {
      scheduleDeadline: clock.scheduleDeadline,
      killProcessGroup(_pid, signal) {
        signals.push(signal)
        throw Object.assign(new Error(`${signal} denied`), { code: 'EPERM' })
      },
    })
    await waitForFile(path.join(root, 'ready'))
    leaderPid = Number(await waitForFile(path.join(root, 'leader.pid')))

    assert.doesNotThrow(() => tracked.controller.abort())
    // Neither signal lands, so the group never exits and only the observation
    // window can settle this — the one path where the deadline itself, rather
    // than a process dying, is what the assertion is about.
    clock.advance(TERMINATION_GRACE_MS)
    clock.advance(TERMINATION_OBSERVATION_MS)
    const result = await resultPromise

    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
    assert.equal(tracked.removedListenerCount(), 1)
    assert.deepEqual(result.termination, {
      trigger: 'cancelled',
      requestedSignal: 'SIGTERM',
      escalatedToSigkill: true,
      observed: { kind: 'unconfirmed' },
    })
  } finally {
    if (leaderPid > 0) {
      try { process.kill(-leaderPid, 'SIGKILL') } catch {}
      await waitForProcessExit(leaderPid)
    }
  }
})

// The premise is the name: the leader exits *before* the uncooperative
// descendant, so the evidence must keep the leader's own `exit 0` even though
// the group still needed SIGKILL.
//
// This test used to leave grace on the real two-second timer, on the reasoning
// that the ordering it turns on was something a virtual clock could move but
// not observe. That was the defect. Nothing established the premise -- it left
// node's 2s `setTimeout` racing the OS scheduling zsh to run `trap 'exit 0'
// TERM`, two independent real clocks. When the leader lost, SIGKILL reached it
// before its trap did, and `observed` came back `{kind: 'signal', signal:
// 'SIGKILL'}`: a `deepEqual` failure that says nothing about this file and
// everything about how busy the machine was. It blocked a push once and passed
// on retry, which is the shape that teaches people to re-run.
//
// The ordering is observable after all, because the leader's exit is a
// *condition* and not a duration: wait for its pid to leave the process table
// and the premise is established rather than hoped for. Only then does
// advancing the clock escalate -- and the SIGKILL that escalation sends is
// still delivered for real, to a descendant that is still ignoring TERM.
test('shellExecPrimitive retains ownership when the shell exits before an uncooperative descendant', async () => {
  const root = tmpRoot()
  const controller = new AbortController()
  const clock = virtualClock()
  const resultPromise = shellExecPrimitive(
    root,
    `trap 'exit 0' TERM; (trap '' TERM; exec sleep 60) </dev/null >/dev/null 2>&1 & echo $! > descendant.pid; echo $$ > leader.pid; echo ready > ready; wait`,
    undefined,
    controller.signal,
    { scheduleDeadline: clock.scheduleDeadline },
  )
  await waitForFile(path.join(root, 'ready'))
  const descendantPid = Number(await waitForFile(path.join(root, 'descendant.pid')))
  const leaderPid = Number(await waitForFile(path.join(root, 'leader.pid')))

  controller.abort()
  // The premise, established: the leader has run its trap and gone, and the
  // descendant has ignored the same SIGTERM and stayed. Asserting the second
  // half names the failure if a shell ever stops preserving SIG_IGN across
  // exec, instead of leaving it to surface as a confusing evidence mismatch.
  await waitForProcessExit(leaderPid)
  assert.doesNotThrow(
    () => process.kill(descendantPid, 0),
    'the descendant must outlive SIGTERM for this fixture to mean anything',
  )

  clock.advance(TERMINATION_GRACE_MS)
  const result = await resultPromise
  await waitForProcessExit(descendantPid)

  assert.equal(result.started, true)
  assert.deepEqual(result.termination, {
    trigger: 'cancelled',
    requestedSignal: 'SIGTERM',
    escalatedToSigkill: true,
    observed: { kind: 'exit', code: 0 },
  })
})

/**
 * Replaces the only thing the real-timer version above was buying.
 *
 * Its comment argued that virtualizing grace everywhere would let a mis-wired
 * grace default pass unnoticed, since every other escalation test supplies its
 * own scheduler. True, but two seconds of wall clock is a poor proxy for it:
 * the wiring is what matters, so assert the wiring. This records the `ms` each
 * deadline is scheduled with and pins all three to the constants the module
 * exports -- which catches a swapped grace/observation pair or a hardcoded
 * literal directly, and in milliseconds of virtual time.
 */
test('shellExecPrimitive schedules every deadline from the exported windows', async () => {
  const root = tmpRoot()
  const controller = new AbortController()
  const clock = virtualClock()
  const scheduled: number[] = []
  const resultPromise = shellExecPrimitive(root, 'echo ready > ready; exec sleep 60', 30_000, controller.signal, {
    scheduleDeadline(run, ms) {
      scheduled.push(ms)
      return clock.scheduleDeadline(run, ms)
    },
    // Uncooperative at the seam, so grace has to escalate and therefore has to
    // open the observation window. SIGKILL still lands for real.
    killProcessGroup(pid, signal) {
      if (signal !== 'SIGTERM') process.kill(-pid, signal)
    },
  })
  await waitForFile(path.join(root, 'ready'))

  assert.deepEqual(scheduled, [30_000], "the command's own timeout is armed on spawn, from the caller's value")

  controller.abort()
  assert.deepEqual(scheduled, [30_000, TERMINATION_GRACE_MS], 'cancellation arms grace')

  clock.advance(TERMINATION_GRACE_MS)
  assert.deepEqual(
    scheduled,
    [30_000, TERMINATION_GRACE_MS, TERMINATION_OBSERVATION_MS],
    'escalation opens the observation window',
  )

  // Settled by the real 10ms group-exit poll, which waits on the condition that
  // the group is gone rather than on any duration.
  const result = await resultPromise
  assert.equal(result.termination?.escalatedToSigkill, true)
})

test('shellExecPrimitive records its own deadline separately from cancellation', async () => {
  const root = tmpRoot()
  const clock = virtualClock()
  // Was a real 20ms deadline on a real `/bin/zsh -lc`, which costs ~30ms to
  // start on an idle machine: the deadline could fire before the shell had even
  // reached `sleep`. It happened to assert the same evidence either way, so it
  // never failed -- but it was measuring zsh's startup, not this trigger.
  const resultPromise = shellExecPrimitive(root, 'echo ready > ready; exec sleep 60', 30_000, undefined, {
    scheduleDeadline: clock.scheduleDeadline,
  })
  await waitForFile(path.join(root, 'ready'))

  clock.advance(30_000)
  const result = await resultPromise

  assert.equal(result.started, true)
  assert.equal(result.termination?.trigger, 'primitive_timeout')
  assert.equal(result.termination?.escalatedToSigkill, false)
  assert.deepEqual(result.termination?.observed, { kind: 'signal', signal: 'SIGTERM' })
})

// The one the guard in `src/main/wallClockAssertions.guard.test.ts` was written
// for, in the exact shape its docstring describes -- a real deadline racing work
// that has to actually happen before the assertion can hold. It escaped because
// the deadline was positional (`, 500)`) rather than a `timeoutMs:` property, so
// the regex never saw it. 500ms is a comfortable 13x zsh's idle startup and an
// unknown multiple of its worst case under a saturated suite; if the shell lost,
// `printf` never ran and the truncation assertion had nothing to bite on.
//
// Now the bytes are produced first -- the marker file is written *after* the
// `printf`, so reaching it proves the output exists -- and the deadline fires
// only once they do.
test('shellExecPrimitive bounds the complete timeout response', async () => {
  const root = tmpRoot()
  const clock = virtualClock()
  const command = `printf '%0${MAX_OUTPUT + 5000}d' 0; echo ready > ready; exec sleep 60`

  const resultPromise = shellExecPrimitive(root, command, 30_000, undefined, {
    scheduleDeadline: clock.scheduleDeadline,
  })
  await waitForFile(path.join(root, 'ready'))

  clock.advance(30_000)
  const result = await resultPromise

  assert.equal(result.ok, false)
  assert.equal(result.started, true)
  assert.match(result.output, /^Command timed out/)
  assert.ok(result.output.length < MAX_OUTPUT + 200, `timeout response was ${result.output.length} characters`)
  assert.match(result.output, /more characters omitted/)
})

test('editFilePrimitive throws PathDeniedError on ..-escape (not ok:false)', async () => {
  const root = tmpRoot()
  await assert.rejects(() => editFilePrimitive(root, '../escape.txt', '', 'x'), PathDeniedError)
})

// ---- activity labels --------------------------------------------------------

test('describeToolCall produces human labels, never jargon', () => {
  assert.equal(describeToolCall('read_file', { path: 'src/a.js' }), 'Read a.js')
  assert.equal(describeToolCall('write_file', { path: 'x/b.txt' }), 'Wrote b.txt')
  assert.equal(describeToolCall('edit_file', { path: 'c.js', old_text: 'a' }), 'Edited c.js')
  assert.equal(describeToolCall('edit_file', { path: 'c.js', old_text: '' }), 'Created c.js')
  assert.equal(describeToolCall('run_command', { command: 'ls' }), 'Ran a command')
  assert.equal(describeToolCall('list_files', {}), 'Looked in the folder')
  assert.equal(describeToolCall('list_files', { path: 'src' }), 'Looked in src')
})

// ---- show_artifact -----------------------------------------------------------

test('show_artifact accepts an existing html file', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'dash.html'), '<h1>hi</h1>')
  const r = await executeTool(root, 'show_artifact', { path: 'dash.html', title: 'Team dashboard' })
  assert.equal(r.ok, true)
  assert.match(r.output, /Team dashboard/)
})

test('show_artifact rejects a disallowed extension', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'archive.zip'), 'x')
  const r = await executeTool(root, 'show_artifact', { path: 'archive.zip', title: 'Archive' })
  assert.equal(r.ok, false)
  assert.match(r.output, /HTML, markdown, text, or image/)
})

test('show_artifact rejects a missing file', async () => {
  const root = tmpRoot()
  const r = await executeTool(root, 'show_artifact', { path: 'ghost.html', title: 'Ghost' })
  assert.equal(r.ok, false)
  assert.match(r.output, /not found/i)
})

test('show_artifact rejects a path outside the root', async () => {
  const root = tmpRoot()
  const r = await executeTool(root, 'show_artifact', { path: '../escape.html', title: 'Nope' })
  assert.equal(r.ok, false)
  assert.match(r.output, /escapes the session folder/)
})
