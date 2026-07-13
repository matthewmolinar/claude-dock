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

import { BrowserWindow, screen } from 'electron'

import { computeDockFrame, expandedSessionWidth, type DockFrame } from '../../shared/dock'

/**
 * Session windows live in their own persistent session partition so the
 * network can be blocked and the artifact:// scheme served there without
 * touching the host app's default session.
 */
export const DOCK_SESSION_PARTITION = 'persist:dock-session'

const dirname = path.dirname(fileURLToPath(import.meta.url))
/** electron-vite serves the renderers here in dev; file:// loads in prod. */
const RENDERER_DEV_URL = process.env.ELECTRON_RENDERER_URL

function preloadPath(name: 'dock' | 'session' | 'settings'): string {
  return path.join(dirname, `../preload/${name}.js`)
}

function loadRenderer(win: BrowserWindow, page: 'dock' | 'session' | 'settings'): void {
  if (RENDERER_DEV_URL) {
    void win.loadURL(`${RENDERER_DEV_URL}/${page}/index.html`)
  } else {
    void win.loadFile(path.join(dirname, `../renderer/${page}/index.html`))
  }
}

export function dockFrameFor(slotCount: number): DockFrame {
  // workArea already excludes the menu bar and the system Dock on whichever
  // edge it lives, so we never need to move the user's Dock out of the way.
  return computeDockFrame(screen.getPrimaryDisplay().workArea, slotCount)
}

export function createDockWindow(slotCount: number): BrowserWindow {
  const frame = dockFrameFor(slotCount)

  const win = new BrowserWindow({
    ...frame,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
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
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  loadRenderer(win, 'dock')
  win.once('ready-to-show', () => win.showInactive())

  return win
}

export function repositionDock(win: BrowserWindow | null, slotCount: number): void {
  if (!win || win.isDestroyed()) return
  win.setBounds(dockFrameFor(slotCount))
}

let cascade = 0

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
    minWidth: 420,
    minHeight: 380,
    frame: false,
    roundedCorners: true,
    backgroundColor: '#1a1917',
    show: false,
    title: 'Dock Session',
    webPreferences: {
      preload: preloadPath('session'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: DOCK_SESSION_PARTITION,
      additionalArguments: [`--cd-slot=${slotIndex}`, `--cd-folder=${encodeURIComponent(folder)}`],
    },
  })

  loadRenderer(win, 'session')
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  // Surface warnings/errors from the renderer AND anything framed inside it
  // (artifact pages). Without this, a crashed artifact script is invisible.
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      console.log(`[dock session ${slotIndex} console] ${event.message} (${event.sourceId ?? ''})`)
    }
  })

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
