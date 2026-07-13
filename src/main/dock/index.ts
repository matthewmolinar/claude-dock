/**
 * The dock widget controller — the Lore-desktop embedding of claude-dock.
 *
 * Owns the dock strip window, the settings window, the session manager, IPC
 * registration, and the four global shortcuts. Ported from the non-lifecycle
 * half of claude-dock `src/main/index.js`; app lifecycle (single-instance
 * lock, window-all-closed, before-quit) stays owned by `src/main/index.ts`,
 * which calls `registerDockWidget()` / `disposeDockWidget()`.
 *
 * The dock is hidden by default and toggled via the View menu or ⌘⌥T;
 * visibility persists across launches in dock-state.json.
 */
import os from 'node:os'
import path from 'node:path'

import {
  BrowserWindow,
  app,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'

import { LAYOUT } from '../../shared/dock'
import { DockIpcChannel, DockSessionIpcChannel, DockSettingsIpcChannel, DockWinIpcChannel } from '../../shared/dockChannels'
import { KeyStore } from './keystore'
import { SessionManager, type TranscriptMirror } from './sessionManager'
import { DockStore } from './store'
import { createDockWindow, createSessionWindow, createSettingsWindow, repositionDock } from './windows'

const HOTKEYS = {
  toggle: 'Command+Alt+T',
  newSession: 'Command+Alt+N',
  minimizeAll: 'Command+Alt+M',
  reloadDock: 'Command+Alt+R',
} as const

let dockWin: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let sessions: SessionManager | null = null
let store: DockStore | null = null
let keyStore: KeyStore | null = null
let refreshMenu: (() => void) | null = null
/** First-run nudge: open Settings once when the dock is shown with no key. */
let promptedForKey = false

function pushState(): void {
  if (dockWin && !dockWin.isDestroyed() && sessions) {
    dockWin.webContents.send(DockIpcChannel.State, sessions.snapshot())
  }
}

function syncDockSize(): void {
  if (sessions) repositionDock(dockWin, sessions.slotCount)
}

export function isDockVisible(): boolean {
  return Boolean(dockWin && !dockWin.isDestroyed() && dockWin.isVisible())
}

function setVisibilityPersisted(visible: boolean): void {
  store?.set({ dockVisible: visible })
  refreshMenu?.()
}

export function showDock(): void {
  if (!sessions) return
  if (!dockWin || dockWin.isDestroyed()) {
    dockWin = createDockWindow(sessions.slotCount)
    dockWin.on('closed', () => {
      dockWin = null
    })
  } else {
    dockWin.showInactive()
  }
  setVisibilityPersisted(true)

  if (keyStore && !keyStore.has() && !promptedForKey) {
    promptedForKey = true
    setTimeout(openSettings, 700)
  }
}

export function hideDock(): void {
  if (dockWin && !dockWin.isDestroyed()) dockWin.hide()
  setVisibilityPersisted(false)
}

export function toggleDock(): void {
  if (isDockVisible()) hideDock()
  else showDock()
}

function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus()
    return
  }
  settingsWin = createSettingsWindow()
  settingsWin.on('closed', () => {
    settingsWin = null
  })
}

async function chooseFolder(): Promise<string | null> {
  const res = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: os.homedir(),
    title: 'Choose a folder for this session',
    buttonLabel: 'Use this folder',
  })
  return res.canceled ? null : res.filePaths[0]
}

/**
 * Open a slot. A new session starts in the home folder — no picker. `reselect`
 * (shift-click) is the only path that asks.
 */
async function openSlot(index: number, { reselect = false } = {}): Promise<void> {
  if (!sessions) return

  if (reselect) {
    const folder = await chooseFolder()
    if (!folder) return
    sessions.activate(index, { folder })
    return
  }
  sessions.activate(index)
}

function newSession(): void {
  if (!sessions) return
  showDock()
  const index = sessions.addSlot()
  if (index === null) return
  syncDockSize()
  void openSlot(index)
}

