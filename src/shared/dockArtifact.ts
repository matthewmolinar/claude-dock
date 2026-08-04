/**
 * Pure artifact-pane domain logic, ported from claude-dock
 * `src/shared/artifact.js`. Renderer-safe: no Node imports.
 */

export interface SlotArtifact {
  path: string
  title: string
  version?: number
}

// Bounds dock-state.json; well above the 20-entry prompt manifest.
export const MAX_SLOT_OUTPUTS = 200

export interface SlotOutput {
  /** Normalized, relative to the Session folder. */
  path: string
  title: string
  /** Wire format: `sha256:<64 lowercase hex>`; null means hashing failed. */
  contentHash: string | null
  versionOrdinal: number
  demoted: boolean
  /** Durable intent awaiting acknowledgement from the mirrored Output. */
  demotionPending: boolean
  updatedAtMs: number
  mirrored: boolean
  /** Successful show_artifact call that established this Output, when known. */
  toolCallId?: string
}

export type ArtifactAction =
  | { type: 'show'; path: string; title: string; toolCallId?: string }
  | { type: 'reload' }

function capOutputs(outputs: SlotOutput[], protectedIndex: number): SlotOutput[] {
  if (outputs.length <= MAX_SLOT_OUTPUTS) return outputs
  const keep = new Set(
    outputs
      .map((output, index) => ({ index, updatedAtMs: output.updatedAtMs }))
      .filter(({ index }) => index !== protectedIndex)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.index - b.index)
      .slice(0, MAX_SLOT_OUTPUTS - 1)
      .map(({ index }) => index),
  )
  keep.add(protectedIndex)
  return outputs.filter((_, index) => keep.has(index))
}

/** Minimal path.normalize (renderer-safe): resolves '.', '..', '//'. */
function normalize(p: string): string {
  const abs = p.startsWith('/')
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop()
      else if (!abs) parts.push('..')
      continue
    }
    parts.push(seg)
  }
  return (abs ? '/' : '') + parts.join('/') || '.'
}

export function recordOutput(
  outputs: SlotOutput[],
  entry: { path: string; title: string; contentHash: string | null; atMs: number; toolCallId?: string },
): {
  outputs: SlotOutput[]
  changed: 'created' | 'revised' | 'renamed' | 'unchanged'
} {
  const path = normalize(entry.path)
  const existingIndex = outputs.findIndex((output) => normalize(output.path) === path)

  if (existingIndex === -1) {
    const created: SlotOutput = {
      path,
      title: entry.title,
      contentHash: entry.contentHash,
      versionOrdinal: 1,
      demoted: false,
      demotionPending: false,
      updatedAtMs: entry.atMs,
      mirrored: false,
      ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
    }
    const next = [...outputs, created]
    return {
      outputs: capOutputs(next, next.length - 1),
      changed: 'created',
    }
  }

  const existing = outputs[existingIndex]!
  const revised = entry.contentHash === null || existing.contentHash !== entry.contentHash
  const renamed = !revised && existing.title !== entry.title
  const reshown = !revised && !renamed && entry.toolCallId !== undefined && entry.toolCallId !== existing.toolCallId
  if (!revised && !renamed && !reshown && !existing.demoted) {
    return { outputs: capOutputs(outputs, existingIndex), changed: 'unchanged' }
  }

  const updated: SlotOutput = {
    ...existing,
    path,
    title: entry.title,
    contentHash: entry.contentHash,
    versionOrdinal: revised ? existing.versionOrdinal + 1 : existing.versionOrdinal,
    demoted: false,
    demotionPending: existing.demoted ? true : existing.demotionPending,
    updatedAtMs: entry.atMs,
    mirrored: revised || reshown ? false : existing.mirrored,
    ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
  }
  const next = outputs.map((output, index) => (index === existingIndex ? updated : output))
  return {
    outputs: capOutputs(next, existingIndex),
    changed: revised ? 'revised' : renamed ? 'renamed' : 'unchanged',
  }
}

export function setOutputDemoted(
  outputs: SlotOutput[],
  path: string,
  demoted: boolean,
): SlotOutput[] {
  const normalizedPath = normalize(path)
  const index = outputs.findIndex((output) => normalize(output.path) === normalizedPath)
  if (index === -1 || (outputs[index]!.demoted === demoted && outputs[index]!.demotionPending)) return outputs
  return outputs.map((output, outputIndex) =>
    outputIndex === index ? { ...output, demoted, demotionPending: true } : output,
  )
}

export function acknowledgeOutputDemotion(outputs: SlotOutput[], path: string, desired: boolean): SlotOutput[] {
  const normalizedPath = normalize(path)
  return outputs.map((output) =>
    normalize(output.path) === normalizedPath && output.demoted === desired
      ? { ...output, demotionPending: false }
      : output)
}

export function markOutputMirrored(
  outputs: SlotOutput[],
  path: string,
  versionOrdinal: number,
): SlotOutput[] {
  const normalizedPath = normalize(path)
  const index = outputs.findIndex(
    (output) =>
      normalize(output.path) === normalizedPath && output.versionOrdinal === versionOrdinal,
  )
  if (index === -1 || outputs[index]!.mirrored) return outputs
  return outputs.map((output, outputIndex) =>
    outputIndex === index ? { ...output, mirrored: true } : output,
  )
}

export function promotedOutputs(outputs: SlotOutput[]): SlotOutput[] {
  return outputs.filter((output) => !output.demoted).sort((a, b) => b.updatedAtMs - a.updatedAtMs)
}

/**
 * Decide what a completed tool call means for the session's artifact.
 * Pure: the SessionManager applies the returned action (state, IPC, resize).
 */
export function artifactAction(
  current: SlotArtifact | null,
  toolName: string,
  input: { path?: unknown; title?: unknown },
  ok: boolean,
  toolCallId?: string,
): ArtifactAction | null {
  if (!ok || !input || typeof input.path !== 'string') return null
  const p = normalize(input.path)

  if (toolName === 'show_artifact') return {
    type: 'show',
    path: p,
    title: String(input.title),
    ...(toolCallId ? { toolCallId } : {}),
  }

  if (
    (toolName === 'write_file' || toolName === 'edit_file') &&
    current &&
    normalize(current.path) === p
  ) {
    return { type: 'reload' }
  }
  return null
}

/**
 * Artifacts are served over the app's own artifact:// scheme, one host per
 * slot, so the sandboxed iframe gets a real origin (storage APIs work) that
 * is still cross-origin to the renderer around it.
 */
export function artifactHost(slotIndex: number): string {
  return `slot-${slotIndex}`
}

export function artifactUrl(slotIndex: number): string {
  return `artifact://${artifactHost(slotIndex)}/`
}
