/**
 * Pure logic for the "Move macOS dock" strip action — a port of the original
 * claude-dock feature (Swift-era ⌘⌥L/⌘⌥B) that repositions the *system*
 * Dock via `defaults write com.apple.dock orientation`. Renderer-safe: no
 * Node imports.
 */

export const MAC_DOCK_ORIENTATIONS = ['left', 'right', 'bottom'] as const
export type MacDockOrientation = (typeof MAC_DOCK_ORIENTATIONS)[number]

export type MoveMacDockResult =
  | { ok: true; orientation: MacDockOrientation }
  | { ok: false; message: string }

/**
 * Normalize `defaults read com.apple.dock orientation` output. The key is
 * absent on a fresh macOS install (the read exits non-zero), which means the
 * system default: bottom.
 */
export function parseMacDockOrientation(raw: string | null): MacDockOrientation {
  const value = (raw ?? '').trim().toLowerCase()
  return (MAC_DOCK_ORIENTATIONS as readonly string[]).includes(value)
    ? (value as MacDockOrientation)
    : 'bottom'
}

