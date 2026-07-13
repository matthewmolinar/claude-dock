/**
 * Preload for the dock strip window. Exposes `window.dock` — deliberately a
 * separate bridge from `window.lore`, which is injected into the remote
 * hosted app and must never see the dock IPC surface.
 */
import { contextBridge, ipcRenderer } from 'electron'

import type { DockBridge, DockInitPayload, DockSnapshot } from '../shared/dock'
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
  openSettings: (): void => ipcRenderer.send(DockIpcChannel.OpenSettings),
} satisfies DockBridge

contextBridge.exposeInMainWorld('dock', dock)
