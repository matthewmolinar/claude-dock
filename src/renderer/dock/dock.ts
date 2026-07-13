/**
 * Dock strip renderer, ported from claude-dock `renderer/dock/dock.js`.
 * Fully driven by state snapshots pushed from the main process.
 */
import type { DockBridge, DockLayout, DockSnapshot, SlotStatus } from '../../shared/dock'

declare global {
  interface Window {
    dock: DockBridge
  }
}

const slotsEl = document.getElementById('slots') as HTMLElement

const STATUS_TEXT: Record<SlotStatus, string> = {
  empty: 'Click to start',
  idle: 'Ready',
  active: 'Open',
  working: 'Working…',
  minimized: 'Hidden',
}

// Index of the slot currently being renamed, or null. Renders skip its label so
// we never yank text out from under the caret.
let renamingIndex: number | null = null
let addBtn: HTMLButtonElement | null = null

function applyLayout(layout: DockLayout): void {
  const root = document.documentElement.style
  root.setProperty('--slot-w', `${layout.slotWidth}px`)
  root.setProperty('--slot-h', `${layout.slotHeight}px`)
  root.setProperty('--gap', `${layout.gap}px`)
  root.setProperty('--margin', `${layout.margin}px`)
  root.setProperty('--header-h', `${layout.headerHeight}px`)
  root.setProperty('--add-w', `${layout.addButtonWidth}px`)
}

function buildSlot(index: number): HTMLDivElement {
  const slot = document.createElement('div')
  slot.className = 'slot'
  slot.dataset.index = String(index)

  const controls = document.createElement('div')
  controls.className = 'slot-controls'

  const min = document.createElement('button')
  min.className = 'ctl'
  min.textContent = '–'
  min.title = 'Hide this session'
  min.addEventListener('click', (e) => {
    e.stopPropagation()
    window.dock.minimize(index)
  })

  const close = document.createElement('button')
  close.className = 'ctl'
  close.textContent = '×'
  close.title = 'End this session'
  close.addEventListener('click', (e) => {
    e.stopPropagation()
    window.dock.close(index)
  })

  controls.append(min, close)

  const badge = document.createElement('span')
  badge.className = 'badge'

  const title = document.createElement('div')
  title.className = 'slot-title'

  const sub = document.createElement('div')
  sub.className = 'slot-sub'
  const dot = document.createElement('span')
  dot.className = 'dot'
  const subText = document.createElement('span')
  subText.className = 'sub-text'
  sub.append(dot, subText)

  slot.append(controls, badge, title, sub)

  slot.addEventListener('click', (e) => {
    if (renamingIndex === index) return
    if (e.altKey) {
      beginRename(index, title)
      return
    }
    // Shift-click re-picks the folder for an existing session.
    if (e.shiftKey) {
      window.dock.activateIn(index)
      return
    }
    window.dock.activate(index)
  })

  return slot
}

function beginRename(index: number, titleEl: HTMLElement): void {
  renamingIndex = index
  const original = titleEl.textContent ?? ''

  window.dock.setFocusable(true)
  titleEl.contentEditable = 'plaintext-only'
  titleEl.focus()

  const range = document.createRange()
  range.selectNodeContents(titleEl)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)

  const finish = (commit: boolean): void => {
    if (renamingIndex !== index) return
    renamingIndex = null
    titleEl.contentEditable = 'false'
    titleEl.removeEventListener('keydown', onKey)
    titleEl.removeEventListener('blur', onBlur)
    window.getSelection()?.removeAllRanges()
    // Hand focus back to whatever the user was working in.
    window.dock.setFocusable(false)

    const next = (titleEl.textContent ?? '').trim()
    if (commit && next !== original) window.dock.rename(index, next)
    else titleEl.textContent = original
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    }
  }
  const onBlur = (): void => finish(true)

  titleEl.addEventListener('keydown', onKey)
  titleEl.addEventListener('blur', onBlur)
}

function ensureSlotCount(n: number): void {
  while (slotsEl.querySelectorAll('.slot').length < n) {
    const index = slotsEl.querySelectorAll('.slot').length
    slotsEl.insertBefore(buildSlot(index), addBtn)
  }
  const slots = slotsEl.querySelectorAll('.slot')
  for (let i = slots.length - 1; i >= n; i--) slots[i].remove()
}

function render(state: DockSnapshot): void {
  ensureSlotCount(state.slots.length)

  const nodes = slotsEl.querySelectorAll<HTMLElement>('.slot')
  state.slots.forEach((slot, i) => {
    const node = nodes[i]
    node.dataset.status = slot.status
    node.dataset.hasWindow = String(slot.hasWindow)
    node.dataset.notify = String(slot.hasNotification)

    const title = node.querySelector('.slot-title') as HTMLElement
    if (renamingIndex !== i) {
      title.textContent = slot.status === 'empty' ? 'New session' : slot.label
    }
    node.title = slot.folder || 'Starts in your home folder — shift-click to pick another'

    const subText = node.querySelector('.sub-text') as HTMLElement
    subText.textContent = STATUS_TEXT[slot.status] || ''
  })
}

async function init(): Promise<void> {
  const { layout, state } = await window.dock.init()
  applyLayout(layout)

  addBtn = document.createElement('button')
  addBtn.id = 'addBtn'
  addBtn.textContent = '+'
  addBtn.title = '⌘⌥N — new session'
  addBtn.addEventListener('click', () => window.dock.addSlot())
  slotsEl.append(addBtn)

  document.getElementById('minAllBtn')?.addEventListener('click', () => window.dock.minimizeAll())
  document.getElementById('settingsBtn')?.addEventListener('click', () => window.dock.openSettings())

  render(state)
  window.dock.onState(render)
}

void init()
