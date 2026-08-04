/**
 * BrowserWindow factories for the dock widget's three surfaces, ported from
 * claude-dock `src/main/windows.js`.
 *
 * The dock strip is a frameless, transparent, non-activating, always-on-top
 * window at the bottom-center of the primary display's work area. Session
 * windows are frameless dark chat windows that cascade. The settings window
 * is a small modal panel for the Anthropic API key.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BrowserWindow, screen, type Rectangle } from 'electron'

import {
  clampDockFrame,
  computeDockFrame,
  computeEmbeddedSessionFrame,
  computeInAppDockFrame,
  expandedFrameForHandle,
  expandedSessionWidth,
  getDockHeight,
  getDockWidth,
  LAYOUT,
  SESSION_MIN_HEIGHT,
  SESSION_MIN_WIDTH,
  type DockFrame,
  type DockLayout,
  type DockPosition,
  type EmbeddedInsets,
} from '../../shared/dock'
import { dockLog } from './log'

/**
 * Session windows live in their own persistent session partition so the
 * network can be blocked and the artifact:// scheme served there without
 * touching the host app's default session.
 */
export const DOCK_SESSION_PARTITION = 'persist:dock-session'

const dirname = path.dirname(fileURLToPath(import.meta.url))
/** electron-vite serves the renderers here in dev; file:// loads in prod. */
const RENDERER_DEV_URL = process.env.ELECTRON_RENDERER_URL

function preloadPath(name: 'dock' | 'session' | 'settings' | 'macdock'): string {
  return path.join(dirname, `../preload/${name}.js`)
}

function loadRenderer(win: BrowserWindow, page: 'dock' | 'session' | 'settings' | 'macdock'): void {
  if (RENDERER_DEV_URL) {
    void win.loadURL(`${RENDERER_DEV_URL}/${page}/index.html`)
  } else {
    void win.loadFile(path.join(dirname, `../renderer/${page}/index.html`))
  }
}

// Whether the host opted into the strip's push-to-talk mic control (the add
// button's left-side mirror). Off by default: the standalone dock has no
// audio surface, so the strip reserves no space for one.
let micEnabled = false

export function setDockMicEnabled(enabled: boolean): void {
  micEnabled = enabled
}

// Host chrome insets for the in-app surfaces. The strip and the embedded
// session windows both center within the page area these leave free, so the
// Workbench reads centered relative to what the user actually sees, not the
// raw window (which includes the host's sidebar).
let hostInsets: EmbeddedInsets = { top: 0, left: 0 }

export function setInAppDockInsets(insets: EmbeddedInsets): void {
  hostInsets = insets
}

/** The layout the strip actually renders and sizes with. */
export function effectiveDockLayout(): DockLayout {
  return micEnabled ? { ...LAYOUT } : { ...LAYOUT, micButtonWidth: 0 }
}

export function dockFrameFor(slotCount: number, position: DockPosition | null = null): DockFrame {
  // workArea already excludes the menu bar and the system Dock on whichever
  // edge it lives, so we never need to move the user's Dock out of the way.
  if (!position) {
    return computeDockFrame(screen.getPrimaryDisplay().workArea, slotCount, effectiveDockLayout())
  }
  const display = screen.getDisplayNearestPoint(position)
  return clampDockFrame(display.workArea, position, slotCount, effectiveDockLayout())
}

function compactFrame(frame: DockFrame, workArea: Rectangle): DockFrame {
  const width = Math.min(LAYOUT.compactWidth, workArea.width)
  const height = Math.min(LAYOUT.compactHeight, workArea.height)
  return {
    x: Math.round(
      Math.min(
        Math.max(frame.x + (frame.width - width) / 2, workArea.x),
        workArea.x + workArea.width - width,
      ),
    ),
    y: Math.round(
      Math.max(workArea.y, workArea.y + workArea.height - height - LAYOUT.bottomOffset),
    ),
    width,
    height,
  }
}

const expandedWindows = new WeakMap<BrowserWindow, boolean>()
const compactAnchors = new WeakMap<BrowserWindow, DockPosition>()

