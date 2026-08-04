/**
 * Dock strip renderer, ported from claude-dock `renderer/dock/dock.js`.
 * Fully driven by state snapshots pushed from the main process.
 */
import type { DockAmbientBridge } from '../../shared/ambient'
import type { MicBridge } from '../../shared/audio'
import {
  getDockHeight,
  resolveTrapTarget,
  type DockBridge,
  type DockLayout,
  type DockPresentation,
  type DockSurface,
  type DockSnapshot,
  type SlotCardItem,
  type SlotCardsSnapshot,
  type SlotStatus,
  type TrapRect,
} from '../../shared/dock'
import { initMicButton } from './micButton'

declare global {
  interface Window {
    dock: DockBridge
    dockAmbient: DockAmbientBridge
    /** Absent when the host has no audio loop — then no mic button renders. */
    loreMic?: MicBridge
  }
}

const slotsEl = document.getElementById('slots') as HTMLElement
const stackEl = document.getElementById('stack') as HTMLElement
const compactHandle = document.getElementById('compactHandle') as HTMLButtonElement
const handleCount = document.getElementById('handleCount') as HTMLElement

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
let presentation: DockPresentation = { expanded: false, pinned: false }
let surface: DockSurface = 'floating'
let expandTimer: number | null = null
let collapseTimer: number | null = null

// ---- host card state -------------------------------------------------------

/** Per-slot card lists; index matches `state.slots`. Authoritative from main. */
let cards: SlotCardsSnapshot = []
/** Increments on every authoritative main-process card push. */
let cardsRevision = 0
/** Ids we've already seen per slot — seeds the save-moment "is this new?" check. */
let knownIds: Array<Set<string>> = []
/** Cards are seeded silently on first load; only later pushes animate. */
let seeded = false

// ---- stack hover state -------------------------------------------------------

/** Card width — wider than a slot so titles breathe. Mirrored in dock.css. */
const STACK_CARD_WIDTH = 178
/** The fan shows at most this many cards; the wheel pages to older ones. */
const STACK_VISIBLE = 5
/** Minimum inset from the window's edges when centering the stack on a slot. */
const STACK_EDGE_INSET = 8
/** Wheel travel per page step while paging the fan. */
const WHEEL_STEP = 40

let stackOpen = false
let stackSlot: number | null = null
/** Index of the first visible card in the slot's list (0 = newest). */
let stackPage = 0
let wheelAcc = 0
/** A cards push arrived mid-drag; re-render once the drag settles. */
let stackDirty = false
let openTimer: number | null = null
let closeTimer: number | null = null

// ---- drag state ------------------------------------------------------------

interface DragState {
  itemId: string
  /** The slot the stack (and card) belongs to — never a drop target. */
  fromIndex: number
  cardEl: HTMLElement
  pointerId: number
  startX: number
  startY: number
  /** Flips true once the pointer has moved past the 4px start threshold. */
  started: boolean
  /** Currently trapped drop-target slot index, or null. */
  trapped: number | null
  /** Pointer offset within the card at grab time, so it tracks under the cursor. */
  grabDX: number
  grabDY: number
  width: number
  /** Where the card sat when lifted (client coords) — the spring-back home. */
  liftX: number
  liftY: number
}

let drag: DragState | null = null

