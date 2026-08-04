/**
 * Artifacts are served over artifact://slot-N/ instead of file://.
 * Ported from claude-dock `src/main/artifact-protocol.js`.
 *
 * Why: the pane's iframe needs `allow-same-origin` for storage APIs to work
 * (a sandboxed document without it throws on localStorage, which kills every
 * model-written game that keeps a high score). Granting same-origin on a
 * file:// URL would make the artifact same-origin with the renderer around
 * it — a sandbox escape. A dedicated scheme gives each slot's artifact its
 * own origin: storage works, the parent window stays out of reach, and this
 * handler serves nothing but the one registered file per slot.
 */
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { net, protocol, type Protocol } from 'electron'

import { artifactHost } from '../../shared/dockArtifact'
import { escapeHtml, renderMarkdown } from '../../shared/dockMarkdown'

// slot host ("slot-3") -> absolute path of the currently shown artifact.
const registry = new Map<string, string>()
const currentHostBySlot = new Map<number, string>()

export function registerArtifact(slotIndex: number, file: string): string {
  const previousHost = currentHostBySlot.get(slotIndex)
  if (previousHost) registry.delete(previousHost)
  const extension = path.extname(file).toLowerCase()
  const host = extension === '.md' || extension === '.markdown'
    ? `markdown-slot-${slotIndex}-${randomBytes(16).toString('hex')}`
    : artifactHost(slotIndex)
  currentHostBySlot.set(slotIndex, host)
  registry.set(host, file)
  return `artifact://${host}/`
}

export function unregisterArtifact(slotIndex: number): void {
  const host = currentHostBySlot.get(slotIndex)
  if (host) registry.delete(host)
  currentHostBySlot.delete(slotIndex)
}

/** Must run before app.whenReady, or the scheme gets no origin/storage. */
export function registerArtifactScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'artifact', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ])
}

// Markdown and plain-text artifacts are wrapped in a quiet reading page so a
// document the assistant wrote looks like a document, not source code.
const DOC_STYLE = `
  body { margin: 0; background: #1f1d1b; color: #e8e5e0;
         font: 15px/1.65 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
         -webkit-font-smoothing: antialiased; }
  main { max-width: 640px; margin: 0 auto; padding: 40px 28px 80px; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 0.5em; }
  h1 { font-size: 26px; margin-top: 0.4em; } h2 { font-size: 20px; } h3 { font-size: 16.5px; }
  p, ul, ol { margin: 0.7em 0; } li { margin: 0.25em 0; }
  a { color: #e8a284; } hr { border: 0; border-top: 1px solid rgba(255,255,255,0.14); margin: 2em 0; }
  blockquote { margin: 0.9em 0; padding: 2px 16px; border-left: 3px solid #d97757; color: #b5b0a8; }
  code { background: rgba(255,255,255,0.08); border-radius: 4px; padding: 1.5px 5px;
         font: 13px ui-monospace, "SF Mono", Menlo, monospace; }
  pre { background: rgba(255,255,255,0.06); border-radius: 8px; padding: 14px 16px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 0.9em 0; }
  th, td { border: 1px solid rgba(255,255,255,0.14); padding: 6px 10px; text-align: left; }
  th { color: #d97757; font-weight: 600; }
  button[data-work-program-item] { appearance: none; border: 1px solid #e8a284; border-radius: 4px;
         background: rgba(232,162,132,0.12); color: #e8a284; padding: 5px 9px;
         font: inherit; font-weight: 600; cursor: pointer; }
  button[data-work-program-item]:hover { background: rgba(232,162,132,0.2); }
  button[data-work-program-item]:focus-visible { outline: 2px solid #e8a284; outline-offset: 2px; }
`

const WORK_PROGRAM_ACTION_SCRIPT = `<script>
  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element
      ? event.target.closest('button[data-work-program-item]')
      : null
    if (!button) return
    const itemId = button.getAttribute('data-work-program-item')
    if (itemId) parent.postMessage({ type: 'work-program:implement', itemId }, '*')
  })
</script>`

function documentPage(body: string, workProgramActions = false): string {
  const policy = workProgramActions
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8">${policy}<style>${DOC_STYLE}</style></head><body><main>${body}</main>${workProgramActions ? WORK_PROGRAM_ACTION_SCRIPT : ''}</body></html>`
}

/**
 * Install the artifact:// handler on the protocol module that serves the
 * session windows (pass `ses.protocol` when they live in a partition).
 */
export function installArtifactHandler(target: Protocol = protocol): void {
  target.handle('artifact', (request) => {
    const file = registry.get(new URL(request.url).host)
    if (!file) return new Response('Not found', { status: 404 })

    const ext = path.extname(file).toLowerCase()
    if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
      let source: string
      try {
        source = fs.readFileSync(file, 'utf8')
      } catch {
        return new Response('Not found', { status: 404 })
      }
      const isMarkdown = ext !== '.txt'
      const body = isMarkdown ? renderMarkdown(source, { workProgramActions: true }) : `<pre>${escapeHtml(source)}</pre>`
      return new Response(documentPage(body, isMarkdown), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    return net.fetch(pathToFileURL(file).href)
  })
}