export function createDockWindow(
  slotCount: number,
  position: DockPosition | null = null,
  expanded = false,
  handlePosition: DockPosition | null = null,
): BrowserWindow {
  // Open expanded with no saved expanded position, but a saved handle position
  // (a legacy compact-mode install): anchor the strip to the handle's location
  // and monitor rather than the primary display's default spot.
  const fullFrame =
    expanded && !position && handlePosition
      ? expandedFrameForHandle(
          screen.getDisplayNearestPoint(handlePosition).workArea,
          handlePosition,
          slotCount,
          effectiveDockLayout(),
        )
      : dockFrameFor(slotCount, position)
  const handleDisplay = handlePosition ? screen.getDisplayNearestPoint(handlePosition) : null
  const display = handleDisplay ?? screen.getDisplayMatching(fullFrame)
  const handleSeed = handlePosition
    ? { ...handlePosition, width: LAYOUT.compactWidth, height: LAYOUT.compactHeight }
    : fullFrame
  const frame = expanded ? fullFrame : compactFrame(handleSeed, display.workArea)

  const win = new BrowserWindow({
    ...frame,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Non-activating: clicking the dock must not steal focus from the session
    // you are about to act on. Temporarily flipped true while renaming a slot.
    focusable: false,
    show: false,
    webPreferences: {
      preload: preloadPath('dock'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.setAlwaysOnTop(true, 'floating')
  expandedWindows.set(win, expanded)
  const initialCompactFrame = compactFrame(handleSeed, display.workArea)
  compactAnchors.set(win, { x: initialCompactFrame.x, y: initialCompactFrame.y })
  // Keep the Dock visible across spaces without turning the entire macOS app
  // into an accessory/UIElement process that disappears from Dock and Cmd-Tab.
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  })
  loadRenderer(win, 'dock')
  // macOS re-grows a native shadow on transparent windows after show/resize,
  // which reads as a grey ridge around the tray's rounded corners. Pin it off.
  win.once('ready-to-show', () => {
    win.setHasShadow(false)
    win.showInactive()
  })
  win.on('resize', () => win.setHasShadow(false))
  win.on('show', () => win.setHasShadow(false))

  return win
}

/**
 * Create the Workbench rendered inside Lore's main window. This is a parented
 * child rather than an always-on-top/all-workspaces window, so it follows Lore
 * through tab changes, minimize, spaces, and window movement without covering
 * other apps.
 */
export function createInAppDockWindow(parent: BrowserWindow, slotCount: number): BrowserWindow {
  const win = new BrowserWindow({
    parent,
    ...inAppDockFrame(parent, slotCount),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Match the global strip: ordinary clicks do not steal keyboard focus from
    // the hosted app. Main temporarily enables focus for inline slot rename.
    focusable: false,
    show: false,
    webPreferences: {
      preload: preloadPath('dock'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  loadRenderer(win, 'dock')
  win.on('resize', () => win.setHasShadow(false))
  win.on('show', () => win.setHasShadow(false))
  return win
}

function inAppDockFrame(
  parent: BrowserWindow,
  slotCount: number,
  shelfOpen = false,
): DockFrame {
  const bounds = parent.getContentBounds()
  // Center within the page area right of the host sidebar, not the raw window.
  const region = {
    ...bounds,
    x: bounds.x + hostInsets.left,
    width: Math.max(0, bounds.width - hostInsets.left),
  }
  return computeInAppDockFrame(region, slotCount, shelfOpen, effectiveDockLayout())
}

/** Keep the in-app strip anchored inside the current main-window bounds. */
export function repositionInAppDock(
  win: BrowserWindow | null,
  parent: BrowserWindow | null,
  slotCount: number,
  shelfOpen = false,
): void {
  if (!win || win.isDestroyed() || !parent || parent.isDestroyed()) return
  win.setBounds(inAppDockFrame(parent, slotCount, shelfOpen))
}

/** Reveal or tuck the strip while keeping its bottom-center anchor stable. */
export function setDockExpanded(
  win: BrowserWindow | null,
  expanded: boolean,
  slotCount: number,
): void {
  if (!win || win.isDestroyed() || expandedWindows.get(win) === expanded) return
  const bounds = win.getBounds()
  const display = screen.getDisplayMatching(bounds)
  const layout = effectiveDockLayout()
  let next: DockFrame
  if (expanded) {
    const width = Math.min(getDockWidth(slotCount, layout), display.workArea.width)
    const height = Math.min(getDockHeight(layout), display.workArea.height)
    next = clampDockFrame(
      display.workArea,
      {
        x: Math.round(bounds.x + (bounds.width - width) / 2),
        y: Math.round(bounds.y + bounds.height - height),
      },
      slotCount,
      layout,
    )
  } else {
    shelfExtra.delete(win)
    const anchor = compactAnchors.get(win) ?? bounds
    const anchorDisplay = screen.getDisplayNearestPoint(anchor)
    next = compactFrame(
      { ...anchor, width: LAYOUT.compactWidth, height: LAYOUT.compactHeight },
      anchorDisplay.workArea,
    )
  }
  expandedWindows.set(win, expanded)
  win.setBounds(next)
}

/**
 * Extra height the strip window currently carries for the open card shelf.
 * Tracked here so repositionDock (slot-count changes, display changes) never
 * snaps the window back to strip-only height while the shelf is open.
 */
const shelfExtra = new WeakMap<BrowserWindow, number>()

export function repositionDock(win: BrowserWindow | null, slotCount: number): void {
  if (!win || win.isDestroyed()) return
  const bounds = win.getBounds()
  const display = screen.getDisplayMatching(bounds)
  if (!expandedWindows.get(win)) {
    const next = compactFrame(bounds, display.workArea)
    compactAnchors.set(win, { x: next.x, y: next.y })
    if (
      bounds.x !== next.x ||
      bounds.y !== next.y ||
      bounds.width !== next.width ||
      bounds.height !== next.height
    ) {
      win.setBounds(next)
    }
    return
  }
  const extra = shelfExtra.get(win) ?? 0
  // Clamp as if the window were strip-only (the shelf is transient), keyed on
  // the strip's own top-left so an open shelf doesn't drift the position.
  const strip = { x: bounds.x, y: bounds.y + extra }
  const base = clampDockFrame(display.workArea, strip, slotCount, effectiveDockLayout())
  const next = growUpForShelf(base, display.workArea, extra)
  if (
    bounds.x !== next.x ||
    bounds.y !== next.y ||
    bounds.width !== next.width ||
    bounds.height !== next.height
  ) {
    win.setBounds(next)
  }
}

function growUpForShelf(
  frame: DockFrame,
  workArea: { y: number },
  shelfHeight: number,
): DockFrame {
  // The strip must not move: grow upward, shrinking the shelf if the dock
  // sits near the top of the work area.
  const grow = Math.min(shelfHeight, Math.max(0, frame.y - workArea.y))
  return { ...frame, y: frame.y - grow, height: frame.height + grow }
}

/**
 * Grow the strip window upward for the hover card shelf, or give the space
 * back. The strip's own frame never moves — only the window's top edge does.
 */
export function resizeForShelf(
  win: BrowserWindow | null,
  open: boolean,
  shelfHeight: number,
  slotCount: number,
): void {
  if (!win || win.isDestroyed()) return
  // A renderer may close its shelf in response to a main-initiated collapse.
  // Do not let that late message grow compact native bounds back to strip size.
  if (!expandedWindows.get(win)) {
    shelfExtra.delete(win)
    return
  }
  const current = shelfExtra.get(win) ?? 0
  const bounds = win.getBounds()
  const display = screen.getDisplayMatching(bounds)
  const strip = { x: bounds.x, y: bounds.y + current }
  const base = clampDockFrame(display.workArea, strip, slotCount, effectiveDockLayout())

  if (open) {
    const next = growUpForShelf(base, display.workArea, shelfHeight)
    shelfExtra.set(win, next.height - base.height)
    win.setBounds(next)
  } else {
    shelfExtra.delete(win)
    win.setBounds(base)
  }
}

let cascade = 0

function sessionWebPreferences(folder: string): Electron.WebPreferences {
  return {
    preload: preloadPath('session'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    partition: DOCK_SESSION_PARTITION,
    // No slot index: session IPC is resolved by sender in main, so the
    // preload never needs to know (or go stale on) its slot position.
    additionalArguments: [`--cd-folder=${encodeURIComponent(folder)}`],
  }
}

// Surface warnings/errors from the renderer AND anything framed inside it
// (artifact pages). Without this, a crashed artifact script is invisible.
function wireSessionConsole(win: BrowserWindow, slotIndex: number): void {
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      dockLog.warn('session_console', {
        slot: slotIndex,
        level: event.level,
        message: event.message,
        source: event.sourceId ?? '',
      })
    }
  })
}

export function createSessionWindow({ slotIndex, folder }: { slotIndex: number; folder: string }): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()
  const width = Math.min(760, workArea.width - 80)
  const height = Math.min(680, workArea.height - 140)

  // Stagger new windows so a fresh one never lands exactly on the last.
  const offset = (cascade++ % 6) * 28

  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2) + offset,
    y: Math.round(workArea.y + 50) + offset,
    minWidth: SESSION_MIN_WIDTH,
    minHeight: SESSION_MIN_HEIGHT,
    frame: false,
    roundedCorners: true,
    backgroundColor: '#1a1917',
    show: false,
    title: 'Dock Session',
    webPreferences: sessionWebPreferences(folder),
  })

  loadRenderer(win, 'session')
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
  wireSessionConsole(win, slotIndex)

  return win
}