function reduced(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function clearExpandTimer(): void {
  if (expandTimer !== null) window.clearTimeout(expandTimer)
  expandTimer = null
}

function clearCollapseTimer(): void {
  if (collapseTimer !== null) window.clearTimeout(collapseTimer)
  collapseTimer = null
}

function clearPresentationTimers(): void {
  clearExpandTimer()
  clearCollapseTimer()
}

function renderPresentation(next: DockPresentation): void {
  presentation = next
  document.body.dataset.expanded = String(next.expanded)
  document.body.dataset.pinned = String(next.pinned)
  document.body.dataset.ready = 'true'
  if (surface === 'floating' && (!next.expanded || next.pinned)) window.dock.setFocusable(false)
  if (!next.expanded) closeStack()
  else scheduleCollapseIfOutside()
}

function requestExpanded(expanded: boolean): void {
  clearPresentationTimers()
  if (!expanded && presentation.pinned) return
  if (!expanded && (drag || renamingIndex !== null)) return
  window.dock.setExpanded(expanded)
}

function scheduleCollapse(): void {
  if (presentation.pinned || !presentation.expanded || drag || renamingIndex !== null) return
  if (collapseTimer !== null) window.clearTimeout(collapseTimer)
  collapseTimer = window.setTimeout(() => requestExpanded(false), 650)
}

function scheduleCollapseIfOutside(): void {
  if (!document.body.matches(':hover')) scheduleCollapse()
}

function scheduleExpand(): void {
  if (presentation.expanded) return
  clearExpandTimer()
  expandTimer = window.setTimeout(() => requestExpanded(true), 500)
}

function applyLayout(layout: DockLayout): void {
  const root = document.documentElement.style
  root.setProperty('--slot-w', `${layout.slotWidth}px`)
  root.setProperty('--slot-h', `${layout.slotHeight}px`)
  root.setProperty('--gap', `${layout.gap}px`)
  root.setProperty('--margin', `${layout.margin}px`)
  root.setProperty('--header-h', `${layout.headerHeight}px`)
  root.setProperty('--add-w', `${layout.addButtonWidth}px`)
  root.setProperty('--mic-w', `${layout.micButtonWidth}px`)
  root.setProperty('--dock-h', `${getDockHeight(layout) - layout.headerHeight}px`)
}

function buildSlot(index: number): HTMLDivElement {
  const slot = document.createElement('div')
  slot.className = 'slot'
  slot.dataset.index = String(index)

  const controls = document.createElement('div')
  controls.className = 'slot-controls'

  const min = document.createElement('button')
  min.className = 'ctl ctl-min'
  min.textContent = '–'
  min.title = 'Hide this session'
  min.addEventListener('click', (e) => {
    e.stopPropagation()
    window.dock.minimize(index)
  })

  const close = document.createElement('button')
  close.className = 'ctl ctl-close'
  close.textContent = '×'
  close.title = 'Close this session'
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

  // Count pill: how many host cards this slot holds. Hidden while empty.
  const count = document.createElement('span')
  count.className = 'count'
  count.hidden = true

  slot.append(controls, badge, title, sub, count)

  slot.addEventListener('click', (e) => {
    if (renamingIndex === index) return
    if (e.altKey) {
      beginRename(index, title)
      return
    }
    closeStack()
    // Shift-click re-picks the folder for an existing session.
    if (e.shiftKey) {
      window.dock.activateIn(index)
      return
    }
    window.dock.activate(index)
  })

  slot.addEventListener('mouseenter', () => onSlotHover(index))
  slot.addEventListener('mouseleave', () => onSlotLeave(index))

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
    const next = (titleEl.textContent ?? '').trim()
    if (commit && next !== original) window.dock.rename(index, next)
    else titleEl.textContent = original
    // Hand focus back only after the rename IPC is queued. Main blocks slot
    // structure changes across both strips while this editor owns focus.
    window.dock.setFocusable(false)
    scheduleCollapseIfOutside()
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
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
    // The focused session's slot wears the traveling selection ring.
    node.classList.toggle('travel-ring', slot.focused)

    const title = node.querySelector('.slot-title') as HTMLElement
    if (renamingIndex !== i) {
      title.textContent = slot.status === 'empty' ? 'New session' : slot.label
    }
    node.title = slot.folder || 'Starts in your home folder — shift-click to pick another'

    const subText = node.querySelector('.sub-text') as HTMLElement
    subText.textContent = STATUS_TEXT[slot.status] || ''
  })

  renderCounts()
  const live = state.slots.filter((slot) => slot.status !== 'empty')
  handleCount.textContent = String(live.length)
  compactHandle.dataset.state = state.slots.some((slot) => slot.hasNotification)
    ? 'attention'
    : state.slots.some((slot) => slot.status === 'working')
      ? 'working'
      : live.length > 0
        ? 'active'
        : 'idle'
  compactHandle.setAttribute(
    'aria-label',
    `Open Workbench dock, ${live.length} ${live.length === 1 ? 'session' : 'sessions'}`,
  )

  // A vanished slot can't stay the stack's subject.
  if (stackOpen && (stackSlot === null || stackSlot >= state.slots.length)) {
    closeStack()
  } else if (stackOpen) {
    renderStack()
  }
}

