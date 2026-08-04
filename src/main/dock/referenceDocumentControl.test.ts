import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { addReferenceDocumentsForSender } from './referenceDocumentControl'

const desktopSrc = resolve(import.meta.dirname, '../..')
const read = (path: string): string => readFileSync(resolve(desktopSrc, path), 'utf8')

test('the session composer owns the reference-document action', () => {
  const html = read('renderer/session/index.html')
  const composer = html.slice(html.indexOf('<footer id="composer">'), html.indexOf('</footer>'))
  const button = '<button id="addReference" type="button" aria-label="Add reference document" title="Add reference document" hidden>+</button>'

  assert.ok(composer.includes(button))
  assert.ok(composer.indexOf(button) < composer.indexOf('<textarea'))
})

test('the session source control follows project state in the chat flow', () => {
  const html = read('renderer/session/index.html')
  const css = read('renderer/session/session.css')
  const chat = html.slice(html.indexOf('<div id="chat">'), html.indexOf('<aside id="artifactPane"'))
  const projectResume = chat.indexOf('<section id="projectResume"')
  const sources = chat.indexOf('<aside id="sourcesShell"')
  const thread = chat.indexOf('<main id="thread">')
  const sourceShellRule = css.match(/#sourcesShell\s*\{([^}]*)\}/)?.[1] ?? ''

  assert.ok(projectResume !== -1 && projectResume < sources)
  assert.ok(sources < thread)
  assert.match(sourceShellRule, /position:\s*relative/)
  assert.match(sourceShellRule, /align-self:\s*flex-end/)
  assert.doesNotMatch(sourceShellRule, /top:/)
})

test('the session bridge emits a sender-scoped add-reference intent without a slot index', () => {
  const preload = read('preload/session.ts')

  assert.match(preload, /addReferenceDocument:\s*\(\): void => ipcRenderer\.send\(DockSessionIpcChannel\.AddReferenceDocument\)/)
})

test('main delegates reference-document selection with sender-scoped ownership', () => {
  const main = read('main/dock/index.ts')
  const actionStart = main.indexOf('async function addReferenceDocumentForSender')
  const actionEnd = main.indexOf('\n\n/** Application-menu entry point', actionStart)
  const action = main.slice(actionStart, actionEnd)

  assert.notEqual(actionStart, -1)
  assert.notEqual(actionEnd, -1)
  assert.match(action, /addReferenceDocumentsForSender/)
  assert.match(action, /sender/)
  assert.match(action, /properties:\s*\[\s*['"]openFile['"]\s*,\s*['"]multiSelections['"]\s*\]/)
  assert.match(action, /extensions:\s*ingest\.extensions\.map\(\(ext\)\s*=>\s*ext\.replace\(\/\^\\\.\/\s*,\s*['"]['"]\)\)/)
  assert.doesNotMatch(action, /getFocusedWindow/)
})

test('cancellation and empty selection do not ingest', async () => {
  for (const picked of [
    { canceled: true, filePaths: ['/ignored'] },
    { canceled: false, filePaths: [] },
  ]) {
    const ingested: string[] = []
    await addReferenceDocumentsForSender({
      sender: {},
      indexForSender: () => 0,
      pick: async () => picked,
      ingest: async (_index, path) => { ingested.push(path) },
    })
    assert.deepEqual(ingested, [])
  }
})

test('documents ingest sequentially in picker order and resolved failures are best effort', async () => {
  const events: string[] = []
  let releaseFirst!: () => void
  const firstPending = new Promise<void>((resolveFirst) => { releaseFirst = resolveFirst })
  const run = addReferenceDocumentsForSender({
    sender: {},
    indexForSender: () => 2,
    pick: async () => ({ canceled: false, filePaths: ['first', 'second', 'third'] }),
    ingest: async (_index, path) => {
      events.push(`start:${path}`)
      if (path === 'first') await firstPending
      events.push(`end:${path}`)
      return path === 'second' ? { ok: false as const } : { ok: true as const }
    },
  })

  await new Promise((resolveTick) => setImmediate(resolveTick))
  assert.deepEqual(events, ['start:first'])
  releaseFirst()
  await run
  assert.deepEqual(events, [
    'start:first', 'end:first',
    'start:second', 'end:second',
    'start:third', 'end:third',
  ])
})

test('a rejected ingestion remains fatal', async () => {
  const attempted: string[] = []
  await assert.rejects(
    addReferenceDocumentsForSender({
      sender: {},
      indexForSender: () => 0,
      pick: async () => ({ canceled: false, filePaths: ['first', 'second'] }),
      ingest: async (_index, path) => {
        attempted.push(path)
        throw new Error('fatal')
      },
    }),
    /fatal/,
  )
  assert.deepEqual(attempted, ['first'])
})

test('re-resolves the sender index before every ingestion and stops when ownership is lost', async () => {
  const indices = [1, 3, -1]
  const ingested: Array<[number, string]> = []
  await addReferenceDocumentsForSender({
    sender: {},
    indexForSender: () => indices.shift() ?? -1,
    pick: async () => ({ canceled: false, filePaths: ['first', 'second', 'third'] }),
    ingest: async (index, path) => { ingested.push([index, path]) },
  })

  assert.deepEqual(ingested, [[3, 'first']])
})

test('the fire-and-forget IPC listener handles asynchronous failures', () => {
  const main = read('main/dock/index.ts')

  assert.match(main, /void addReferenceDocumentForSender\(e\.sender\)\.catch\(\(\) => dockLog\.warn\('reference_document_add_failed'\)\)/)
})

test('reference-document ingestion is absent from shared View and tray menu items', () => {
  const main = read('main/dock/index.ts')
  const menuStart = main.indexOf('export function buildDockMenuItems')
  const menu = main.slice(menuStart, main.indexOf('\n}', menuStart) + 2)

  assert.doesNotMatch(menu, /Reference Document|addReferenceDocument/)
})
