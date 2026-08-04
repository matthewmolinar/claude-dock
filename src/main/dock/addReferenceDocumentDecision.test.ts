import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { isSafeExternalSourceUrl } from './index'

const desktopSrc = resolve(import.meta.dirname, '../..')
const read = (file: string): string => readFileSync(resolve(desktopSrc, file), 'utf8')

test('source IPC is sender-owned and rejects stale senders and malformed preview paths', () => {
  const main = read('main/dock/index.ts')

  assert.match(main, /DockSessionIpcChannel\.RefreshSources[\s\S]*?senderIndex\(e\)/)
  assert.match(main, /DockSessionIpcChannel\.RetrySources[\s\S]*?senderIndex\(e\)[\s\S]*?retrySources\(index\)/)
  assert.match(main, /DockSessionIpcChannel\.PreviewSource[\s\S]*?senderIndex\(e\)[\s\S]*?typeof relativePath !== 'string'/)
  assert.match(main, /DockSessionIpcChannel\.CloseInspector[\s\S]*?senderIndex\(e\)[\s\S]*?closeSourceInspector\(index\)/)
  assert.doesNotMatch(main, /PreviewSource[\s\S]{0,300}slotIndex/)
})

test('source external links allow only safe explicit protocols', () => {
  assert.equal(isSafeExternalSourceUrl('https://lore.link/docs'), true)
  assert.equal(isSafeExternalSourceUrl('http://example.com/source'), true)
  assert.equal(isSafeExternalSourceUrl('mailto:help@lore.link'), false)
  assert.equal(isSafeExternalSourceUrl('javascript:alert(1)'), false)
  assert.equal(isSafeExternalSourceUrl('data:text/html,hello'), false)
  assert.equal(isSafeExternalSourceUrl('file:///tmp/run.command'), false)
  assert.equal(isSafeExternalSourceUrl('/relative/source'), false)
  assert.equal(isSafeExternalSourceUrl('not a url'), false)
})

test('preload exposes the complete source lifecycle without accepting an index', () => {
  const preload = read('preload/session.ts')

  for (const method of ['addSource', 'refreshSources', 'retrySources', 'previewSource', 'closeInspector', 'openSourceLink', 'dismissSourceNotice']) {
    assert.match(preload, new RegExp(`${method}:`))
  }
  assert.match(preload, /onSources:[\s\S]*?DockSessionIpcChannel\.Sources/)
  assert.match(preload, /onSourceNotice:[\s\S]*?DockSessionIpcChannel\.SourceNotice/)
  assert.doesNotMatch(preload, /(?:addSource|refreshSources|retrySources|previewSource|closeInspector|openSourceLink|dismissSourceNotice):\s*\([^)]*index/)
})

test('source notice dismissal is sender-owned and clears authoritative Session state', () => {
  const main = read('main/dock/index.ts')

  assert.match(main, /DockSessionIpcChannel\.DismissSourceNotice[\s\S]*?senderIndex\(e\)[\s\S]*?dismissSourceNotice\(index\)/)
})

// The `main/index.ts` halves of the two cases below — that Lore wires the menu
// item, and that it injects the preview policy — read a file the sync manifest
// does not copy, so they live in `main/loreDockHostWiring.test.ts`. Asserted
// from here they failed in claude-dock, whose standalone entry file has no
// reason to satisfy them.

test('both add entry points reuse the same picker while preserving ownership', () => {
  const dock = read('main/dock/index.ts')

  assert.match(dock, /addSourceForFocusedSession/)
  assert.match(dock, /BrowserWindow\.getFocusedWindow\(\)/)
  assert.match(dock, /addReferenceDocumentForSender\(focused\.webContents\)/)
})

test('the dock controller stays neutral about preview policy', () => {
  const dock = read('main/dock/index.ts')
  const dockImports = dock.slice(0, dock.indexOf('const HOTKEYS'))

  assert.doesNotMatch(dockImports, /from ['"]\.\.\/dockSourcePreview|@lore\/contracts/)
  const previewHook = dock.match(/interface PreviewSourceHook \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.doesNotMatch(previewHook, /extensions:/)
})

test('Init exposes preview capability and the renderer omits dead preview controls without it', () => {
  const dock = read('main/dock/index.ts')
  const renderer = read('renderer/session/session.ts')

  assert.match(dock, /canPreviewReferenceDocuments:\s*Boolean\(previewSourceHook\)/)
  assert.match(renderer, /canPreviewReferenceDocuments = Boolean\(state\?\.canPreviewReferenceDocuments\)/)
  assert.match(renderer, /if \(canPreviewReferenceDocuments\) select\.addEventListener\('click', \(\) => void openSource\([\s\S]*?\)\)/)
  assert.match(renderer, /setAttribute\('aria-label', `Open preview for \$\{row\.label\}`\)/)
})