// ---- count pills -----------------------------------------------------------

function renderCounts(): void {
  slotsEl.querySelectorAll<HTMLElement>('.slot').forEach((node) => {
    const i = Number(node.dataset.index)
    const pill = node.querySelector('.count') as HTMLElement | null
    if (!pill) return
    const n = cards[i]?.length ?? 0
    pill.textContent = String(n)
    pill.hidden = n === 0
  })
}

function pulsePill(slotIndex: number): void {
  const pill = slotsEl.querySelector<HTMLElement>(`.slot[data-index="${slotIndex}"] .count`)
  if (!pill || pill.hidden) return
  pill.classList.remove('pulse')
  // Force reflow so re-adding the class restarts the animation.
  void pill.offsetWidth
  pill.classList.add('pulse')
  pill.addEventListener('animationend', () => pill.classList.remove('pulse'), { once: true })
}

// ---- save moment -----------------------------------------------------------

const DOC_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3" />' +
  '<line x1="6" y1="8.5" x2="10" y2="8.5" /><line x1="6" y1="11" x2="10" y2="11" /></svg>'

const IMG_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5" /><circle cx="6" cy="7" r="1.1" />' +
  '<path d="M3 12l3-3 2.5 2.5L11 8l2 2" /></svg>'

function glyphSvg(kind: 'doc' | 'img'): string {
  return kind === 'img' ? IMG_SVG : DOC_SVG
}

/** Fly a small chip from the strip's edge into a slot, then pulse its pill. */
function playSaveMoment(slotIndex: number, kind: 'doc' | 'img'): void {
  const slot = slotsEl.querySelector<HTMLElement>(`.slot[data-index="${slotIndex}"]`)
  if (!slot) return

  const chip = document.createElement('div')
  chip.className = 'save-chip'
  chip.innerHTML = glyphSvg(kind)
  document.body.appendChild(chip)

  const strip = slotsEl.getBoundingClientRect()
  const target = slot.getBoundingClientRect()
  const half = 11
  const startX = strip.left + 4
  const startY = strip.top + strip.height / 2 - half
  const endX = target.left + target.width / 2 - half
  const endY = target.top + target.height / 2 - half

  chip.style.transform = `translate(${startX}px, ${startY}px)`

  let finished = false
  const done = (): void => {
    if (finished) return
    finished = true
    chip.remove()
    pulsePill(slotIndex)
  }

  // Double rAF: paint the start transform, then transition to the target.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      chip.style.transform = `translate(${endX}px, ${endY}px) scale(0.4)`
      chip.style.opacity = '0'
    })
  })

  chip.addEventListener('transitionend', done, { once: true })
  window.setTimeout(done, 500)
}

// ---- stack -----------------------------------------------------------------

function onSlotHover(index: number): void {
  if (drag?.started) return
  cancelClose()
  const has = (cards[index]?.length ?? 0) > 0
  if (stackOpen) {
    if (has) setStackSlot(index)
    return
  }
  if (has) {
    clearOpenTimer()
    openTimer = window.setTimeout(() => openStack(index), 250)
  }
}

function onSlotLeave(_index: number): void {
  if (drag?.started) return
  clearOpenTimer()
  scheduleClose()
}

function clearOpenTimer(): void {
  if (openTimer !== null) {
    window.clearTimeout(openTimer)
    openTimer = null
  }
}

function scheduleClose(): void {
  cancelClose()
  closeTimer = window.setTimeout(closeStack, 300)
}

function cancelClose(): void {
  if (closeTimer !== null) {
    window.clearTimeout(closeTimer)
    closeTimer = null
  }
}

