/**
 * Preload for dock session (chat) windows. Exposes `window.session`.
 */
import { contextBridge, ipcRenderer } from 'electron'

import type { ApprovalDecision, ApprovalPayload, ArtifactPayload, EvidenceResult, KeyStatePayload, OutputsPayload, ProjectEditResult, ProjectResumeState, SessionBridge, SessionCompatibilityState, SessionDonePayload, SessionEntry, SessionInitPayload, ShareArtifactResult, SourceActionNotice, SourcesPayload, TerminalPresentationPayload, ToolResultPayload, ToolStartPayload, TurnReviewPayload } from '../shared/dock'
import type { SourceDocumentPreviewResult } from '../shared/dockSourcePreview'
import { DockSessionIpcChannel, DockWinIpcChannel } from '../shared/dockChannels'

function arg(name: string, fallback = ''): string {
  const prefix = `--cd-${name}=`
  const found = process.argv.find((a) => a.startsWith(prefix))
  return found ? found.slice(prefix.length) : fallback
}

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

// No slot index here: main resolves the slot from the sending window, so the
// window stays wired to its session when slots to its left are closed.
const session = {
  folder: decodeURIComponent(arg('folder', '')),

  init: (): Promise<SessionInitPayload | null> => ipcRenderer.invoke(DockSessionIpcChannel.Init),
  prompt: (text: string): void => ipcRenderer.send(DockSessionIpcChannel.Prompt, text),
  stop: (): void => ipcRenderer.send(DockSessionIpcChannel.Stop),
  addReferenceDocument: (): void => ipcRenderer.send(DockSessionIpcChannel.AddReferenceDocument),
  addSource: (): void => ipcRenderer.send(DockSessionIpcChannel.AddReferenceDocument),
  refreshSources: (): void => ipcRenderer.send(DockSessionIpcChannel.RefreshSources),
  retrySources: (): void => ipcRenderer.send(DockSessionIpcChannel.RetrySources),
  previewSource: (relativePath: string): Promise<SourceDocumentPreviewResult> =>
    ipcRenderer.invoke(DockSessionIpcChannel.PreviewSource, relativePath),
  closeInspector: (): void => ipcRenderer.send(DockSessionIpcChannel.CloseInspector),
  openSourceLink: (url: string): void => ipcRenderer.send(DockSessionIpcChannel.OpenSourceLink, url),
  dismissSourceNotice: (): void => ipcRenderer.send(DockSessionIpcChannel.DismissSourceNotice),
  checkForUpdates: (): void => ipcRenderer.send(DockSessionIpcChannel.CheckForUpdates),
  openSettings: (): void => ipcRenderer.send(DockSessionIpcChannel.OpenSettings),
  revealFolder: (): void => ipcRenderer.send(DockSessionIpcChannel.RevealFolder),
  openLoreSource: (threadId: string, blockId: string | null): void =>
    ipcRenderer.send(DockSessionIpcChannel.OpenLoreSource, threadId, blockId),
  closeArtifact: (): void => ipcRenderer.send(DockSessionIpcChannel.CloseArtifact),
  selectOutput: (path: string): Promise<void> => ipcRenderer.invoke(DockSessionIpcChannel.SelectOutput, path),
  demoteOutput: (path: string, demoted: boolean): Promise<void> => ipcRenderer.invoke(DockSessionIpcChannel.DemoteOutput, path, demoted),
  saveOutputCopy: (path: string): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke(DockSessionIpcChannel.SaveOutputCopy, path),
  shareArtifact: (): Promise<ShareArtifactResult> => ipcRenderer.invoke(DockSessionIpcChannel.ShareArtifact),
  decideApproval: (effectId: string, decision: ApprovalDecision): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(DockSessionIpcChannel.DecideApproval, effectId, decision),
  fetchEvidence: (bundleId: string): Promise<EvidenceResult> => ipcRenderer.invoke(DockSessionIpcChannel.FetchEvidence, bundleId),
  shareEvidence: (bundleId: string): Promise<EvidenceResult> =>
    ipcRenderer.invoke(DockSessionIpcChannel.ShareEvidence, bundleId),

  onAssistantStart: (cb: () => void) => on(DockSessionIpcChannel.AssistantStart, cb),
  onProgress: (cb: (phase: 'connecting' | 'thinking' | 'responding') => void) => on(DockSessionIpcChannel.Progress, cb),
  onText: (cb: (delta: string) => void) => on(DockSessionIpcChannel.Text, cb),
  onTool: (cb: (call: ToolStartPayload) => void) => on(DockSessionIpcChannel.Tool, cb),
  onToolResult: (cb: (r: ToolResultPayload) => void) => on(DockSessionIpcChannel.ToolResult, cb),
  onTerminal: (cb: (presentation: TerminalPresentationPayload) => void) => on(DockSessionIpcChannel.Terminal, cb),
  onEntry: (cb: (entry: SessionEntry) => void) => on(DockSessionIpcChannel.Entry, cb),
  onDone: (cb: (done: SessionDonePayload) => void) => on(DockSessionIpcChannel.Done, cb),
  onArtifact: (cb: (a: ArtifactPayload | null) => void) => on(DockSessionIpcChannel.Artifact, cb),
  onOutputs: (cb: (payload: OutputsPayload) => void) => on(DockSessionIpcChannel.Outputs, cb),
  onSources: (cb: (payload: SourcesPayload) => void) => on(DockSessionIpcChannel.Sources, cb),
  onSourceNotice: (cb: (notice: SourceActionNotice) => void) => on(DockSessionIpcChannel.SourceNotice, cb),
  onKeyState: (cb: (s: KeyStatePayload) => void) => on(DockSessionIpcChannel.KeyState, cb),
  onCompatibility: (cb: (s: SessionCompatibilityState) => void) => on(DockSessionIpcChannel.Compatibility, cb),
  onApprovals: (cb: (items: ApprovalPayload[]) => void) => on(DockSessionIpcChannel.Approvals, cb),
  onEvidenceAnnotations: (cb: (items: Array<{ toolCallId: string; bundleId: string }>) => void) =>
    on(DockSessionIpcChannel.EvidenceAnnotations, cb),
  onReviews: (cb: (items: TurnReviewPayload[]) => void) => on(DockSessionIpcChannel.Reviews, cb),
  onResume: (cb: (state: ProjectResumeState) => void) => on(DockSessionIpcChannel.Resume, cb),
  refreshResume: (): Promise<ProjectResumeState | null> => ipcRenderer.invoke(DockSessionIpcChannel.RefreshResume),
  updateObjective: (revision: number, objective: string, acceptSuggestion: boolean): Promise<ProjectEditResult> => ipcRenderer.invoke(DockSessionIpcChannel.UpdateObjective, revision, objective, acceptSuggestion),
  updateNextStep: (revision: number, nextStep: string | null): Promise<ProjectEditResult> => ipcRenderer.invoke(DockSessionIpcChannel.UpdateNextStep, revision, nextStep),
  previewResumeSource: (sourceId: string): Promise<boolean> => ipcRenderer.invoke(DockSessionIpcChannel.PreviewResumeSource, sourceId),

  minimizeWindow: (): void => ipcRenderer.send(DockWinIpcChannel.Minimize),
  closeWindow: (): void => ipcRenderer.send(DockWinIpcChannel.Close),
  zoomWindow: (): void => ipcRenderer.send(DockWinIpcChannel.Zoom),
} satisfies SessionBridge

contextBridge.exposeInMainWorld('session', session)
