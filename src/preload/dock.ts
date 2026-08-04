/**
 * Preload for the dock strip window. Exposes `window.dock` — deliberately a
 * separate bridge from `window.lore`, which is injected into the remote
 * hosted app and must never see the dock IPC surface.
 */
import { contextBridge, ipcRenderer } from 'electron'

import { AmbientIpcChannel, type AmbientChip, type DockAmbientBridge } from '../shared/ambient'
import { AudioIpcChannel, type AudioLoopState, type MicBridge } from '../shared/audio'
import type { DockBridge, DockInitPayload, DockPresentation, DockSnapshot, SlotCardsSnapshot } from '../shared/dock'
import { DockIpcChannel } from '../shared/dockChannels'

const dock = {
  init: (): Promise<DockInitPayload> => ipcRenderer.invoke(DockIpcChannel.Init),
  onState: (cb: (state: DockSnapshot) => void): (() => void) => {
    const handler = (_e: unknown, state: DockSnapshot): void => cb(state)
    ipcRenderer.on(DockIpcChannel.State, handler)
    return () => ipcRenderer.removeListener(DockIpcChannel.State, handler)
  },

  activate: (index: number): void => ipcRenderer.send(DockIpcChannel.SlotActivate, index),
  activateIn: (index: number): void => ipcRenderer.send(DockIpcChannel.SlotActivateIn, index),
  close: (index: number): void => ipcRenderer.send(DockIpcChannel.SlotClose, index),
  minimize: (index: number): void => ipcRenderer.send(DockIpcChannel.SlotMinimize, index),
  rename: (index: number, name: string): void => ipcRenderer.send(DockIpcChannel.SlotRename, index, name),

  setFocusable: (focusable: boolean): void => ipcRenderer.send(DockIpcChannel.SetFocusable, focusable),
  addSlot: (): void => ipcRenderer.send(DockIpcChannel.AddSlot),
  minimizeAll: (): void => ipcRenderer.send(DockIpcChannel.MinimizeAll),
  dismiss: (): void => ipcRenderer.send(DockIpcChannel.Dismiss),
  openSettings: (): void => ipcRenderer.send(DockIpcChannel.OpenSettings),
  openQuests: (): void => ipcRenderer.send(DockIpcChannel.OpenQuests),
  openMacDockPicker: (): void => ipcRenderer.send(DockIpcChannel.MoveMacDock),

  onSlotCards: (cb: (cards: SlotCardsSnapshot) => void): (() => void) => {
    const handler = (_e: unknown, cards: SlotCardsSnapshot): void => cb(cards)
    ipcRenderer.on(DockIpcChannel.SlotCards, handler)
    return () => ipcRenderer.removeListener(DockIpcChannel.SlotCards, handler)
  },
  moveSlotCard: (itemId: string, fromIndex: number, toIndex: number): Promise<boolean> =>
    ipcRenderer.invoke(DockIpcChannel.MoveSlotCard, itemId, fromIndex, toIndex),
  activateSlotCard: (itemId: string): void =>
    ipcRenderer.send(DockIpcChannel.ActivateSlotCard, itemId),
  setShelfOpen: (open: boolean): void => ipcRenderer.send(DockIpcChannel.SetShelf, open),
  setExpanded: (expanded: boolean): void => ipcRenderer.send(DockIpcChannel.SetExpanded, expanded),
  setPinned: (pinned: boolean): void => ipcRenderer.send(DockIpcChannel.SetPinned, pinned),
  onPresentation: (cb: (presentation: DockPresentation) => void): (() => void) => {
    const handler = (_e: unknown, presentation: DockPresentation): void => cb(presentation)
    ipcRenderer.on(DockIpcChannel.Presentation, handler)
    return () => ipcRenderer.removeListener(DockIpcChannel.Presentation, handler)
  },
  onWindowMove: (cb: (moving: boolean) => void): (() => void) => {
    const handler = (_e: unknown, moving: boolean): void => cb(moving)
    ipcRenderer.on(DockIpcChannel.WindowMove, handler)
    return () => ipcRenderer.removeListener(DockIpcChannel.WindowMove, handler)
  },
} satisfies DockBridge

contextBridge.exposeInMainWorld('dock', dock)

// The background agent's dev-panel button lives in the dock strip; its IPC
// is a separate bridge so the dock surface stays untangled from it.
const dockAmbient = {
  openPanel: (): void => ipcRenderer.send(AmbientIpcChannel.OpenPanel),
} satisfies DockAmbientBridge

contextBridge.exposeInMainWorld('dockAmbient', dockAmbient)

// The strip's push-to-talk mic button (the add button's left-side mirror).
// Hold-state up to the audio loop, recording state + input levels back down,
// and the background agent's chip pushes (the orb's gold mood). Hosts without
// an audio loop set `micButton: false` and the renderer skips the button.
const mic = {
  getState: (): Promise<AudioLoopState> => ipcRenderer.invoke(AudioIpcChannel.GetState),
  setPtt: (active: boolean): Promise<AudioLoopState> =>
    ipcRenderer.invoke(AudioIpcChannel.SetPtt, active),
  onState: (cb: (state: AudioLoopState) => void): void => {
    ipcRenderer.on(AudioIpcChannel.StateChanged, (_e, state: AudioLoopState) => cb(state))
  },
  onLevel: (cb: (level: number) => void): void => {
    ipcRenderer.on(AudioIpcChannel.Level, (_e, level: number) => cb(level))
  },
  onAgentChip: (cb: (chip: AmbientChip | null) => void): void => {
    ipcRenderer.on(AmbientIpcChannel.Chip, (_e, chip: AmbientChip | null) => cb(chip))
  },
} satisfies MicBridge

contextBridge.exposeInMainWorld('loreMic', mic)