function openStack(index: number): void {
  clearOpenTimer()
  if ((cards[index]?.length ?? 0) === 0) return
  stackSlot = index
  stackPage = 0
  wheelAcc = 0
  // Grow the window upward first. The strip stays pinned to the bottom edge,
  // so the slot's horizontal position — all the stack needs — is unaffected.
  window.dock.setShelfOpen(true)
  stackOpen = true
  stackEl.hidden = false
  renderStack(true)
}

function setStackSlot(index: number): void {
  if (!stackOpen || stackSlot === index) return
  stackSlot = index
  stackPage = 0
  wheelAcc = 0
  renderStack(true)
}

function closeStack(): void {
  clearOpenTimer()
  cancelClose()
  if (!stackOpen) return
  if (drag) {
    // Main-initiated hiding may close the fan during a grab. Fully abandon it
    // before DOM teardown so no pointer capture or visual trap is stranded.
    detachDragListeners(drag)
    clearTraps()
    drag.cardEl.classList.remove('dragging', 'snapping', 'springback')
    stackEl.classList.remove('drag-from')
    drag = null
  }
  stackEl.hidden = true
  stackEl.replaceChildren()
  stackOpen = false
  stackSlot = null
  stackPage = 0
  window.dock.setShelfOpen(false)
}

/** Center the stack over its slot, clamped inside the window's edges. */
function positionStack(slotIndex: number): boolean {
  const slot = slotsEl.querySelector<HTMLElement>(`.slot[data-index="${slotIndex}"]`)
  if (!slot) return false
  const rect = slot.getBoundingClientRect()
  const centered = rect.left + rect.width / 2 - STACK_CARD_WIDTH / 2
  const max = window.innerWidth - STACK_CARD_WIDTH - STACK_EDGE_INSET
  stackEl.style.left = `${Math.round(Math.min(Math.max(centered, STACK_EDGE_INSET), max))}px`
  return true
}

/**
 * (Re)build the hovered slot's stack. Depth 0 is the newest capture and the
 * front card; deeper cards peek out above it, scaled and dimmed (the depth
 * transforms live in dock.css, keyed on the `--d` custom property).
 * `animate` plays the staggered rise out of the slot — open/switch only, so
 * routine re-renders never replay it.
 */
function renderStack(animate = false): void {
  if (!stackOpen || stackSlot === null) return
  if (drag) {
    // Never yank the DOM out from under an in-flight grab — including a
    // pressed-but-unmoved card (started=false): replacing the children would
    // detach it, its pointerup would never fire, and the stranded `drag`
    // state would silently swallow every future pointerdown.
    stackDirty = true
    return
  }
  const list = cards[stackSlot] ?? []
  if (list.length === 0 || !positionStack(stackSlot)) {
    closeStack()
    return
  }
  stackPage = Math.min(stackPage, Math.max(0, list.length - STACK_VISIBLE))
  const visible = list.slice(stackPage, stackPage + STACK_VISIBLE)
  stackEl.replaceChildren(
    ...visible.map((item, depth) => buildStackCard(item, stackSlot as number, depth, animate)),
  )
  stackDirty = false
}

function buildStackCard(
  item: SlotCardItem,
  fromIndex: number,
  depth: number,
  animate: boolean,
): HTMLElement {
  const card = document.createElement('div')
  card.className = 'stack-card'
  card.dataset.state = item.state
  card.dataset.depth = String(depth)
  card.style.setProperty('--d', String(depth))
  if (animate && !reduced()) card.classList.add('rise')

  const top = document.createElement('div')
  top.className = 'stack-card-top'
  const glyph = document.createElement('span')
  glyph.className = 'stack-card-glyph'
  glyph.innerHTML = glyphSvg(item.kindGlyph)
  const time = document.createElement('span')
  time.className = 'stack-card-time'
  time.textContent = item.timeLabel
  const state = document.createElement('span')
  state.className = 'stack-card-state'
  if (item.state === 'pending') {
    state.textContent = 'syncing…'
  } else {
    state.textContent = '✓'
    state.classList.add('stack-card-check')
  }
  top.append(glyph, time, state)

  const title = document.createElement('div')
  title.className = 'stack-card-title'
  title.textContent = item.title

  card.append(top, title)

  // The note body: collapsed until the card is hovered inside the fan.
  if (item.subtitle) {
    const sub = document.createElement('div')
    sub.className = 'stack-card-sub'
    sub.textContent = item.subtitle
    card.append(sub)
  }

  card.addEventListener('pointerdown', (e) => onCardPointerDown(e, item, fromIndex, card))
  return card
}

