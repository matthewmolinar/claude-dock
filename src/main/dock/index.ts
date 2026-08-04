/**
 * The dock widget controller — the Lore-desktop embedding of claude-dock.
 *
 * Owns the in-app and floating dock strips, the settings window, the session
 * manager, IPC registration, and the global shortcuts. Ported from the
 * non-lifecycle half of claude-dock `src/main/index.js`; app lifecycle (single-instance
 * lock, window-all-closed, before-quit) stays owned by `src/main/index.ts`,
 * which calls `registerDockWidget()` / `disposeDockWidget()`.
 *
 * The in-app strip follows the main Lore window. The optional global strip is
 * hidden by default and toggled via the View menu, ⌘⌥T, or its ✕; floating
 * visibility persists across launches in dock-state.json.
 */
import os from 'node:os'
import path from 'node:path'

import {
  BrowserWindow,
  app,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'

import { isTypeId, LAYOUT, type EmbeddedInsets, type FetchMirroredOutputHook, type MirrorOutputHook, type SessionPlacement, type SetOutputDemotedHook, type SlotCardsSnapshot } from '../../shared/dock'
import { DockIpcChannel, DockMacDockIpcChannel, DockSessionIpcChannel, DockSettingsIpcChannel, DockWinIpcChannel } from '../../shared/dockChannels'
import { installArtifactHandler, registerArtifactScheme } from './artifactProtocol'
import { KeyStore } from './keystore'
import type { HostTool } from './harness/agent'
import { dockLog, setDockLogger, type DockLogger } from './log'
import { readMacDockOrientation, setMacDockOrientation } from './macDock'
import { MAC_DOCK_ORIENTATIONS, type MacDockOrientation } from '../../shared/dockMacDock'
import type { SourceDocumentPreviewResult } from '../../shared/dockSourcePreview'
import { addReferenceDocumentsForSender } from './referenceDocumentControl'
import { SessionManager, type ModelAccess, type SessionBackend, type SlotIngestOutcome, type TranscriptMirror } from './sessionManager'
import { DockStore } from './store'
import { dockTrack, setDockTelemetry, type DockTelemetry } from './telemetry'
import { DOCK_SESSION_PARTITION, createDockWindow, createInAppDockWindow, createMacDockWindow, createSessionWindow, createSettingsWindow, createWorkbenchSessionWindow, effectiveDockLayout, repositionDock, repositionInAppDock, resizeForArtifact, resizeForShelf, setDockExpanded, setDockMicEnabled, setInAppDockInsets } from './windows'

const HOTKEYS = {
  toggle: 'Command+Alt+T',
  newSession: 'Command+Alt+N',
  minimizeAll: 'Command+Alt+M',
  reloadDock: 'Command+Alt+R',
  // Original claude-dock (Swift era): move the *system* macOS Dock out of
  // the strip's way.
  macDockLeft: 'Command+Alt+L',
  macDockBottom: 'Command+Alt+B',
} as const

let dockWin: BrowserWindow | null = null
let inAppDockWin: BrowserWindow | null = null
let inAppDockParent: BrowserWindow | null = null
let inAppShelfOpen = false
let inAppDockShouldBeVisible = false
let renamingWin: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let macDockWin: BrowserWindow | null = null
let sessions: SessionManager | null = null
let store: DockStore | null = null
let keyStore: KeyStore | null = null
let refreshMenu: (() => void) | null = null
let restoreHostFocus: (() => void) | null = null
/** Optional host callback invoked when the strip's quests button is clicked. */
let openQuestsCb: (() => void) | null = null
let shareArtifactHook: ShareArtifactHook | null = null
let openLoreSourceHook: OpenLoreSourceHook | null = null
let checkForUpdatesHook: ((parentWindow: BrowserWindow) => void) | null = null
/** Optional host hook: copy a picked file into a slot's source directory (see `IngestSourceHook`). */
let ingestSourceHook: IngestSourceHook | null = null
let previewSourceHook: PreviewSourceHook | null = null
/** First-run nudge: open Settings once when the dock is shown with no key. */
let promptedForKey = false
let dockMoveTimer: NodeJS.Timeout | null = null
let dockMoving = false
/** True when the host injected `modelAccess` — key settings then don't gate use. */
let hostOwnsModelAccess = false
/** Optional host hook feeding the strip's per-slot card shelf. */
let slotCardsHook: SlotCardsHostHook | null = null
/** Last cards pushed to the renderer — replayed in the Init payload. */
let lastSlotCards: SlotCardsSnapshot = []
let slotCardsRefreshInFlight = false
let slotCardsRefreshQueued = false
let dockExpanded = false
/** Host chrome insets used to place sessions launched from the Workbench. */
let embeddedInsets: EmbeddedInsets = { top: 0, left: 0 }

/** What the slot-cards hook receives to identify a slot. */
export interface SlotCardsSlotRef {
  index: number
  /** The slot's stable conversation id (mirror session), when one exists. */
  sessionId: string | null
  folder: string | null
}

/**
 * Optional host hook: per-slot cards for the strip's hover shelf. The dock
 * renders whatever the host provides and reports interactions back — it never
 * learns what the cards mean. See `SlotCardItem` in `shared/dock.ts`.
 */
export interface SlotCardsHostHook {
  /** Cards per slot, indexed like the given slot refs. */
  provide(slots: ReadonlyArray<SlotCardsSlotRef>): Promise<SlotCardsSnapshot>
  /** Move a card between slots. Resolve false to refuse (the UI reverts). */
  onMove?(itemId: string, from: SlotCardsSlotRef, to: SlotCardsSlotRef): Promise<boolean>
  /** A card was clicked. */
  onActivate?(itemId: string): void
}

function pushState(): void {
  if (!sessions) return
  const snapshot = sessions.snapshot()
  for (const win of dockWindows()) win.webContents.send(DockIpcChannel.State, snapshot)
}

function dockWindows(): BrowserWindow[] {
  return [dockWin, inAppDockWin].filter(
    (win): win is BrowserWindow => Boolean(win && !win.isDestroyed()),
  )
}

function renameInProgress(): boolean {
  return Boolean(renamingWin && !renamingWin.isDestroyed())
}

function indexForSender(sender: WebContents): number {
  return sessions?.indexForSender(sender) ?? -1
}

async function addReferenceDocumentForSender(sender: WebContents): Promise<void> {
  const ingest = ingestSourceHook
  const parent = BrowserWindow.fromWebContents(sender)
  if (!ingest || !parent) return
  await addReferenceDocumentsForSender({
    sender,
    indexForSender,
    pick: () => dialog.showOpenDialog(parent, {
      title: 'Add a reference document',
      buttonLabel: 'Add document',
      properties: ['openFile', 'multiSelections'],
      filters: [{
        name: 'Reference documents',
        extensions: ingest.extensions.map((ext) => ext.replace(/^\./, '')),
      }],
    }),
    ingest: (index, sourcePath) => sessions!.ingestSource(index, sourcePath, ingest.ingest),
  })
}

/** Application-menu entry point: focus chooses the sender once, before the picker opens. */
export function addSourceForFocusedSession(): void {
  const focused = BrowserWindow.getFocusedWindow()
  if (!focused) return
  void addReferenceDocumentForSender(focused.webContents)
    .catch(() => dockLog.warn('reference_document_add_failed'))
}

export function isSafeExternalSourceUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return ['https:', 'http:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

/**
 * Re-pull cards from the host hook and push them to the strip. Hosts call
 * this when their card data changes (same posture as refreshDockModelAccess);
 * the controller also calls it on every slot change. Serialized with a
 * trailing re-run so bursts collapse instead of interleaving.
 */
export function refreshDockSlotCards(): void {
  void runSlotCardsRefresh()
}

async function runSlotCardsRefresh(): Promise<void> {
  if (!sessions || !slotCardsHook) return
  if (slotCardsRefreshInFlight) {
    slotCardsRefreshQueued = true
    return
  }
  slotCardsRefreshInFlight = true
  try {
    const cards = await slotCardsHook.provide(sessions.cardSlots())
    // Normalize to the slot count so the renderer can index fearlessly.
    lastSlotCards = Array.from({ length: sessions.slotCount }, (_, i) => cards[i] ?? [])
    for (const win of dockWindows()) {
      win.webContents.send(DockIpcChannel.SlotCards, lastSlotCards)
    }
  } catch (err) {
    dockLog.warn('slot_cards_provide_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    slotCardsRefreshInFlight = false
    if (slotCardsRefreshQueued) {
      slotCardsRefreshQueued = false
      void runSlotCardsRefresh()
    }
  }
}

function syncDockSize(): void {
  if (!sessions) return
  repositionDock(dockWin, sessions.slotCount)
  repositionInAppDock(inAppDockWin, inAppDockParent, sessions.slotCount, inAppShelfOpen)
  persistDockPosition()
}

/** Show the functional Workbench inside the main Lore window. */
export function showInAppDock(parent: BrowserWindow): void {
  if (!sessions) return
  inAppDockShouldBeVisible = true
  if (!inAppDockWin || inAppDockWin.isDestroyed() || inAppDockParent !== parent) {
    if (inAppDockWin && !inAppDockWin.isDestroyed()) inAppDockWin.destroy()
    inAppDockParent = parent
    inAppShelfOpen = false
    const win = createInAppDockWindow(parent, sessions.slotCount)
    inAppDockWin = win
    win.once('ready-to-show', () => {
      if (inAppDockWin !== win || !inAppDockShouldBeVisible || win.isDestroyed()) return
      win.setHasShadow(false)
      win.showInactive()
    })
    win.on('closed', () => {
      if (inAppDockWin !== win) return
      inAppDockWin = null
      inAppDockParent = null
      inAppShelfOpen = false
    })
    return
  }
  repositionInAppDock(inAppDockWin, parent, sessions.slotCount, inAppShelfOpen)
  inAppDockWin.showInactive()
}

/** Hide the in-app strip when leaving the Workbench tab or entering onboarding. */
export function hideInAppDock(): void {
  inAppDockShouldBeVisible = false
  if (inAppDockWin && !inAppDockWin.isDestroyed()) inAppDockWin.hide()
}

/** Re-anchor the in-app surface after the main Lore window moves or resizes. */
export function layoutInAppDock(): void {
  if (!sessions) return
  repositionInAppDock(inAppDockWin, inAppDockParent, sessions.slotCount, inAppShelfOpen)
}

function persistDockPosition(): void {
  if (!dockWin || dockWin.isDestroyed()) return
  const { x, y } = dockWin.getBounds()
  if (store?.get().dockPinned) store.set({ dockPosition: { x, y } })
  else if (!dockExpanded) store?.set({ dockHandlePosition: { x, y } })
}

function settleDockPosition(): void {
  if (dockMoveTimer) {
    clearTimeout(dockMoveTimer)
    dockMoveTimer = null
  }
  if (!sessions || !dockWin || dockWin.isDestroyed()) return
  repositionDock(dockWin, sessions.slotCount)
  persistDockPosition()
  if (dockMoving) {
    dockMoving = false
    dockWin.webContents.send(DockIpcChannel.WindowMove, false)
  }
}

function scheduleDockPositionSettle(): void {
  if (dockMoveTimer) clearTimeout(dockMoveTimer)
  dockMoveTimer = setTimeout(settleDockPosition, 250)
  dockMoveTimer.unref?.()
}

export function isDockVisible(): boolean {
  return Boolean(dockWin && !dockWin.isDestroyed() && dockWin.isVisible())
}

function setVisibilityPersisted(visible: boolean): void {
  store?.set({ dockVisible: visible })
  refreshMenu?.()
}

// The dock always presents as the full, open strip — never the compact edge
// handle — so both the expanded and pinned states are hardwired on. Callers
// still pass their (now-ignored) intent so the IPC surface stays unchanged.
function applyDockPresentation(_expanded = true, _pinned = true): void {
  // Settle a just-dragged frame before re-affirming the open presentation.
  if (!dockExpanded) settleDockPosition()
  dockExpanded = true
  if (sessions) setDockExpanded(dockWin, true, sessions.slotCount)
  if (dockWin && !dockWin.isDestroyed()) {
    dockWin.webContents.send(DockIpcChannel.Presentation, { expanded: true, pinned: true })
  }
}

/** `trigger` says what surfaced the dock (hotkey, menu, host UI, …). */
export function showDock(trigger = 'unknown'): void {
  if (!sessions) return
  const wasVisible = isDockVisible()
  if (!dockWin || dockWin.isDestroyed()) {
    // Always open: normalize any legacy persisted preference so existing
    // installs open as the full strip too, and so drag positions persist to
    // dockPosition rather than the (now-unused) handle anchor.
    const saved = store?.get()
    // A legacy compact-mode install's truthful recent placement is its handle,
    // not a possibly-null-or-stale pinned dockPosition. Prefer the handle in
    // that case (pass no expanded position); createDockWindow then anchors the
    // strip to the handle's location and monitor.
    const openedFromCompact = saved ? !saved.dockPinned : false
    if (openedFromCompact) store?.set({ dockPinned: true })
    dockExpanded = true
    dockWin = createDockWindow(
      sessions.slotCount,
      openedFromCompact ? null : (saved?.dockPosition ?? null),
      true,
      saved?.dockHandlePosition ?? null,
    )
    const notifyWindowMove = (): void => {
      if (dockMoving) return
      dockMoving = true
      dockWin?.webContents.send(DockIpcChannel.WindowMove, true)
    }
    dockWin.on('will-move', notifyWindowMove)
    dockWin.on('move', () => {
      notifyWindowMove()
      scheduleDockPositionSettle()
    })
    dockWin.on('closed', () => {
      if (dockMoveTimer) clearTimeout(dockMoveTimer)
      dockMoveTimer = null
      dockMoving = false
      dockWin = null
    })
  } else {
    dockWin.showInactive()
  }
  setVisibilityPersisted(true)
  if (!wasVisible) dockTrack('opened', { trigger })

  if (keyStore && !keyStore.has() && !promptedForKey && !hostOwnsModelAccess) {
    promptedForKey = true
    setTimeout(openSettings, 700)
  }
}

export function hideDock(trigger = 'unknown'): void {
  if (isDockVisible()) dockTrack('dismissed', { trigger })
  if (dockWin && !dockWin.isDestroyed()) {
    settleDockPosition()
    dockWin.hide()
  }
  setVisibilityPersisted(false)
}

export function toggleDock(trigger = 'unknown'): void {
  if (isDockVisible()) hideDock(trigger)
  else showDock(trigger)
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

function openMacDockPicker(): void {
  if (macDockWin && !macDockWin.isDestroyed()) {
    macDockWin.focus()
    return
  }
  macDockWin = createMacDockWindow()
  macDockWin.on('closed', () => {
    macDockWin = null
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
 * (shift-click) is the only path that asks. `placement` follows the strip that
 * asked: the in-app strip initially places the detached window in the
 * Workbench content region; everything else opens a display-centered window.
 */
async function openSlot(
  index: number,
  { reselect = false, placement = 'floating' as SessionPlacement } = {},
): Promise<void> {
  if (!sessions) return

  if (reselect) {
    const folder = await chooseFolder()
    if (!folder) return
    sessions.activate(index, { folder, placement })
  } else {
    sessions.activate(index, { placement })
  }
}

/** Which placement a strip renderer's request implies. */
function senderPlacement(event: IpcMainEvent): SessionPlacement {
  return event.sender === inAppDockWin?.webContents ? 'embedded' : 'floating'
}

function newSession(): void {
  if (!sessions) return
  if (renameInProgress()) return
  showDock('new_session')
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

  ipcMain.handle(DockIpcChannel.Init, (event: IpcMainInvokeEvent) => ({
    layout: effectiveDockLayout(),
    state: sessions!.snapshot(),
    cards: lastSlotCards,
    settingsHidden: hostOwnsModelAccess,
    // The dock is always the full, open strip — never the compact handle.
    presentation: { expanded: true, pinned: true },
    surface: event.sender === inAppDockWin?.webContents ? 'in-app' : 'floating',
  }))

  ipcMain.on(DockIpcChannel.SlotActivate, (e: IpcMainEvent, index: unknown) => {
    if (validIndex(index)) void openSlot(index, { placement: senderPlacement(e) })
  })

  ipcMain.on(DockIpcChannel.SlotActivateIn, (e: IpcMainEvent, index: unknown) => {
    if (validIndex(index)) void openSlot(index, { reselect: true, placement: senderPlacement(e) })
  })

  ipcMain.on(DockIpcChannel.SlotClose, (_e: IpcMainEvent, index: unknown) => {
    // Closing a slot removes its card, so the strip needs re-sizing too.
    if (!renameInProgress() && validIndex(index) && sessions!.closeSlot(index)) syncDockSize()
  })

  ipcMain.on(DockIpcChannel.SlotMinimize, (_e: IpcMainEvent, index: unknown) => {
    if (validIndex(index)) sessions!.minimizeSlot(index)
  })

  ipcMain.on(DockIpcChannel.SlotRename, (_e: IpcMainEvent, index: unknown, name: unknown) => {
    if (validIndex(index) && typeof name === 'string') {
      sessions!.rename(index, name)
    }
  })

  // Both strips are normally non-activating. Temporarily enable focus for an
  // inline rename, then return it to the hosted app for the in-app surface.
  ipcMain.on(DockIpcChannel.SetFocusable, (event: IpcMainEvent, focusable: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    if (focusable) {
      if (renameInProgress() && renamingWin !== win) return
      renamingWin = win
      win.setFocusable(true)
      win.focus()
      return
    }
    if (renamingWin === win) renamingWin = null
    win.setFocusable(false)
    if (win === inAppDockWin) restoreHostFocus?.()
  })

  ipcMain.on(DockIpcChannel.AddSlot, (e: IpcMainEvent) => {
    if (renameInProgress()) return
    const index = sessions!.addSlot()
    if (index === null) return
    syncDockSize()
    void openSlot(index, { placement: senderPlacement(e) })
  })

  ipcMain.on(DockIpcChannel.MinimizeAll, () => sessions!.minimizeAll())

  // The strip's ✕: one click makes every piece of dock UI disappear. Sessions
  // keep running; ⌘⌥T (or View → Show Dock) brings the strip back.
  ipcMain.on(DockIpcChannel.Dismiss, (event: IpcMainEvent) => {
    if (event.sender === inAppDockWin?.webContents) return
    sessions!.minimizeAll()
    hideDock('strip')
  })

  ipcMain.on(DockIpcChannel.OpenSettings, openSettings)

  // The strip's quests button only emits intent; the host (if any) owns what
  // opening quests means. The standalone OSS dock injects no callback, so this
  // is a no-op there — keeping this controller host-agnostic.
  ipcMain.on(DockIpcChannel.OpenQuests, () => openQuestsCb?.())

  // --- slot cards (host-fed hover shelf) -------------------------------------

  ipcMain.handle(DockIpcChannel.MoveSlotCard, async (_e, itemId: unknown, from: unknown, to: unknown) => {
    if (
      !slotCardsHook?.onMove ||
      typeof itemId !== 'string' ||
      !validIndex(from) ||
      !validIndex(to) ||
      from === to
    ) {
      return false
    }
    const slots = sessions!.cardSlots()
    try {
      const moved = await slotCardsHook.onMove(itemId, slots[from], slots[to])
      refreshDockSlotCards()
      return moved
    } catch (err) {
      dockLog.warn('slot_card_move_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      refreshDockSlotCards()
      return false
    }
  })

  ipcMain.on(DockIpcChannel.ActivateSlotCard, (_e: IpcMainEvent, itemId: unknown) => {
    if (typeof itemId === 'string') slotCardsHook?.onActivate?.(itemId)
  })

  ipcMain.on(DockIpcChannel.SetShelf, (event: IpcMainEvent, open: unknown) => {
    if (!sessions) return
    if (event.sender === inAppDockWin?.webContents) {
      inAppShelfOpen = Boolean(open)
      repositionInAppDock(inAppDockWin, inAppDockParent, sessions.slotCount, inAppShelfOpen)
      return
    }
    resizeForShelf(dockWin, Boolean(open), LAYOUT.shelfHeight, sessions.slotCount)
  })

  ipcMain.on(DockIpcChannel.SetExpanded, (event: IpcMainEvent, expanded: unknown) => {
    if (event.sender === inAppDockWin?.webContents) return
    applyDockPresentation(Boolean(expanded))
  })

  ipcMain.on(DockIpcChannel.SetPinned, (event: IpcMainEvent) => {
    if (event.sender === inAppDockWin?.webContents) return
    // The dock is always open; there is no unpin. Keep the persisted flag
    // consistent and re-affirm the open presentation.
    store?.set({ dockPinned: true })
    applyDockPresentation()
    persistDockPosition()
  })

  ipcMain.on(DockIpcChannel.MoveMacDock, openMacDockPicker)

  ipcMain.handle(DockMacDockIpcChannel.Init, async () => ({
    orientation: await readMacDockOrientation(),
  }))

  ipcMain.handle(DockMacDockIpcChannel.Set, (_e: IpcMainInvokeEvent, orientation: unknown) => {
    if (!(MAC_DOCK_ORIENTATIONS as readonly unknown[]).includes(orientation)) {
      return { ok: false, message: 'Unknown Dock position.' }
    }
    return setMacDockOrientation(orientation as MacDockOrientation)
  })

  // --- session window -------------------------------------------------------
  // A session window's slot is resolved from the sender, never from a
  // renderer-supplied index: closing a slot shifts the indices of every slot
  // to its right, but the windows (and their preloads) live on.

  const senderIndex = (e: IpcMainEvent | IpcMainInvokeEvent): number => indexForSender(e.sender)

  ipcMain.handle(DockSessionIpcChannel.Init, async (e: IpcMainInvokeEvent) => {
    const index = senderIndex(e)
    if (index === -1) return null
    await sessions!.refreshEvidence(index)
    const state = sessions!.sessionState(index)
    e.sender.send(DockSessionIpcChannel.Outputs, sessions!.outputsPayload(index))
    void sessions!.refreshApprovals(index)
    return state ? {
      ...state,
      sources: sessions!.sourcesPayload(index),
      canAddReferenceDocument: Boolean(ingestSourceHook),
      canPreviewReferenceDocuments: Boolean(previewSourceHook),
    } : null
  })

  ipcMain.handle(DockSessionIpcChannel.RefreshResume, (e: IpcMainInvokeEvent) => {
    const index = senderIndex(e)
    return index === -1 ? null : sessions!.refreshResume(index)
  })
  ipcMain.handle(DockSessionIpcChannel.UpdateObjective, (e: IpcMainInvokeEvent, revision: unknown, objective: unknown, accept: unknown) => {
    const index = senderIndex(e)
    if (index === -1 || !Number.isSafeInteger(revision) || typeof objective !== 'string' || typeof accept !== 'boolean') return { ok: false, message: 'Invalid objective edit.' }
    return sessions!.updateObjective(index, revision as number, objective, accept)
  })
  ipcMain.handle(DockSessionIpcChannel.UpdateNextStep, (e: IpcMainInvokeEvent, revision: unknown, nextStep: unknown) => {
    const index = senderIndex(e)
    if (index === -1 || !Number.isSafeInteger(revision) || (nextStep !== null && typeof nextStep !== 'string')) return { ok: false, message: 'Invalid next-step edit.' }
    return sessions!.updateNextStep(index, revision as number, nextStep as string | null)
  })
  ipcMain.handle(DockSessionIpcChannel.PreviewResumeSource, (e: IpcMainInvokeEvent, sourceId: unknown) => {
    const index = senderIndex(e)
    return index !== -1 && typeof sourceId === 'string' && sessions!.previewResumeSource(index, sourceId)
  })

  ipcMain.on(DockSessionIpcChannel.Prompt, (e: IpcMainEvent, text: unknown) => {
    const index = senderIndex(e)
    if (index !== -1 && typeof text === 'string') void sessions!.prompt(index, text)
  })

  ipcMain.on(DockSessionIpcChannel.Stop, (e: IpcMainEvent) => {
    const index = senderIndex(e)
    if (index !== -1) sessions!.stop(index)
  })

  ipcMain.on(DockSessionIpcChannel.AddReferenceDocument, (e: IpcMainEvent) => {
    void addReferenceDocumentForSender(e.sender).catch(() => dockLog.warn('reference_document_add_failed'))
  })

  ipcMain.on(DockSessionIpcChannel.RefreshSources, (e: IpcMainEvent) => {
    const index = senderIndex(e)
    if (index !== -1) void sessions!.refreshSources(index)
  })

  ipcMain.on(DockSessionIpcChannel.RetrySources, (e: IpcMainEvent) => {
    const index = senderIndex(e)
    if (index !== -1) void sessions!.retrySources(index)
  })

  ipcMain.handle(DockSessionIpcChannel.PreviewSource, async (e: IpcMainInvokeEvent, relativePath: unknown) => {
    const index = senderIndex(e)
    if (index === -1 || typeof relativePath !== 'string' || !previewSourceHook) {
      return { ok: false, reason: 'not_allowed', message: 'This reference document is unavailable.' }
    }
    const result = await sessions!.previewSource(index, relativePath, previewSourceHook.preview)
    // Re-resolve after the async file read: a closed/rebound sender must not
    // open an inspector in whichever Slot later occupies its former index.
    const currentIndex = senderIndex(e)
    if (result.ok && currentIndex !== -1) sessions!.openSourceInspector(currentIndex)
    return result
  })

  ipcMain.on(DockSessionIpcChannel.CloseInspector, (e: IpcMainEvent) => {
    const index = senderIndex(e)
    if (index !== -1) sessions!.closeSourceInspector(index)
  })

  ipcMain.on(DockSessionIpcChannel.OpenSourceLink, (e: IpcMainEvent, url: unknown) => {
    if (senderIndex(e) !== -1 && isSafeExternalSourceUrl(url)) void shell.openExternal(url)
  })

  ipcMain.on(DockSessionIpcChannel.DismissSourceNotice, (e: IpcMainEvent) => {
    const index = senderIndex(e)
    if (index !== -1) sessions!.dismissSourceNotice(index)
  })

  ipcMain.on(DockSessionIpcChannel.CheckForUpdates, (e: IpcMainEvent) => {
    // Trust only a live session sender and derive its parent in main. The
    // renderer cannot choose a slot or BrowserWindow for this host action.
    if (senderIndex(e) === -1 || !checkForUpdatesHook) return
    const parentWindow = BrowserWindow.fromWebContents(e.sender)
    if (parentWindow) checkForUpdatesHook(parentWindow)
  })

  ipcMain.handle(DockSessionIpcChannel.DecideApproval, (e: IpcMainInvokeEvent, effectId: unknown, decision: unknown) => {
    const index = senderIndex(e)
    if (index === -1 || !isTypeId(effectId, 'dfx') || !['grant_once', 'grant_prefix', 'deny'].includes(String(decision))) {
      return { ok: false, message: 'Invalid approval decision.' }
    }
    return sessions!.decideApproval(index, effectId, decision as 'grant_once' | 'grant_prefix' | 'deny')
  })

  ipcMain.handle(DockSessionIpcChannel.FetchEvidence, (e: IpcMainInvokeEvent, bundleId: unknown) => {
    if (senderIndex(e) === -1 || !isTypeId(bundleId, 'evb')) return { status: 'failure', message: 'Invalid Evidence request.' }
    return sessions!.fetchEvidence(bundleId)
  })
  ipcMain.handle(DockSessionIpcChannel.ShareEvidence, (e: IpcMainInvokeEvent, bundleId: unknown) => {
    if (senderIndex(e) === -1 || !isTypeId(bundleId, 'evb')) return { status: 'failure', message: 'Invalid Evidence share request.' }
    return sessions!.shareEvidence(bundleId)
  })

  ipcMain.on(DockSessionIpcChannel.OpenSettings, openSettings)

  ipcMain.on(DockSessionIpcChannel.RevealFolder, (e: IpcMainEvent) => {
    const index = senderIndex(e)
    if (index === -1) return
    const folder = sessions!.slotFolder(index)
    if (folder) void shell.openPath(folder)
  })

  ipcMain.on(DockSessionIpcChannel.OpenLoreSource, (e: IpcMainEvent, threadId: unknown, blockId: unknown) => {
    if (senderIndex(e) === -1 || !openLoreSourceHook) return
    if (typeof threadId !== 'string' || !/^th_[0-9A-Za-z]{1,64}$/.test(threadId)) return
    if (blockId !== null && (typeof blockId !== 'string' || !/^[0-9A-Za-z_-]{1,128}$/.test(blockId))) return
    openLoreSourceHook({ threadId, blockId })
  })

  ipcMain.on(DockSessionIpcChannel.CloseArtifact, (e: IpcMainEvent) => {
    const index = senderIndex(e)
    if (index !== -1) sessions!.closeArtifact(index)
  })

  ipcMain.handle(DockSessionIpcChannel.SelectOutput, (e: IpcMainInvokeEvent, outputPath: unknown) => {
    const index = senderIndex(e)
    if (index !== -1 && typeof outputPath === 'string') sessions!.selectOutput(index, outputPath)
  })

  ipcMain.handle(DockSessionIpcChannel.DemoteOutput, (e: IpcMainInvokeEvent, outputPath: unknown, demoted: unknown) => {
    const index = senderIndex(e)
    if (index !== -1 && typeof outputPath === 'string' && typeof demoted === 'boolean') sessions!.setSlotOutputDemoted(index, outputPath, demoted)
  })

  ipcMain.handle(DockSessionIpcChannel.SaveOutputCopy, async (e: IpcMainInvokeEvent, outputPath: unknown) => {
    const index = senderIndex(e)
    if (index === -1 || typeof outputPath !== 'string') return { ok: false, message: 'This output is unavailable.' }
    const parent = BrowserWindow.fromWebContents(e.sender)
    const saveOptions = { defaultPath: path.basename(outputPath) }
    const result = parent
      ? await dialog.showSaveDialog(parent, saveOptions)
      : await dialog.showSaveDialog(saveOptions)
    if (result.canceled || !result.filePath) return { ok: false, message: 'Save canceled.' }
    return sessions!.saveOutputCopy(index, outputPath, result.filePath)
  })

  ipcMain.handle(DockSessionIpcChannel.ShareArtifact, async (e: IpcMainInvokeEvent) => {
    const index = senderIndex(e)
    const info = index === -1 ? null : sessions!.artifactShareInfo(index)
    if (!shareArtifactHook || !info) return { ok: false, message: 'Nothing to share.' }
    if (!info.sessionId) return { ok: false, message: 'This session is not synced to Lore.' }
    try {
      const { webUrl } = await shareArtifactHook({
        file: info.file,
        fileName: info.fileName,
        sessionId: info.sessionId,
      })
      clipboard.writeText(webUrl)
      dockTrack('artifact_shared')
      return { ok: true, url: webUrl }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      dockLog.warn('artifact_share_failed', { message })
      return { ok: false, message }
    }
  })

  // --- settings ---------------------------------------------------------------

  ipcMain.handle(DockSettingsIpcChannel.Init, () => ({ hasKey: keyStore!.has() }))

  /**
   * A key change has to reach two places: agents built with the old key are
   * discarded, and every open session window updates its "add a key" banner.
   */
  function onKeyChanged(): void {
    refreshDockModelAccess()
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
  ipcMain.on(DockWinIpcChannel.Minimize, (e: IpcMainEvent) => {
    const index = senderIndex(e)
    if (index >= 0) sessions!.minimizeSlot(index)
  })
  ipcMain.on(DockWinIpcChannel.Close, (e: IpcMainEvent) => {
    const index = senderIndex(e)
    if (index >= 0) {
      sessions!.minimizeSlot(index)
      return
    }
    winFor(e)?.close()
  })
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
      dockLog.warn('hotkey_taken', { accelerator: accel })
    }
  }
  bind(HOTKEYS.toggle, () => toggleDock('hotkey'))
  bind(HOTKEYS.newSession, newSession)
  bind(HOTKEYS.minimizeAll, () => sessions?.minimizeAll())
  bind(HOTKEYS.reloadDock, () => {
    for (const win of dockWindows()) win.reload()
  })
  bind(HOTKEYS.macDockLeft, () => void setMacDockOrientation('left'))
  bind(HOTKEYS.macDockBottom, () => void setMacDockOrientation('bottom'))
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
      click: () => toggleDock('menu'),
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

/**
 * Optional host hook: copy a user-picked file into a slot's source
 * directory (TAN-5456 Task 9). The actual filesystem copy is Lore-specific
 * (`src/main/dockSourceIngest.ts`, outside this OSS-synced surface), so this
 * controller only ever calls `ingest` a host supplies — it never imports
 * that module itself. Resolves with a user-presentable failure message
 * rather than throwing, so `SessionManager.ingestSource` can report it into
 * the transcript uniformly.
 *
 * `extensions` is the host's supported-format allowlist
 * (leading-dot, e.g. `.md`), carried alongside `ingest` so the native file
 * picker can filter by format at pick time instead of the user only learning
 * a format is unsupported after choosing it. It lives here, not as an
 * `@lore/contracts` import, because `dock/**` may not import that package —
 * the host attaches its own copy, the same way it already supplies `ingest`
 * rather than this module importing `dockSourceIngest.ts`.
 */
export interface IngestSourceHook {
  ingest(args: { folder: string; sourcePath: string }): Promise<SlotIngestOutcome>
  extensions: readonly string[]
}

export interface PreviewSourceHook {
  preview(args: { sessionFolder: string; relativePath: string; allowedRelativePaths: ReadonlySet<string> }): Promise<SourceDocumentPreviewResult>
}

/**
 * Optional host hook: publish a shown artifact file to Lore and return its
 * shareable web URL. `sessionId` is an opaque host-owned identity that lets
 * the host resolve the session's thread.
 * Throw with a user-presentable message on failure.
 */
export type ShareArtifactHook = (args: {
  file: string
  fileName: string
  sessionId: string
}) => Promise<{ webUrl: string }>

export type OpenLoreSourceHook = (source: { threadId: string; blockId: string | null }) => void

export interface RegisterDockWidgetOptions {
  /** Called whenever dock visibility changes so the menu checkbox stays true. */
  refreshMenu?: () => void
  /** Return keyboard focus to the host after editing in the in-app strip. */
  restoreHostFocus?: () => void
  /**
   * Optional host hook: invoked when the strip's quests button is clicked. The
   * standalone OSS dock injects nothing (the button then does nothing); a host
   * opens its own quests surface. Kept a bare callback so this controller never
   * imports anything host-specific.
   */
  openQuests?: () => void
  /** Optional host hook: publish a shown artifact to Lore (see `ShareArtifactHook`). */
  shareArtifact?: ShareArtifactHook
  /** Optional host hook: mirror durable outputs without blocking a turn. */
  mirrorOutput?: MirrorOutputHook
  /** Optional host hook: retrieve a mirrored output after its local file is gone. */
  fetchMirroredOutput?: FetchMirroredOutputHook
  /** Optional host hook: persist local output removal/restoration. */
  setOutputDemoted?: SetOutputDemotedHook
  /** Optional host hook: navigate to a viewer-authorized Ask citation. */
  openLoreSource?: OpenLoreSourceHook
  /**
   * Optional host hook: copy a user-picked file into a slot's source
   * directory (see `IngestSourceHook`). Without one the session composer's
   * add-reference control stays hidden — the standalone
   * OSS lore-workbench build never wires one.
   */
  ingestSource?: IngestSourceHook
  /** Optional host hook for inventory-confined document previews. */
  previewSource?: PreviewSourceHook
  /** Optional host-owned update flow, parented to the trusted session sender. */
  checkForUpdates?: (parentWindow: BrowserWindow) => void
  /** Optional host hook: mirror each conversation (see `TranscriptMirror`). */
  createTranscriptMirror?: (cwd: string, resumeSessionId?: string) => TranscriptMirror
  /** Optional host hook: extra agent tools, one fresh set per agent (see `HostTool`). */
  createHostTools?: () => HostTool[]
  /**
   * Optional host hook: replace keystore/BYOK model access (see `ModelAccess`).
   * When provided the first-run "add a key" settings nudge is skipped and the
   * host is expected to call `refreshDockModelAccess()` when availability flips.
   */
  modelAccess?: ModelAccess
  /**
   * Optional host hook: run turns on a server backend instead of the local
   * agent loop (see `SessionBackend` in sessionManager).
   */
  backend?: SessionBackend
  /**
   * Optional host hook: per-slot cards for the strip's hover shelf. The host
   * calls `refreshDockSlotCards()` whenever its card data changes.
   */
  slotCards?: SlotCardsHostHook
  /**
   * Host chrome a Workbench-launched session's initial frame must stay clear
   * of (app bar height, sidebar width).
   */
  embeddedSessionInsets?: EmbeddedInsets
  /**
   * Optional host hook: reserve the strip's left end (the add button's
   * left-side mirror) for a push-to-talk mic control. The dock only sizes and
   * renders the button; the host's own preload/IPC (`window.loreMic`) drive
   * its state, and the renderer skips the button when that bridge is absent.
   */
  micButton?: boolean
  /** Optional host logger; without one, dock events go to the console. */
  logger?: DockLogger
  /**
   * Optional host telemetry sink for product analytics (see `DockTelemetry`).
   * Without one every emit is a no-op — the standalone app has no analytics.
   */
  telemetry?: DockTelemetry
}

/**
 * Re-broadcast model-access state to open session windows and drop agents
 * built on stale access. Hosts call this when their access source changes
 * (e.g. the Lore session signs in or out); the keystore path calls it via
 * `onKeyChanged` internally.
 */
export function refreshDockModelAccess(): void {
  if (!sessions) return
  sessions.refreshPrivateReviewAccess()
  sessions.resetAgents()
  sessions.broadcast(DockSessionIpcChannel.KeyState, sessions.keyState())
}

/**
 * Privileged schemes must be declared before the app is ready — hosts call
 * this at module scope, then `registerDockWidget()` from whenReady.
 */
export function registerDockProtocolSchemes(): void {
  registerArtifactScheme()
}

export function registerDockWidget(options: RegisterDockWidgetOptions = {}): void {
  refreshMenu = options.refreshMenu ?? null
  restoreHostFocus = options.restoreHostFocus ?? null
  openQuestsCb = options.openQuests ?? null
  slotCardsHook = options.slotCards ?? null
  shareArtifactHook = options.shareArtifact ?? null
  openLoreSourceHook = options.openLoreSource ?? null
  checkForUpdatesHook = options.checkForUpdates ?? null
  ingestSourceHook = options.ingestSource ?? null
  previewSourceHook = options.previewSource ?? null
  if (options.logger) setDockLogger(options.logger)
  setDockTelemetry(options.telemetry ?? null)
  setDockMicEnabled(Boolean(options.micButton))
  embeddedInsets = options.embeddedSessionInsets ?? { top: 0, left: 0 }
  setInAppDockInsets(embeddedInsets)

  // Session windows (and anything framed inside them, like artifact pages)
  // never need the network; the agent's API traffic lives in the main
  // process. Cancel everything in their partition so a model-authored
  // artifact page cannot send data anywhere. In dev the window's own
  // document comes from the electron-vite dev server, so that one origin
  // stays reachable.
  const rendererDevHost = process.env.ELECTRON_RENDERER_URL
    ? new URL(process.env.ELECTRON_RENDERER_URL).host
    : null
  const dockSession = session.fromPartition(DOCK_SESSION_PARTITION)
  dockSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      // host, not origin: the dev server speaks both http (modules) and ws (HMR).
      const allowed = rendererDevHost && new URL(details.url).host === rendererDevHost
      callback({ cancel: !allowed })
    },
  )
  installArtifactHandler(dockSession.protocol)

  const userData = app.getPath('userData')
  store = new DockStore(path.join(userData, 'dock-state.json'))
  keyStore = new KeyStore(path.join(userData, 'dock-credentials.json'))
  hostOwnsModelAccess = Boolean(options.modelAccess)
  sessions = new SessionManager({
    store,
    keyStore,
    modelAccess: options.modelAccess,
    backend: options.backend,
    mirrorOutput: options.mirrorOutput,
    fetchMirroredOutput: options.fetchMirroredOutput,
    setOutputDemoted: options.setOutputDemoted,
    createSessionWindow: (opts) => {
      if (opts.placement === 'embedded' && inAppDockParent && !inAppDockParent.isDestroyed()) {
        return createWorkbenchSessionWindow(inAppDockParent, embeddedInsets, opts)
      }
      return createSessionWindow(opts)
    },
    resizeForArtifact,
    createTranscriptMirror: options.createTranscriptMirror,
    createHostTools: options.createHostTools,
  })
  sessions.on('changed', pushState)
  // Slot changes (add/close/folder pick) can re-home cards; re-pull them.
  sessions.on('changed', refreshDockSlotCards)
  refreshDockSlotCards()

  registerDockIpc()
  registerDockHotkeys()

  screen.on('display-metrics-changed', syncDockSize)
  screen.on('display-added', syncDockSize)
  screen.on('display-removed', syncDockSize)

  // Restore last-run visibility (hidden by default).
  if (store.get().dockVisible) showDock('restore')
}

export function disposeDockWidget(): void {
  // Only the dock's own accelerators — never unregisterAll, other subsystems
  // may register their own shortcuts someday.
  for (const accel of Object.values(HOTKEYS)) globalShortcut.unregister(accel)
  screen.removeListener('display-metrics-changed', syncDockSize)
  screen.removeListener('display-added', syncDockSize)
  screen.removeListener('display-removed', syncDockSize)
  settleDockPosition()
  sessions?.disposeAll()
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.destroy()
  if (macDockWin && !macDockWin.isDestroyed()) macDockWin.destroy()
  if (inAppDockWin && !inAppDockWin.isDestroyed()) inAppDockWin.destroy()
  if (dockWin && !dockWin.isDestroyed()) dockWin.destroy()
  store?.save()
}