// ---------------------------------------------------------------------------
// IPC — renderers are untrusted by construction (contextIsolation), so every
// handler validates its slot index before touching state.
// ---------------------------------------------------------------------------

function validIndex(i: unknown): i is number {
  return Boolean(sessions) && Number.isInteger(i) && (i as number) >= 0 && (i as number) < sessions!.slotCount
}

function registerDockIpc(): void {
  // --- dock strip -----------------------------------------------------------

  ipcMain.handle(DockIpcChannel.Init, () => ({
    layout: LAYOUT,
    state: sessions!.snapshot(),
  }))

  ipcMain.on(DockIpcChannel.SlotActivate, (_e: IpcMainEvent, index: unknown) => {
    if (validIndex(index)) void openSlot(index)
  })

  ipcMain.on(DockIpcChannel.SlotActivateIn, (_e: IpcMainEvent, index: unknown) => {
    if (validIndex(index)) void openSlot(index, { reselect: true })
  })

  ipcMain.on(DockIpcChannel.SlotClose, (_e: IpcMainEvent, index: unknown) => {
    if (validIndex(index)) sessions!.closeSlot(index)
  })

  ipcMain.on(DockIpcChannel.SlotMinimize, (_e: IpcMainEvent, index: unknown) => {
    if (validIndex(index)) sessions!.minimizeSlot(index)
  })

  ipcMain.on(DockIpcChannel.SlotRename, (_e: IpcMainEvent, index: unknown, name: unknown) => {
    if (validIndex(index) && typeof name === 'string') {
      sessions!.rename(index, name)
    }
  })

  // The dock is a non-activating window, so it cannot host a text caret.
  // Flip focusability for the duration of an inline rename, then flip back.
  ipcMain.on(DockIpcChannel.SetFocusable, (_e: IpcMainEvent, focusable: unknown) => {
    if (!dockWin || dockWin.isDestroyed()) return
    dockWin.setFocusable(Boolean(focusable))
    if (focusable) dockWin.focus()
  })

  ipcMain.on(DockIpcChannel.AddSlot, () => {
    const index = sessions!.addSlot()
    if (index === null) return
    syncDockSize()
    void openSlot(index)
  })

  ipcMain.on(DockIpcChannel.MinimizeAll, () => sessions!.minimizeAll())
  ipcMain.on(DockIpcChannel.OpenSettings, openSettings)

  // --- session window -------------------------------------------------------

  ipcMain.handle(DockSessionIpcChannel.Init, (_e: IpcMainInvokeEvent, index: unknown) =>
    validIndex(index) ? sessions!.sessionState(index) : null,
  )

  ipcMain.on(DockSessionIpcChannel.Prompt, (_e: IpcMainEvent, index: unknown, text: unknown) => {
    if (validIndex(index) && typeof text === 'string') void sessions!.prompt(index, text)
  })

  ipcMain.on(DockSessionIpcChannel.Stop, (_e: IpcMainEvent, index: unknown) => {
    if (validIndex(index)) sessions!.stop(index)
  })

  ipcMain.on(DockSessionIpcChannel.OpenSettings, openSettings)

  ipcMain.on(DockSessionIpcChannel.RevealFolder, (_e: IpcMainEvent, index: unknown) => {
    if (!validIndex(index)) return
    const folder = sessions!.slotFolder(index)
    if (folder) void shell.openPath(folder)
  })

  // --- settings ---------------------------------------------------------------

  ipcMain.handle(DockSettingsIpcChannel.Init, () => ({ hasKey: keyStore!.has() }))

  /**
   * A key change has to reach two places: agents built with the old key are
   * discarded, and every open session window updates its "add a key" banner.
   */
  function onKeyChanged(): void {
    sessions!.resetAgents()
    sessions!.broadcast(DockSessionIpcChannel.KeyState, { hasKey: keyStore!.has() })
  }

  ipcMain.handle(DockSettingsIpcChannel.SaveKey, (_e: IpcMainInvokeEvent, key: unknown) => {
    if (typeof key !== 'string') return { ok: false }
    try {
      keyStore!.set(key)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    onKeyChanged()
    return { ok: true, hasKey: keyStore!.has() }
  })

  ipcMain.handle(DockSettingsIpcChannel.ClearKey, () => {
    keyStore!.clear()
    onKeyChanged()
    return { ok: true, hasKey: false }
  })

  ipcMain.on(DockSettingsIpcChannel.OpenConsole, () => {
    void shell.openExternal('https://console.anthropic.com/settings/keys')
  })

  // --- shared window chrome ---------------------------------------------------

  const winFor = (event: IpcMainEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender)
  ipcMain.on(DockWinIpcChannel.Minimize, (e: IpcMainEvent) => winFor(e)?.minimize())
  ipcMain.on(DockWinIpcChannel.Close, (e: IpcMainEvent) => winFor(e)?.close())
  ipcMain.on(DockWinIpcChannel.Zoom, (e: IpcMainEvent) => {
    const w = winFor(e)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
}

function registerDockHotkeys(): void {
  const bind = (accel: string, fn: () => void): void => {
    if (!globalShortcut.register(accel, fn)) {
      console.warn(`[dock] hotkey already taken: ${accel}`)
    }
  }
  bind(HOTKEYS.toggle, toggleDock)
  bind(HOTKEYS.newSession, newSession)
  bind(HOTKEYS.minimizeAll, () => sessions?.minimizeAll())
  bind(HOTKEYS.reloadDock, () => {
    if (dockWin && !dockWin.isDestroyed()) dockWin.reload()
  })
}

/** Dock entries for the app's View menu; rebuilt on every menu refresh. */
export function buildDockMenuItems(): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Show Dock',
      type: 'checkbox',
      checked: isDockVisible(),
      accelerator: 'Alt+Cmd+T',
      // Registered as a global shortcut too; the menu item is the
      // discoverable path. registerAccelerator:false avoids double-firing.
      registerAccelerator: false,
      click: toggleDock,
    },
    {
      label: 'New Dock Session',
      accelerator: 'Alt+Cmd+N',
      registerAccelerator: false,
      click: newSession,
    },
    {
      label: 'Hide All Dock Sessions',
      accelerator: 'Alt+Cmd+M',
      registerAccelerator: false,
      click: () => sessions?.minimizeAll(),
    },
  ]
}