/** Page the fan to older/newer cards when the slot holds more than fits. */
function onStackWheel(e: WheelEvent): void {
  if (!stackOpen || stackSlot === null || drag?.started) return
  const list = cards[stackSlot] ?? []
  const maxPage = list.length - STACK_VISIBLE
  if (maxPage <= 0) return
  wheelAcc += e.deltaY
  const steps = Math.trunc(wheelAcc / WHEEL_STEP)
  if (steps === 0) return
  wheelAcc -= steps * WHEEL_STEP
  const next = Math.min(Math.max(stackPage + steps, 0), maxPage)
  if (next !== stackPage) {
    stackPage = next
    renderStack()
  }
}

// ---- drag between slots ----------------------------------------------------

function onCardPointerDown(
  e: PointerEvent,
  item: SlotCardItem,
  fromIndex: number,
  cardEl: HTMLElement,
): void {
  // Self-heal from a grab orphaned by a DOM swap (the pressed card was
  // detached before its pointerup could fire). Without this, one orphaned
  // grab leaves `drag` set forever and every future pointerdown is ignored.
  if (drag && !drag.cardEl.isConnected) {
    detachDragListeners(drag)
    clearTraps()
    stackEl.classList.remove('drag-from')
    drag = null
  }
  if (e.button !== 0 || drag) return
  drag = {
    itemId: item.id,
    fromIndex,
    cardEl,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    started: false,
    trapped: null,
    grabDX: 0,
    grabDY: 0,
    width: 0,
    liftX: 0,
    liftY: 0,
  }
  cardEl.setPointerCapture(e.pointerId)
  cardEl.addEventListener('pointermove', onCardPointerMove)
  cardEl.addEventListener('pointerup', onCardPointerUp)
  cardEl.addEventListener('pointercancel', onCardPointerCancel)
  e.preventDefault()
}

function collectTargets(d: DragState): TrapRect[] {
  const targets: TrapRect[] = []
  slotsEl.querySelectorAll<HTMLElement>('.slot').forEach((node) => {
    const index = Number(node.dataset.index)
    if (index === d.fromIndex) return
    const r = node.getBoundingClientRect()
    targets.push({ index, left: r.left, top: r.top, right: r.right, bottom: r.bottom })
  })
  return targets
}

function applyTrap(d: DragState, trapped: number | null): void {
  if (trapped === d.trapped) return
  slotsEl.querySelectorAll('.slot.trap').forEach((n) => n.classList.remove('trap'))
  if (trapped !== null) {
    slotsEl.querySelector(`.slot[data-index="${trapped}"]`)?.classList.add('trap')
  }
  d.trapped = trapped
}

function beginLift(d: DragState, e: PointerEvent): void {
  d.started = true
  const r = d.cardEl.getBoundingClientRect()
  d.width = r.width
  d.grabDX = e.clientX - r.left
  d.grabDY = e.clientY - r.top
  d.liftX = r.left
  d.liftY = r.top

  // Hold the fan open for the drag's duration so the card's home stays where
  // it was grabbed and the remaining cards don't shuffle mid-flight.
  stackEl.classList.add('drag-from')
  d.cardEl.classList.add('dragging')
  d.cardEl.style.width = `${r.width}px`
  d.cardEl.style.height = `${r.height}px`
  setCardTransform(d, r.left, r.top, false)
}

function setCardTransform(d: DragState, x: number, y: number, tilt: boolean): void {
  const flair = tilt && !reduced() ? ' rotate(2deg) scale(1.03)' : ''
  d.cardEl.style.transform = `translate(${x}px, ${y}px)${flair}`
}

