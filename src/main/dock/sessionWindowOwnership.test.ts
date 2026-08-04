import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const desktopSrc = resolve(import.meta.dirname, '../..')
const read = (file: string): string => readFileSync(resolve(desktopSrc, file), 'utf8')

test('Workbench session windows use host-relative bounds without native ownership', () => {
  const windows = read('main/dock/windows.ts')
  const factory = windows.match(/export function createWorkbenchSessionWindow[\s\S]*?\n}\n/)?.[0] ?? ''

  assert.match(factory, /computeEmbeddedSessionFrame\([\s\S]*?host\.getContentBounds\(\)/)
  assert.match(factory, /new BrowserWindow\(\{\s*\.\.\.frame,/)
  assert.doesNotMatch(factory, /\bparent,|maximizable:\s*false|minimizable:\s*false/)
})

test('Workbench visibility and layout only manage the in-app strip', () => {
  const dock = read('main/dock/index.ts')

  assert.doesNotMatch(dock, /embeddedWins|embeddedShownBeforeHide|hideEmbeddedSessions|showEmbeddedSessions|clampEmbeddedSessionWindow/)
  assert.match(dock, /export function hideInAppDock\(\): void \{[\s\S]*?inAppDockWin\.hide\(\)[\s\S]*?\n}/)
  assert.match(dock, /export function layoutInAppDock\(\): void \{[\s\S]*?repositionInAppDock\([\s\S]*?\n}/)
})

test('slot activation never requests host navigation', () => {
  const dock = read('main/dock/index.ts')
  const openSlot = dock.match(/async function openSlot\([\s\S]*?\n}\n\n\/\*\* Which placement/)?.[0] ?? ''

  assert.match(openSlot, /sessions\.activate\(index/)
  assert.doesNotMatch(openSlot, /restoreEmbeddedSurface|hideEmbeddedSessions|showEmbeddedSessions/)
  assert.doesNotMatch(dock, /shouldRestoreEmbeddedSurface/)
})

test('session chrome hides the sender-owned slot while zoom targets only its window', () => {
  const dock = read('main/dock/index.ts')

  assert.match(dock, /DockWinIpcChannel\.Minimize[\s\S]*?senderIndex\(e\)[\s\S]*?sessions!\.minimizeSlot\(index\)/)
  assert.match(dock, /DockWinIpcChannel\.Close[\s\S]*?senderIndex\(e\)[\s\S]*?sessions!\.minimizeSlot\(index\)/)
  assert.match(dock, /DockWinIpcChannel\.Zoom[\s\S]*?winFor\(e\)/)
  assert.doesNotMatch(dock, /DockWinIpcChannel\.(?:Minimize|Close)[\s\S]{0,180}slotIndex/)
})

// The host-side half of this ("Lore no longer injects embedded-session
// restoration") reads `main/index.ts`, which the sync manifest does not copy, so
// it lives in `main/loreDockHostWiring.test.ts`. Here it passed vacuously in
// claude-dock against an entry file that never had the pattern.