export interface RegisterDockWidgetOptions {
  /** Called whenever dock visibility changes so the menu checkbox stays true. */
  refreshMenu?: () => void
  /** Optional host hook: mirror each conversation (see `TranscriptMirror`). */
  createTranscriptMirror?: (cwd: string) => TranscriptMirror
}

export function registerDockWidget(options: RegisterDockWidgetOptions = {}): void {
  refreshMenu = options.refreshMenu ?? null

  const userData = app.getPath('userData')
  store = new DockStore(path.join(userData, 'dock-state.json'))
  keyStore = new KeyStore(path.join(userData, 'dock-credentials.json'))
  sessions = new SessionManager({
    store,
    keyStore,
    createSessionWindow,
    createTranscriptMirror: options.createTranscriptMirror,
  })
  sessions.on('changed', pushState)

  registerDockIpc()
  registerDockHotkeys()

  screen.on('display-metrics-changed', syncDockSize)
  screen.on('display-added', syncDockSize)
  screen.on('display-removed', syncDockSize)

  // Restore last-run visibility (hidden by default).
  if (store.get().dockVisible) showDock()
}

export function disposeDockWidget(): void {
  // Only the dock's own accelerators — never unregisterAll, other subsystems
  // may register their own shortcuts someday.
  for (const accel of Object.values(HOTKEYS)) globalShortcut.unregister(accel)
  sessions?.disposeAll()
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.destroy()
  if (dockWin && !dockWin.isDestroyed()) dockWin.destroy()
  store?.save()
}
