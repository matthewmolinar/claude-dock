/**
 * Preload for dock session (chat) windows. Exposes `window.session`.
 */
import { contextBridge, ipcRenderer } from 'electron'

import type { ArtifactPayload, KeyStatePayload, SessionBridge, SessionEntry, SessionInitPayload, ToolResultPayload, ToolStartPayload } from '../shared/dock'
import { DockSessionIpcChannel, DockWinIpcChannel } from '../shared/dockChannels'

function arg(name: string, fallback = ''): string {
  const prefix = `--cd-${name}=`
  const found = process.argv.find((a) => a.startsWith(prefix))
  return found ? found.slice(prefix.length) : fallback
}

const slotIndex = Number(arg('slot', '0'))

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const session = {
  slotIndex,
  folder: decodeURIComponent(arg('folder', '')),

  init: (): Promise<SessionInitPayload | null> =>
    ipcRenderer.invoke(DockSessionIpcChannel.Init, slotIndex),
  prompt: (text: string): void => ipcRenderer.send(DockSessionIpcChannel.Prompt, slotIndex, text),
  stop: (): void => ipcRenderer.send(DockSessionIpcChannel.Stop, slotIndex),
  openSettings: (): void => ipcRenderer.send(DockSessionIpcChannel.OpenSettings),
  revealFolder: (): void => ipcRenderer.send(DockSessionIpcChannel.RevealFolder, slotIndex),
  closeArtifact: (): void => ipcRenderer.send(DockSessionIpcChannel.CloseArtifact, slotIndex),

  onAssistantStart: (cb: () => void) => on(DockSessionIpcChannel.AssistantStart, cb),
  onText: (cb: (delta: string) => void) => on(DockSessionIpcChannel.Text, cb),
  onTool: (cb: (call: ToolStartPayload) => void) => on(DockSessionIpcChannel.Tool, cb),
  onToolResult: (cb: (r: ToolResultPayload) => void) => on(DockSessionIpcChannel.ToolResult, cb),
  onEntry: (cb: (entry: SessionEntry) => void) => on(DockSessionIpcChannel.Entry, cb),
  onDone: (cb: () => void) => on(DockSessionIpcChannel.Done, cb),
  onArtifact: (cb: (a: ArtifactPayload | null) => void) => on(DockSessionIpcChannel.Artifact, cb),
  onKeyState: (cb: (s: KeyStatePayload) => void) => on(DockSessionIpcChannel.KeyState, cb),

  minimizeWindow: (): void => ipcRenderer.send(DockWinIpcChannel.Minimize),
  closeWindow: (): void => ipcRenderer.send(DockWinIpcChannel.Close),
  zoomWindow: (): void => ipcRenderer.send(DockWinIpcChannel.Zoom),
} satisfies SessionBridge

contextBridge.exposeInMainWorld('session', session)
