/**
 * Pure artifact-pane domain logic, ported from claude-dock
 * `src/shared/artifact.js`. Renderer-safe: no Node imports.
 */

export interface SlotArtifact {
  path: string
  title: string
  version?: number
}

export type ArtifactAction =
  | { type: 'show'; path: string; title: string }
  | { type: 'reload' }

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

/**
 * Decide what a completed tool call means for the session's artifact.
 * Pure: the SessionManager applies the returned action (state, IPC, resize).
 */
export function artifactAction(
  current: SlotArtifact | null,
  toolName: string,
  input: { path?: unknown; title?: unknown },
  ok: boolean,
): ArtifactAction | null {
  if (!ok || !input || typeof input.path !== 'string') return null
  const p = normalize(input.path)

  if (toolName === 'show_artifact') return { type: 'show', path: p, title: String(input.title) }

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