function onCardPointerMove(e: PointerEvent): void {
  const d = drag
  if (!d) return

  if (!d.started) {
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return
    beginLift(d, e)
  }

  const trapped = resolveTrapTarget(
    { x: e.clientX, y: e.clientY },
    collectTargets(d),
    d.trapped,
    24,
  )
  applyTrap(d, trapped)

  if (trapped !== null) {
    // Snap toward the trapped slot's center instead of tracking 1:1.
    const slot = slotsEl.querySelector<HTMLElement>(`.slot[data-index="${trapped}"]`)
    if (slot) {
      const sr = slot.getBoundingClientRect()
      const x = sr.left + sr.width / 2 - d.width / 2
      const y = sr.top + sr.height / 2 - d.cardEl.offsetHeight / 2
      d.cardEl.classList.add('snapping')
      setCardTransform(d, x, y, true)
    }
  } else {
    d.cardEl.classList.remove('snapping')
    setCardTransform(d, e.clientX - d.grabDX, e.clientY - d.grabDY, true)
  }
}

function detachDragListeners(d: DragState): void {
  d.cardEl.removeEventListener('pointermove', onCardPointerMove)
  d.cardEl.removeEventListener('pointerup', onCardPointerUp)
  d.cardEl.removeEventListener('pointercancel', onCardPointerCancel)
  try {
    d.cardEl.releasePointerCapture(d.pointerId)
  } catch {
    // Capture may already be gone; nothing to release.
  }
}

function clearTraps(): void {
  slotsEl.querySelectorAll('.slot.trap').forEach((n) => n.classList.remove('trap'))
}

function onCardPointerUp(): void {
  const d = drag
  if (!d) return
  detachDragListeners(d)

  if (!d.started) {
    // A click, not a drag.
    drag = null
    if (stackDirty) renderStack()
    scheduleCollapseIfOutside()
    window.dock.activateSlotCard(d.itemId)
    return
  }

  clearTraps()
  if (d.trapped !== null) {
    void commitMove(d)
  } else {
    springBack(d)
  }
}

function onCardPointerCancel(): void {
  const d = drag
  if (!d) return
  detachDragListeners(d)
  clearTraps()
  if (!d.started) {
    drag = null
    if (stackDirty) renderStack()
    scheduleCollapseIfOutside()
    return
  }
  springBack(d)
}

async function commitMove(d: DragState): Promise<void> {
  const { itemId: id, fromIndex: from } = d
  const to = d.trapped as number
  drag = null
  scheduleCollapseIfOutside()

  d.cardEl.remove()
  stackEl.classList.remove('drag-from')

  // Optimistic move; a fresh authoritative push may also arrive and replace this.
  const prev = cards.map((list) => list.slice())
  const revision = cardsRevision
  const src = cards[from]
  let moved: SlotCardItem | undefined
  if (src) {
    const idx = src.findIndex((it) => it.id === id)
    if (idx >= 0) [moved] = src.splice(idx, 1)
  }
  const dst = cards[to]
  if (dst && moved) dst.push(moved)
  refreshAfterCardsChange()

  const ok = await window.dock.moveSlotCard(id, from, to)
  if (!ok && cardsRevision === revision) {
    cards = prev
    refreshAfterCardsChange()
  }
}

function springBack(d: DragState): void {
  drag = null

  // Back into the fan: drop the drag styling and let the depth CSS take over
  // again — the card lands exactly where it was lifted from.
  const settle = (): void => {
    d.cardEl.classList.remove('dragging', 'snapping', 'springback')
    d.cardEl.style.transform = ''
    d.cardEl.style.width = ''
    d.cardEl.style.height = ''
    stackEl.classList.remove('drag-from')
    if (stackDirty) renderStack()
    scheduleCollapseIfOutside()
  }

  if (reduced()) {
    settle()
    return
  }

  d.cardEl.classList.remove('snapping')
  d.cardEl.classList.add('springback')
  d.cardEl.style.transform = `translate(${d.liftX}px, ${d.liftY}px)`

  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    settle()
  }
  d.cardEl.addEventListener('transitionend', finish, { once: true })
  window.setTimeout(finish, 260)
}