let workbenchSessionCascade = 0

/**
 * A session launched from the in-app Workbench. Its initial frame is relative
 * to the Workbench content region, but it has no native owner and can move,
 * minimize, and maximize independently from Lore's main window.
 */
export function createWorkbenchSessionWindow(
  host: BrowserWindow,
  insets: EmbeddedInsets,
  { slotIndex, folder }: { slotIndex: number; folder: string },
): BrowserWindow {
  const frame = computeEmbeddedSessionFrame(
    host.getContentBounds(),
    insets,
    workbenchSessionCascade++,
    effectiveDockLayout(),
  )
  const win = new BrowserWindow({
    ...frame,
    minWidth: SESSION_MIN_WIDTH,
    minHeight: SESSION_MIN_HEIGHT,
    frame: false,
    roundedCorners: true,
    backgroundColor: '#1a1917',
    show: false,
    title: 'Dock Session',
    webPreferences: sessionWebPreferences(folder),
  })

  loadRenderer(win, 'session')
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
  wireSessionConsole(win, slotIndex)
  return win
}

interface ArtifactResizeState {
  chatWidth: number | null
  chatX: number | null
}

const resizeState = new WeakMap<BrowserWindow, ArtifactResizeState>()

/**
 * Widen a session window for the artifact pane, or give the space back.
 * Remembers the chat-only width per window so close restores it.
 */
