/**
 * Preload for the dock settings window (Anthropic API key entry).
 * Exposes `window.settings`.
 */
import { contextBridge, ipcRenderer } from 'electron'

import type { SaveKeyResult, SettingsBridge, SettingsInitPayload } from '../shared/dock'
import { DockSettingsIpcChannel, DockWinIpcChannel } from '../shared/dockChannels'

const settings = {
  init: (): Promise<SettingsInitPayload> => ipcRenderer.invoke(DockSettingsIpcChannel.Init),
  saveKey: (key: string): Promise<SaveKeyResult> =>
    ipcRenderer.invoke(DockSettingsIpcChannel.SaveKey, key),
  clearKey: (): Promise<SaveKeyResult> => ipcRenderer.invoke(DockSettingsIpcChannel.ClearKey),
  openConsole: (): void => ipcRenderer.send(DockSettingsIpcChannel.OpenConsole),
  close: (): void => ipcRenderer.send(DockWinIpcChannel.Close),
} satisfies SettingsBridge

contextBridge.exposeInMainWorld('settings', settings)