/** Re-sync known ids, count pills, and the stack after a cards mutation. */
function refreshAfterCardsChange(): void {
  syncKnownIds()
  renderCounts()
  if (!stackOpen || stackSlot === null) return
  if (drag?.started) {
    // Closing or re-rendering would destroy the dragged card; defer.
    stackDirty = true
    return
  }
  if ((cards[stackSlot]?.length ?? 0) === 0) closeStack()
  else renderStack()
}

// ---- host card pushes ------------------------------------------------------

function syncKnownIds(): void {
  knownIds = cards.map((list) => new Set(list.map((it) => it.id)))
}

function seedCards(initial: SlotCardsSnapshot): void {
  cards = initial.map((list) => list.slice())
  syncKnownIds()
  seeded = true
  renderCounts()
}

function onCards(next: SlotCardsSnapshot): void {
  cardsRevision += 1
  const first = !seeded
  const newBySlot: SlotCardItem[][] = next.map((list, i) => {
    if (first) return []
    const known = knownIds[i] ?? new Set<string>()
    return list.filter((it) => !known.has(it.id))
  })

  cards = next.map((list) => list.slice())
  seeded = true
  refreshAfterCardsChange()

  // A new card animates unless motion is muted or the stack already shows it.
  if (first || reduced() || stackOpen) return
  newBySlot.forEach((items, i) => {
    items.forEach((it) => playSaveMoment(i, it.kindGlyph))
  })
}

async function init(): Promise<void> {
  let initialized = false
  let queuedPresentation: DockPresentation | null = null
  window.dock.onPresentation((next) => {
    if (initialized) renderPresentation(next)
    else queuedPresentation = next
  })
  window.dock.onWindowMove((moving) => {
    clearExpandTimer()
    if (!moving && compactHandle.matches(':hover')) scheduleExpand()
  })
  const {
    layout,
    state,
    cards: initialCards,
    presentation: initialPresentation,
    surface: initialSurface,
  } = await window.dock.init()
  surface = initialSurface
  document.body.dataset.surface = surface
  applyLayout(layout)
  initialized = true
  renderPresentation(queuedPresentation ?? initialPresentation)

  compactHandle.addEventListener('click', () => requestExpanded(true))
  compactHandle.addEventListener('mouseenter', scheduleExpand)
  compactHandle.addEventListener('mouseleave', clearExpandTimer)
  document.body.addEventListener('mouseenter', clearCollapseTimer)
  document.body.addEventListener('mouseleave', scheduleCollapse)

  addBtn = document.createElement('button')
  addBtn.id = 'addBtn'
  addBtn.textContent = '+'
  addBtn.title = '⌘⌥N — new session'
  addBtn.addEventListener('click', () => window.dock.addSlot())
  slotsEl.append(addBtn)

  // Push-to-talk mic — the add button's left-side mirror. Only when the host
  // both reserved the space (layout) and exposed the audio bridge (preload).
  if (layout.micButtonWidth > 0 && window.loreMic) {
    initMicButton(slotsEl, window.loreMic)
  }

  // The only remaining tray control: the overlaid × that hides the dock and
  // all sessions. Hide all / Quests / Settings / macOS Dock / the background
  // agent panel all keep their global keyboard shortcuts (registered in main).
  if (surface === 'floating') {
    document.getElementById('dismissBtn')?.addEventListener('click', () => window.dock.dismiss())
  }

  // Keep the stack open while the pointer is inside it; a drag suppresses the
  // leave so the fan survives the card's departure from the region.
  stackEl.addEventListener('mouseenter', cancelClose)
  stackEl.addEventListener('mouseleave', () => {
    if (drag?.started) return
    scheduleClose()
  })
  stackEl.addEventListener('wheel', onStackWheel, { passive: true })

  render(state)
  seedCards(initialCards)
  window.dock.onState(render)
  window.dock.onSlotCards(onCards)
}

void init()