export function resizeForArtifact(win: BrowserWindow | null, open: boolean): void {
  if (!win || win.isDestroyed()) return
  const { workArea } = screen.getPrimaryDisplay()
  const bounds = win.getBounds()
  const state = resizeState.get(win) ?? { chatWidth: null, chatX: null }

  if (open) {
    if (state.chatWidth == null) {
      state.chatWidth = bounds.width
      state.chatX = bounds.x
      resizeState.set(win, state)
    }
    const width = expandedSessionWidth(state.chatWidth, workArea.width)
    win.setBounds({ ...bounds, x: Math.max(workArea.x, bounds.x - (width - bounds.width)), width })
  } else if (state.chatWidth != null) {
    const width = state.chatWidth
    const x = Math.max(workArea.x, Math.min(state.chatX ?? bounds.x, workArea.x + workArea.width - width))
    win.setBounds({ ...bounds, x, width })
    resizeState.delete(win)
  }
}

export function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 440,
    height: 330,
    frame: false,
    roundedCorners: true,
    backgroundColor: '#1a1917',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    center: true,
    show: false,
    webPreferences: {
      preload: preloadPath('settings'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.setAlwaysOnTop(true, 'modal-panel')
  loadRenderer(win, 'settings')
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
  return win
}

/** The macOS Dock position picker — same frameless panel shape as settings. */
export function createMacDockWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 360,
    height: 210,
    frame: false,
    roundedCorners: true,
    backgroundColor: '#1a1917',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    center: true,
    show: false,
    webPreferences: {
      preload: preloadPath('macdock'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.setAlwaysOnTop(true, 'modal-panel')
  loadRenderer(win, 'macdock')
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
  return win
}
