/**
 * Dock session (chat) renderer, ported from claude-dock
 * `renderer/session/session.js`. Streams assistant text into bubbles and
 * tool activity into collapsible chips; replays the transcript on load.
 */
import type { SessionBridge, ToolResultPayload, ToolStartPayload } from '../../shared/dock'

declare global {
  interface Window {
    session: SessionBridge
  }
}

const api = window.session

const thread = document.getElementById('thread') as HTMLElement
const input = document.getElementById('input') as HTMLTextAreaElement
const sendBtn = document.getElementById('send') as HTMLButtonElement
const stopBtn = document.getElementById('stop') as HTMLButtonElement
const folderBtn = document.getElementById('folder') as HTMLButtonElement
const titlebar = document.getElementById('titlebar') as HTMLElement
const needsKey = document.getElementById('needsKey') as HTMLElement

let busy = false
let bubble: HTMLElement | null = null // the assistant text node currently being streamed into
let pending: HTMLElement | null = null // the "Working…" indicator
const chips = new Map<string, { wrap: HTMLElement; chip: HTMLElement; detail: HTMLElement }>()

// ---- rendering -------------------------------------------------------------

function row(child: HTMLElement): HTMLElement {
  const r = document.createElement('div')
  r.className = 'row'
  r.append(child)
  thread.append(r)
  document.body.classList.add('has-messages')
  return r
}

function atBottom(): boolean {
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80
}

function scroll(force = false): void {
  if (force || atBottom()) thread.scrollTop = thread.scrollHeight
}

function addMessage(role: string, text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = `msg ${role}`
  el.textContent = text
  row(el)
  scroll(role === 'user')
  return el
}

function showPending(): void {
  if (pending) return
  pending = document.createElement('div')
  pending.id = 'pending'
  const spinner = document.createElement('span')
  spinner.className = 'spinner'
  pending.append(spinner, document.createTextNode('Working…'))
  row(pending)
  scroll()
}

function clearPending(): void {
  if (pending && pending.parentElement) pending.parentElement.remove()
  pending = null
}

function addChip({ id, label }: ToolStartPayload): void {
  clearPending()

  const wrap = document.createElement('div')
  wrap.className = 'activity'
  wrap.dataset.open = 'false'

  const chip = document.createElement('button')
  chip.className = 'chip'
  chip.dataset.state = 'running'
  const spinner = document.createElement('span')
  spinner.className = 'spinner'
  chip.append(spinner, document.createTextNode(label))

  const detail = document.createElement('div')
  detail.className = 'chip-detail'
  detail.textContent = ''

  chip.addEventListener('click', () => {
    wrap.dataset.open = wrap.dataset.open === 'true' ? 'false' : 'true'
    scroll()
  })

  wrap.append(chip, detail)
  row(wrap)
  chips.set(id, { wrap, chip, detail })
  scroll()
  // The next assistant text after a tool call belongs in a fresh bubble.
  bubble = null
}

function resolveChip({ id, ok, output }: ToolResultPayload): void {
  const entry = chips.get(id)
  if (!entry) return
  entry.chip.dataset.state = ok ? 'done' : 'failed'
  entry.detail.textContent = output || '(no output)'
  if (!ok) entry.wrap.dataset.open = 'true'
  scroll()
}

function appendText(delta: string): void {
  clearPending()
  if (!bubble) {
    bubble = document.createElement('div')
    bubble.className = 'msg assistant'
    row(bubble)
  }
  bubble.textContent += delta
  scroll()
}

// ---- state -----------------------------------------------------------------

function setBusy(next: boolean): void {
  busy = next
  input.disabled = next
  sendBtn.hidden = next
  stopBtn.hidden = !next
  if (!next) {
    clearPending()
    bubble = null
    input.focus()
    syncSend()
  }
}

function syncSend(): void {
  sendBtn.disabled = busy || input.value.trim().length === 0
}

function submit(): void {
  const text = input.value.trim()
  if (!text || busy) return
  addMessage('user', text)
  input.value = ''
  autosize()
  syncSend()
  setBusy(true)
  showPending()
  api.prompt(text)
}

function autosize(): void {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`
}

// ---- wiring ----------------------------------------------------------------

input.addEventListener('input', () => {
  autosize()
  syncSend()
})

input.addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter makes a new line. That is what a chat app does.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit()
  }
})

sendBtn.addEventListener('click', submit)
stopBtn.addEventListener('click', () => api.stop())

document.getElementById('close')?.addEventListener('click', () => api.closeWindow())
document.getElementById('min')?.addEventListener('click', () => api.minimizeWindow())
document.getElementById('zoom')?.addEventListener('click', () => api.zoomWindow())
document.getElementById('openSettings')?.addEventListener('click', () => api.openSettings())
folderBtn.addEventListener('click', () => api.revealFolder())

thread.addEventListener('scroll', () => {
  titlebar.classList.toggle('scrolled', thread.scrollTop > 4)
})

window.addEventListener('focus', () => {
  document.body.classList.remove('blurred')
  if (!busy) input.focus()
})
window.addEventListener('blur', () => document.body.classList.add('blurred'))
if (!document.hasFocus()) document.body.classList.add('blurred')

api.onAssistantStart(() => {
  bubble = null
})
api.onText(appendText)
api.onTool(addChip)
api.onToolResult(resolveChip)
api.onEntry((entry) => {
  clearPending()
  if (entry.role === 'user') return // already rendered optimistically
  addMessage(entry.role, entry.text)
})
api.onDone(() => setBusy(false))
api.onKeyState(({ hasKey }) => {
  needsKey.hidden = hasKey
})

// ---- boot ------------------------------------------------------------------

function prettyFolder(folder: string): string {
  return folder.replace(/^\/Users\/[^/]+/, '~')
}

async function init(): Promise<void> {
  const state = await api.init()
  const folder = (state && state.folder) || api.folder
  const pretty = prettyFolder(folder)
  folderBtn.textContent = pretty
  folderBtn.title = `${folder} — click to open in Finder`
  document.title = `Dock — ${pretty}`

  // Replay anything that happened before this window was opened or reloaded.
  for (const entry of (state && state.transcript) || []) {
    if (entry.role === 'assistant') {
      for (const tool of entry.tools || []) {
        addChip({ id: tool.id, label: tool.label })
        if (tool.output !== null) {
          resolveChip({ id: tool.id, ok: Boolean(tool.ok), output: tool.output })
        }
      }
      if (entry.text) {
        bubble = null
        appendText(entry.text)
      }
    } else {
      addMessage(entry.role, entry.text)
    }
  }
  bubble = null

  needsKey.hidden = Boolean(state && state.hasKey)
  setBusy(Boolean(state && state.busy))
  if (state && state.busy) showPending()
  scroll(true)
  syncSend()
}

void init()
