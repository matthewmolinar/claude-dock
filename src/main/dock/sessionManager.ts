/**
 * Dock slot/session state: which folder each slot points at, its chat window,
 * its agent, and the in-memory transcript that session windows replay on
 * (re)open. Ported from claude-dock `src/main/session-manager.js`.
 *
 * Host integration: each conversation can be mirrored through an injected
 * `TranscriptMirror` for a host that wants a Claude-Code-format JSONL copy of
 * the conversation (e.g. to feed an existing upload watch loop). The Lore
 * build no longer injects one — dock sessions run on the server-side actor
 * and are DB-native (see docs/dock/2026-07-15-server-side-actor-design.md).
 * The seam stays host-agnostic for the standalone/OSS surface, which may use
 * it; the standalone app currently injects nothing.
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import type { BrowserWindow, WebContents } from 'electron'

import { DockOutputMirrorError, slotLabel, STOPPED_TURN_NOTICE, type ApprovalDecision, type ApprovalPayload, type ArtifactPayload, type CitationSource, type DockSnapshot, type EvidenceResult, type FetchMirroredOutputHook, type MirrorOutputHook, type OutputsPayload, type ProjectEditResult, type ProjectResumeCache, type ProjectResumePayload, type ProjectResumeState, type RegisteredSlotSource, type ReviewResult, type SessionCompatibilityState, type SessionDonePayload, type SessionEntry, type SessionInitPayload, type SessionPlacement, type SetOutputDemotedHook, type SourceActionNotice, type SourcesPayload, type TranscriptTool, type TurnReviewPayload } from '../../shared/dock'
import { mergeSourceDocuments } from '../../shared/dockSources'
import type { SourceDocumentPreviewResult } from '../../shared/dockSourcePreview'
import type { EvidenceWorkbenchSummary } from '../../shared/dockHostTypes'
import { acknowledgeOutputDemotion, artifactAction, markOutputMirrored, recordOutput, setOutputDemoted, type SlotArtifact, type SlotOutput } from '../../shared/dockArtifact'
import { DockSessionIpcChannel } from '../../shared/dockChannels'
import { registerArtifact, unregisterArtifact } from './artifactProtocol'
import { Agent, type AgentDoneEvent, type AgentToolEvent, type AgentToolResultEvent, type HostTool } from './harness/agent'
import { resolveInRoot } from './harness/tools'
import { TransportError, createAnthropicTransport, type ModelTransport } from './harness/transport'
import type { KeyStore } from './keystore'
import { dockLog } from './log'
import type { DockStore, PendingSlotSource } from './store'
import { dockTrack } from './telemetry'

const MAX_SLOTS = 12
const SOURCES_CHANNEL = 'lore:dock-session:sources'
const SOURCE_NOTICE_CHANNEL = 'lore:dock-session:source-notice'

/** The default model access: local keystore + direct Anthropic (BYOK). */
function keystoreModelAccess(keyStore: KeyStore): ModelAccess {
  return {
    available: () => keyStore.has(),
    unavailableMessage: 'Add your Anthropic API key in Settings to get started.',
    createTransport: () => {
      const apiKey = keyStore.get()
      if (!apiKey) {
        throw new TransportError('Add your Anthropic API key in Settings to get started.')
      }
      return createAnthropicTransport(apiKey)
    },
  }
}

/**
 * Optional per-conversation mirror. The agent's verbatim Anthropic message
 * blocks are forwarded so a host can persist the conversation however it
 * likes (Lore writes Claude-Code-format JSONL for its upload pipeline).
 */
export interface TranscriptMirror {
  /** Stable conversation id; persisted so a relaunch appends to the same file. */
  readonly sessionId?: string
  appendUser(content: unknown): void
  appendAssistant(content: unknown[]): void
  appendToolResults(results: unknown[]): void
}

interface Slot {
  customName: string | null
  folder: string | null
  artifact: SlotArtifact | null
  outputs: SlotOutput[]
  firstPrompt: string | null
  agent: Agent | null
  mirror: TranscriptMirror | null
  /** Mirror session id persisted across relaunches so uploads stay one thread. */
  mirrorSessionId: string | null
  win: BrowserWindow | null
  /** Placement belongs to the live window and is not persisted across launches. */
  placement: SessionPlacement | null
  /** Whether the live window was deliberately hidden back into its Slot. */
  tucked: boolean
  /** Everything the session window needs to re-render after a reload. */
  transcript: SessionEntry[]
  reviews: Map<string, TurnReviewPayload['review']>
  reviewRequests: Map<string, number>
  /** Monotonic private-state lifetime; unlike request generations, never reset or reused. */
  reviewEpoch: number
  /**
   * The durable conversation. The agent is seeded with this exact array and
   * pushes into it, so persisting the slot always captures current history.
   */
  agentMessages: Agent['messages']
  /** The durable remote dock thread id when a `SessionBackend` runs this slot. */
  remoteThreadId: string | null
  projectCreationKey: string | null
  projectId: string | null
  projectResumeCache: ProjectResumeCache | null
  /**
   * Reference documents ingested while this Slot had no remote Thread yet,
   * so registration can be retried once one exists (TAN-5456 Task 9).
   */
  pendingSources: PendingSlotSource[]
  registeredSources: RegisteredSlotSource[]
  sourcesLoadState: SourcesPayload['loadState']
  sourcesRequest: number
  approvalRequest: number
  unavailableSources: Set<string>
  sourcePreviewRequest: number
  sourcePreviewRequests: Map<string, number>
  /** Current Sources UI error (`SourceActionNotice`), retained across renderer lifetimes. */
  sourceErrorNotice: SourceActionNotice | null
  inspectorMode: 'source' | 'output' | null
  /** Stable handle shared by the active prompt and a racing Stop request. */
  backendSlot: SessionBackendSlot | null
  /** Guards duplicate backend cancellation while the current turn settles. */
  remoteStopRequested: boolean
  /** Invalidates callbacks owned by a prior folder binding. */
  generation: number
  compatibility: SessionCompatibilityState | undefined
  compatibilityHandle: SessionBackendSlot | null
  busy: boolean
  hasNotification: boolean
}

/**
 * How agents reach a model. The default is the local keystore + direct
 * Anthropic (BYOK — the OSS app's only mode); a host can inject its own
 * (the Lore app routes turns through the Lore API on the user's session).
 */
export interface ModelAccess {
  /** Whether a transport can currently be built (drives the blocked banner). */
  available(): boolean
  /** Copy for the blocked banner and for prompt-time failures. */
  unavailableMessage: string
  /** Hide the banner's "Open Settings" action (key settings don't apply). */
  hidesSettingsAction?: boolean
  /** Build a transport for a new agent. Throw `TransportError` when unavailable. */
  createTransport(): ModelTransport
}

/**
 * The render primitives a turn drives, mapped 1:1 onto the session-window IPC
 * channels. The in-process `Agent` path drives these directly; a remote
 * `SessionBackend` drives them through a sink so both paths render identically.
 */
export interface SessionRenderSink {
  /** Replace the transient working label while no concrete output is visible. */
  progress(phase: 'connecting' | 'thinking' | 'responding'): void
  /** Append streamed assistant text to the current turn's bubble. */
  text(delta: string): void
  /** A tool call started; `label` is the human-readable activity chip. */
  tool(id: string, label: string, input: unknown, name?: string): void
  /** A tool call finished. */
  toolResult(id: string, ok: boolean, output: string): void
  /** Replace assistant prose for an authoritative terminal presentation. */
  terminal(text: string, sources?: CitationSource[]): void
  /** A turn-level error to surface in the transcript. */
  error(message: string): void
  /**
   * A turn-level statement that is not a failure — today only "this turn was
   * stopped". A cancelled turn ends wherever it happened to be, so without
   * this the transcript is byte-identical to one that ran to completion: the
   * work simply stops, and a stop between writing a file and showing it reads
   * as an artifact that was produced.
   */
  notice(message: string): void
  /**
   * What is durably known about the TASK, once the turn settles — the host's
   * `SessionTurnOutcome`, typed as `string` because a newer host may derive a
   * value this build cannot name (`describeTurnOutcome` decides what to show).
   * `reference` is a stable handle to the settled turn for a person to quote.
   * `detail` is the host's one line about what the turn changed, destined for
   * the layer below the headline — passed through untouched, because this
   * process has none of the evidence it was derived from and cannot check or
   * restate it. A host that derives none sends none, and a turn that changed
   * nothing legitimately has none.
   *
   * This is the `Done` channel's payload, which is why it does not push on
   * call: `Done` fires exactly once per turn from the turn's own teardown, and
   * a second push would be a second end. The primitive supplies what that one
   * push carries, so the 1:1 sink↔channel mapping holds — `Done` simply had no
   * primitive behind it before, and now it does. A backend that never calls
   * this leaves `Done` at `{}`, exactly as the local agent path pushes it.
   */
  outcome(outcome: string, reference?: string, detail?: string): void
  /** Invalidate ephemeral private review detail; the manager owns the refetch. */
  review?(promptBlockId: string): void
  /** Replace the approval controls currently associated with tool calls. */
  approvals?(items: ApprovalPayload[]): void
}

/**
 * The result of copying a user-picked file into a slot's source directory
 * (see `SessionManager.ingestSource`). Structurally identical to
 * `dockSourceIngest.ts`'s `IngestResult` (host-agnostic files must not
 * import that Lore-specific module), just narrowed to the two fields this
 * layer needs from a success and a single user-presentable failure message.
 */
export type SlotIngestOutcome =
  | { ok: true; relativePath: string; title: string }
  | { ok: false; message: string }

/** A slot handle the backend can read the folder from and cache its remote id on. */
export interface SessionBackendSlot {
  readonly folder: string
  /** Stable in-memory identity shared by every backend handle for this Slot. */
  readonly slotKey?: object
  /** The remote dock thread id, cached across prompts (null before the first). */
  remoteThreadId: string | null
  projectCreationKey?: string | null
  projectId?: string | null
  projectResumeCache?: ProjectResumeCache | null
  flushPersistence?(): void
  /**
   * Reference documents awaiting registry confirmation; the backend updates
   * their state while SessionManager owns presentation in the Sources UI.
   */
  pendingSources: PendingSlotSource[]
  sourceNotice?(notice: SourceActionNotice): void
  sourcesChanged?(registered: readonly PendingSlotSource[]): void
}

/**
 * Optional host backend that runs a slot's turns on a server instead of the
 * in-process `Agent`. When injected (the Lore build) `prompt()` delegates each
 * turn to `promptRemote`; when absent (OSS/BYOK lore-workbench) `prompt()` uses
 * the local `Agent` loop unchanged. The backend owns ensuring the remote
 * session + executor and rendering results back through the sink; resolving the
 * promise ends the turn.
 */
export interface SessionBackend {
  promptRemote(slot: SessionBackendSlot, text: string, sink: SessionRenderSink): Promise<void>
  ensureProject?(slot: SessionBackendSlot, objective: string): Promise<void>
  readProjectResume?(slot: SessionBackendSlot): Promise<ProjectResumePayload>
  updateProjectObjective?(slot: SessionBackendSlot, expectedRevision: number, objective: string, acceptSuggestion: boolean): Promise<void>
  updateProjectNextStep?(slot: SessionBackendSlot, expectedRevision: number, nextStep: string | null): Promise<void>
  /** Latest transient executor compatibility for this slot's remote thread. */
  compatibilityStatus?(slot: SessionBackendSlot): SessionCompatibilityState | undefined
  /** Observe real per-thread compatibility transitions. Returns an unsubscribe function. */
  onCompatibilityStatusChange?(
    listener: (slot: SessionBackendSlot, status: SessionCompatibilityState) => void,
  ): () => void
  /** Request cancellation while leaving promptRemote subscribed through terminal completion. */
  stopRemote?(slot: SessionBackendSlot): Promise<void>
  listApprovals?(slot: SessionBackendSlot): Promise<ApprovalPayload[]>
  decideApproval?(
    slot: SessionBackendSlot,
    effectId: string,
    decision: ApprovalDecision,
    sink: SessionRenderSink,
  ): Promise<BackendApprovalDecisionResult>
  listEvidence?(slot: SessionBackendSlot): Promise<EvidenceWorkbenchSummary[]>
  fetchEvidence?(bundleId: string): Promise<EvidenceResult>
  shareEvidence?(bundleId: string): Promise<EvidenceResult>
  fetchReview?(slot: SessionBackendSlot, promptBlockId: string): Promise<ReviewResult>
  /**
   * Register one ingested reference document against a remote Thread
   * (TAN-5456 Task 9). Throw with a user-presentable message on failure; a
   * host can distinguish "the Thread is gone, stop retrying" from any other
   * failure with its own error type (see `dockSourceIngest.ts`'s
   * `SourceNotFoundError`).
   */
  registerSource?(threadId: string, entry: PendingSlotSource): Promise<void>
  listSources?(slot: SessionBackendSlot): Promise<RegisteredSlotSource[]>
  /** Tear down any remote resources for a slot (folder re-point / close). */
  disposeSlot?(slot: SessionBackendSlot): void
}

export type BackendApprovalDecisionResult =
  | { ok: false; message?: string }
  | { ok: true; resumeTurn: (() => Promise<void>) | null }

export interface SessionManagerOptions {
  store: DockStore
  keyStore: KeyStore
  /** Optional host hook: replace keystore/BYOK model access entirely. */
  modelAccess?: ModelAccess
  /**
   * Optional host hook: run turns on a server backend instead of the local
   * `Agent` loop (the Lore cutover). When present, `prompt()` delegates to it.
   */
  backend?: SessionBackend
  createSessionWindow: (opts: { slotIndex: number; folder: string; placement: SessionPlacement }) => BrowserWindow
  /** Widen/restore a session window when its artifact pane opens/closes. */
  resizeForArtifact: (win: BrowserWindow | null, open: boolean) => void
  /**
   * Optional host hook: mirror each conversation (one mirror per agent).
   * `resumeSessionId` is set when a restored conversation continues after a
   * relaunch — the mirror should append to that session instead of a new one.
   */
  createTranscriptMirror?: (cwd: string, resumeSessionId?: string) => TranscriptMirror
  /**
   * Optional host hook: extra agent tools (one fresh set per agent, so a
   * tool can keep per-conversation state — see `HostTool` in harness/agent).
   */
  createHostTools?: () => HostTool[]
  mirrorOutput?: MirrorOutputHook
  fetchMirroredOutput?: FetchMirroredOutputHook
  setOutputDemoted?: SetOutputDemotedHook
}

export interface SessionActivation {
  placement: SessionPlacement
  window: BrowserWindow
}

export class SessionManager extends EventEmitter {
  private store: DockStore
  private keyStore: KeyStore
  private modelAccess: ModelAccess
  private backend?: SessionBackend
  private createSessionWindow: SessionManagerOptions['createSessionWindow']
  private resizeForArtifact: SessionManagerOptions['resizeForArtifact']
  private createTranscriptMirror?: SessionManagerOptions['createTranscriptMirror']
  private createHostTools?: () => HostTool[]
  private mirrorOutput?: MirrorOutputHook
  private fetchMirroredOutput?: FetchMirroredOutputHook
  private setOutputDemoted?: SetOutputDemotedHook
  private outputQueues = new WeakMap<Slot, Promise<void>>()
  private outputMirrorsInFlight = new WeakMap<Slot, Set<string>>()
  private outputMirrorIdentitiesPending = new WeakMap<Slot, Set<string>>()
  private outputMirrorIdentityRetriesRequested = new WeakMap<Slot, Set<string>>()
  private outputMirrorRetriesRequested = new WeakMap<Slot, Map<string, Array<{
    title: string; contentHash: string; bytes: Uint8Array; versionOrdinal: number; toolCallId?: string
  }>>>()
  private outputMirrorSuppressed = new WeakMap<Slot, string>()
  private outputDemotionsInFlight = new WeakMap<Slot, Set<string>>()
  private outputDemotionRetriesRequested = new WeakMap<Slot, Set<string>>()
  private unsubscribeCompatibility?: () => void
  private slots: Slot[] = []

  constructor({ store, keyStore, modelAccess, backend, createSessionWindow, resizeForArtifact, createTranscriptMirror, createHostTools, mirrorOutput, fetchMirroredOutput, setOutputDemoted }: SessionManagerOptions) {
    super()
    this.store = store
    this.keyStore = keyStore
    this.modelAccess = modelAccess ?? keystoreModelAccess(keyStore)
    this.backend = backend
    this.createSessionWindow = createSessionWindow
    this.resizeForArtifact = resizeForArtifact
    this.createTranscriptMirror = createTranscriptMirror
    this.createHostTools = createHostTools
    this.mirrorOutput = mirrorOutput
    this.fetchMirroredOutput = fetchMirroredOutput
    this.setOutputDemoted = setOutputDemoted

    const persisted = store.get()
    for (let i = 0; i < persisted.slotCount; i++) {
      const saved = persisted.slots[i]
      const slot = this.blankSlot(saved?.customName ?? null, saved?.folder ?? null, saved?.artifact ?? null)
      if (saved) {
        slot.outputs = saved.outputs ?? []
        slot.firstPrompt = saved.firstPrompt
        slot.transcript = saved.transcript
        slot.agentMessages = saved.agentMessages as Agent['messages']
        slot.mirrorSessionId = saved.mirrorSessionId
        slot.remoteThreadId = saved.remoteThreadId
        slot.projectCreationKey = saved.projectCreationKey ?? null
        slot.projectId = saved.projectId ?? null
        slot.projectResumeCache = saved.projectResumeCache ?? null
        // Older persisted state has no `pendingSources` at all — `store.ts`'s
        // `sanitize` already defaults it to `[]`, but a directly-constructed
        // `saved` (e.g. in a test) may still omit it.
        slot.pendingSources = saved.pendingSources ?? []
      }
      this.slots.push(slot)
    }
    if (backend?.onCompatibilityStatusChange) {
      this.unsubscribeCompatibility = backend.onCompatibilityStatusChange((backendSlot, status) => {
        const slot = this.slots.find((candidate) =>
          candidate.backendSlot === backendSlot
          || candidate.compatibilityHandle === backendSlot
          || Boolean(backendSlot.remoteThreadId && candidate.remoteThreadId === backendSlot.remoteThreadId),
        )
        if (!slot) return
        slot.compatibility = status
        this.pushWindow(slot, DockSessionIpcChannel.Compatibility, status)
      })
    }
    for (const slot of this.slots) this.refreshCompatibility(slot)
  }

  private blankSlot(
    customName: string | null = null,
    folder: string | null = null,
    artifact: SlotArtifact | null = null,
  ): Slot {
    return {
      customName,
      folder,
      artifact,
      outputs: [],
      firstPrompt: null,
      agent: null,
      mirror: null,
      mirrorSessionId: null,
      win: null,
      placement: null,
      tucked: false,
      transcript: [],
      reviews: new Map(),
      reviewRequests: new Map(),
      reviewEpoch: 0,
      agentMessages: [],
      remoteThreadId: null,
      projectCreationKey: null,
      projectId: null,
      projectResumeCache: null,
      pendingSources: [],
      registeredSources: [],
      sourcesLoadState: 'loaded',
      sourcesRequest: 0,
      approvalRequest: 0,
      unavailableSources: new Set(),
      sourcePreviewRequest: 0,
      sourcePreviewRequests: new Map(),
      sourceErrorNotice: null,
      inspectorMode: null,
      backendSlot: null,
      remoteStopRequested: false,
      generation: 0,
      compatibility: undefined,
      compatibilityHandle: null,
      busy: false,
      hasNotification: false,
    }
  }

  get slotCount(): number {
    return this.slots.length
  }

  persist(): void {
    this.store.set({
      slotCount: this.slots.length,
      slots: this.slots.map((s) => ({
        customName: s.customName,
        folder: s.folder,
        artifact: s.artifact,
        outputs: s.outputs,
        firstPrompt: s.firstPrompt,
        transcript: s.transcript,
        agentMessages: s.agentMessages,
        mirrorSessionId: s.mirrorSessionId,
        remoteThreadId: s.remoteThreadId,
        projectCreationKey: s.projectCreationKey,
        projectId: s.projectId,
        projectResumeCache: s.projectResumeCache,
        pendingSources: s.pendingSources,
      })),
    })
  }

  // ---- derived view ------------------------------------------------------

  private liveWindow(slot: Slot): BrowserWindow | null {
    return slot.win && !slot.win.isDestroyed() ? slot.win : null
  }

  private slotStatus(slot: Slot): 'empty' | 'idle' | 'working' | 'minimized' | 'active' {
    const win = this.liveWindow(slot)
    if (!win) return slot.folder ? 'idle' : 'empty'
    if (slot.busy) return 'working'
    return win.isMinimized() || slot.tucked ? 'minimized' : 'active'
  }

  snapshot(): DockSnapshot {
    return {
      slots: this.slots.map((slot, i) => ({
        index: i,
        label: slotLabel({
          customName: slot.customName,
          firstPrompt: slot.firstPrompt,
          folder: slot.folder,
          index: i + 1,
        }),
        status: this.slotStatus(slot),
        hasWindow: Boolean(this.liveWindow(slot)),
        hasNotification: slot.hasNotification,
        focused: Boolean(this.liveWindow(slot)?.isFocused()),
        folder: slot.folder,
      })),
    }
  }

  private changed(): void {
    this.emit('changed', this.snapshot())
  }

  /**
   * What the host's slot-cards hook needs to identify each slot: its index,
   * the stable mirror session id (when a conversation exists), and the folder.
   */
  cardSlots(): Array<{ index: number; sessionId: string | null; folder: string | null }> {
    return this.slots.map((slot, index) => ({
      index,
      sessionId: slot.mirrorSessionId,
      folder: slot.folder,
    }))
  }

  /**
   * Which slot a session window's IPC belongs to. Resolved from the sender —
   * never from a renderer-supplied index — because closing a slot shifts the
   * indices of every slot to its right, while windows live on.
   */
  indexForSender(sender: WebContents): number {
    return this.slots.findIndex((slot) => this.liveWindow(slot)?.webContents === sender)
  }

  private pushWindow(slot: Slot, channel: string, payload: unknown): void {
    const win = this.liveWindow(slot)
    if (win) win.webContents.send(channel, payload)
  }

  /** Tell every open session window about something, e.g. the key changing. */
  broadcast(channel: string, payload: unknown): void {
    for (const slot of this.slots) this.pushWindow(slot, channel, payload)
  }

  // ---- slot lifecycle ----------------------------------------------------

  addSlot(): number | null {
    if (this.slots.length >= MAX_SLOTS) return null
    this.slots.push(this.blankSlot())
    this.persist()
    this.changed()
    dockTrack('session_started', { slot_count: this.slots.length })
    return this.slots.length - 1
  }

  rename(index: number, name: string): void {
    const slot = this.slots[index]
    if (!slot) return
    slot.customName = name && name.trim() ? name.trim() : null
    this.persist()
    this.changed()
  }

  private setSlotRemoteThreadId(slot: Slot, value: string | null): void {
    if (slot.remoteThreadId === value) return
    slot.remoteThreadId = value
    slot.outputs = slot.outputs.map((output) => ({
      ...output,
      mirrored: false,
      demotionPending: output.demoted,
    }))
    this.outputMirrorsInFlight.delete(slot)
    this.outputMirrorRetriesRequested.delete(slot)
    this.outputDemotionsInFlight.delete(slot)
    this.outputDemotionRetriesRequested.delete(slot)
  }

  private backendHandle(
    slot: Slot,
    generation = slot.generation,
    isCurrent = (): boolean => slot.generation === generation && this.slots.includes(slot),
    onRemoteThreadIdChanged?: (handle: SessionBackendSlot) => void,
  ): SessionBackendSlot {
    const manager = this
    const folder = slot.folder ?? os.homedir()
    let remoteThreadId = slot.remoteThreadId
    let projectCreationKey = slot.projectCreationKey
    let projectId = slot.projectId
    let projectResumeCache = slot.projectResumeCache
    let pendingSources = slot.pendingSources
    const handle: SessionBackendSlot = {
      folder,
      slotKey: slot,
      get remoteThreadId(): string | null { return remoteThreadId },
      set remoteThreadId(value: string | null) {
        remoteThreadId = value
        if (!isCurrent()) return
        manager.setSlotRemoteThreadId(slot, value)
        manager.persist()
        onRemoteThreadIdChanged?.(handle)
      },
      get projectCreationKey() { return projectCreationKey },
      set projectCreationKey(value) { projectCreationKey = value; if (isCurrent()) { slot.projectCreationKey = value; manager.persist() } },
      get projectId() { return projectId },
      set projectId(value) { projectId = value; if (isCurrent()) { slot.projectId = value; manager.persist() } },
      get projectResumeCache() { return projectResumeCache },
      set projectResumeCache(value) { projectResumeCache = value; if (isCurrent()) { slot.projectResumeCache = value; manager.persist() } },
      flushPersistence() { if (isCurrent()) manager.store.save() },
      get pendingSources(): PendingSlotSource[] { return pendingSources },
      set pendingSources(value: PendingSlotSource[]) {
        pendingSources = value
        if (!isCurrent()) return
        slot.pendingSources = value
        manager.persist()
      },
      sourceNotice(notice) {
        if (slot.generation === generation && slot.remoteThreadId === remoteThreadId && manager.slots.includes(slot)) manager.pushSourceNotice(slot, notice)
      },
      sourcesChanged(registered) {
        if (slot.generation === generation && slot.remoteThreadId === remoteThreadId && manager.slots.includes(slot)) {
          if (manager.backend?.listSources) {
            manager.retainUnconfirmedSources(slot, registered)
            void manager.refreshSourcesForSlot(slot)
          } else {
            manager.pushSources(slot)
          }
        }
      },
    }
    return handle
  }

  private refreshCompatibility(slot: Slot, handle = this.backendHandle(slot)): void {
    slot.compatibilityHandle = handle
    slot.compatibility = this.backend?.compatibilityStatus?.(handle)
  }

  private async pushApprovals(slot: Slot): Promise<void> {
    if (!this.backend?.listApprovals) return
    const generation = slot.generation
    const request = ++slot.approvalRequest
    const handle = this.backendHandle(slot, generation)
    let items: ApprovalPayload[] | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        items = await this.backend.listApprovals(handle)
        break
      } catch {
        if (attempt === 1 || slot.approvalRequest !== request || slot.generation !== generation) return
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    if (items && slot.approvalRequest === request && slot.generation === generation && this.slots.includes(slot)) {
      try { this.pushWindow(slot, DockSessionIpcChannel.Approvals, items) } catch { /* renderer closed during delivery */ }
    }
  }

  async refreshApprovals(index: number): Promise<void> {
    const slot = this.slots[index]
    if (slot) await this.pushApprovals(slot)
  }

  async decideApproval(index: number, effectId: string, decision: ApprovalDecision): Promise<{ ok: boolean; message?: string }> {
    const slot = this.slots[index]
    if (!slot || !this.backend?.decideApproval) return { ok: false, message: 'Approval decisions are unavailable.' }
    if (slot.busy) return { ok: false, message: 'A Turn is already running. Try again in a moment.' }
    let resolveDecision!: (result: BackendApprovalDecisionResult) => void
    const accepted = new Promise<BackendApprovalDecisionResult>((resolve) => { resolveDecision = resolve })
    let deferredDecision: BackendApprovalDecisionResult | undefined
    void (async () => {
      try {
        await this.promptViaBackend(slot, '', async (handle, sink, start) => {
          let result: BackendApprovalDecisionResult
          try {
            result = await this.backend!.decideApproval!(handle, effectId, decision, sink)
          } catch (err) {
            deferredDecision = { ok: false, message: err instanceof Error ? err.message : String(err) }
            return false
          }
          if (!result.ok) {
            deferredDecision = result
            return false
          }
          if (!result.resumeTurn) {
            deferredDecision = result
            await this.pushApprovals(slot)
            return false
          }
          // Acceptance is final before observation begins. Failures and
          // denials remain pending until promptViaBackend restores the Slot.
          resolveDecision(result)
          start()
          await result.resumeTurn()
          return true
        }, true)
      } catch (err) {
        deferredDecision ??= { ok: false, message: err instanceof Error ? err.message : String(err) }
      } finally {
        if (deferredDecision) resolveDecision(deferredDecision)
      }
    })()
    const result = await accepted
    return result.ok ? { ok: true } : result
  }

  async fetchEvidence(bundleId: string): Promise<EvidenceResult> {
    return this.backend?.fetchEvidence?.(bundleId) ?? { status: 'failure', message: 'Evidence is unavailable.' }
  }

  async shareEvidence(bundleId: string): Promise<EvidenceResult> {
    return this.backend?.shareEvidence?.(bundleId) ?? { status: 'failure', message: 'Evidence sharing is unavailable.' }
  }

  /**
   * Copy a user-picked file into this slot's source directory (via the
   * host-injected `ingest`, e.g. `dockSourceIngest.ts`'s
   * `ingestSourceDocument`) and either register it immediately (a remote
   * Thread already exists) or queue it in `pendingSources` for the next
   * prompt to flush. Report the outcome through `SourceActionNotice`, while
   * the Sources UI reflects the resulting document state.
   *
   * `ingest` is passed in rather than imported so this stays host-agnostic:
   * the actual filesystem copy is Lore-specific (`src/main/dockSourceIngest.ts`,
   * outside this OSS-synced surface) and is supplied by whichever host wires
   * a reachable entry point to it (TAN-5456 Task 9).
   */
  async ingestSource(
    index: number,
    sourcePath: string,
    ingest: (args: { folder: string; sourcePath: string }) => Promise<SlotIngestOutcome>,
  ): Promise<{ ok: boolean; message: string }> {
    const slot = this.slots[index]
    if (!slot) return { ok: false, message: 'This session no longer exists.' }
    const generation = slot.generation
    const folder = slot.folder ?? os.homedir()
    const result = await ingest({ folder, sourcePath })
    if (slot.generation !== generation || !this.slots.includes(slot)) return { ok: false, message: 'This session changed before the document was added.' }
    if (!result.ok) {
      this.pushSourceNotice(slot, { kind: 'error', message: result.message })
      return result
    }
    const entry: PendingSlotSource = { relativePath: result.relativePath, title: result.title }
    slot.pendingSources = [...slot.pendingSources, entry]
    this.persist()
    this.pushSources(slot)
    let registrationThreadId: string | null = null
    if (slot.remoteThreadId && this.backend?.registerSource) {
      const threadId = slot.remoteThreadId
      registrationThreadId = threadId
      try {
        await this.backend.registerSource(threadId, entry)
        if (slot.generation !== generation || slot.remoteThreadId !== threadId || !this.slots.includes(slot)) {
          return { ok: false, message: 'This session changed before the document was registered.' }
        }
        if (!this.backend.listSources) {
          slot.pendingSources = slot.pendingSources.filter(candidate => candidate !== entry)
          this.persist()
          this.pushSources(slot)
        }
      } catch (err) {
        if (slot.generation !== generation || slot.remoteThreadId !== threadId || !this.slots.includes(slot)) {
          return { ok: false, message: 'This session changed before the document was registered.' }
        }
        // Stays reachable from the next flush attempt rather than being lost.
        entry.registrationFailed = true
        this.persist()
        const message = err instanceof Error ? err.message : String(err)
        this.pushSources(slot)
        this.pushSourceNotice(slot, { kind: 'error', message })
        return { ok: false, message }
      }
    }
    const message = `Added "${entry.title}" as a reference document.`
    await this.refreshSourcesForSlot(slot)
    if (slot.generation !== generation
      || (registrationThreadId !== null && slot.remoteThreadId !== registrationThreadId)
      || !this.slots.includes(slot)) {
      return { ok: false, message: 'This session changed before the document was registered.' }
    }
    this.pushSourceNotice(slot, { kind: 'success', message })
    return { ok: true, message }
  }

  sourcesPayload(index: number): SourcesPayload {
    const slot = this.slots[index]
    if (!slot) return { loadState: 'loaded', documents: [] }
    const payload = mergeSourceDocuments({ registered: slot.registeredSources, pending: slot.pendingSources, loadState: slot.sourcesLoadState })
    return {
      ...payload,
      documents: payload.documents.map((document) => document.state !== 'waiting' && slot.unavailableSources.has(document.relativePath)
        ? { ...document, state: 'unavailable' as const }
        : document),
    }
  }

  private pushSources(slot: Slot): void {
    const index = this.slots.indexOf(slot)
    if (index !== -1) this.pushWindow(slot, SOURCES_CHANNEL, this.sourcesPayload(index))
  }

  private retainUnconfirmedSources(slot: Slot, registered: readonly PendingSlotSource[]): void {
    const pendingPaths = new Set(slot.pendingSources.map(source => source.relativePath))
    const unconfirmed = registered
      .filter(source => !pendingPaths.has(source.relativePath))
      .map(source => ({ relativePath: source.relativePath, title: source.title }))
    if (unconfirmed.length === 0) return
    slot.pendingSources = [...slot.pendingSources, ...unconfirmed]
    this.persist()
  }

  private pushSourceNotice(slot: Slot, notice: SourceActionNotice): void {
    slot.sourceErrorNotice = notice.kind === 'error' ? notice : null
    this.pushWindow(slot, SOURCE_NOTICE_CHANNEL, notice)
  }

  dismissSourceNotice(index: number): void {
    const slot = this.slots[index]
    if (slot) slot.sourceErrorNotice = null
  }

  async refreshSources(index: number): Promise<void> {
    const slot = this.slots[index]
    if (!slot) return
    await this.refreshSourcesForSlot(slot)
  }

  private async refreshSourcesForSlot(slot: Slot): Promise<void> {
    if (!this.slots.includes(slot)) return
    const generation = slot.generation
    const request = ++slot.sourcesRequest
    const threadId = slot.remoteThreadId
    if (!slot.remoteThreadId || !this.backend?.listSources) {
      slot.registeredSources = []
      slot.sourcesLoadState = 'loaded'
      this.pushSources(slot)
      return
    }
    const handle = this.backendHandle(slot, generation)
    try {
      const sources = await this.backend.listSources(handle)
      if (slot.generation !== generation || slot.remoteThreadId !== threadId || slot.sourcesRequest !== request || !this.slots.includes(slot)) return
      slot.registeredSources = sources
      const registeredPaths = new Set(sources.map(source => source.relativePath))
      const pendingSources = slot.pendingSources.filter(source => !registeredPaths.has(source.relativePath))
      if (pendingSources.length !== slot.pendingSources.length) {
        slot.pendingSources = pendingSources
        this.persist()
      }
      slot.sourcesLoadState = 'loaded'
    } catch {
      if (slot.generation !== generation || slot.remoteThreadId !== threadId || slot.sourcesRequest !== request || !this.slots.includes(slot)) return
      slot.sourcesLoadState = 'error'
    }
    this.pushSources(slot)
  }

  async retrySources(index: number): Promise<void> {
    const slot = this.slots[index]
    if (!slot) return
    const generation = slot.generation
    const threadId = slot.remoteThreadId
    if (threadId && this.backend?.registerSource) {
      for (const entry of [...slot.pendingSources]) {
        try {
          await this.backend.registerSource(threadId, entry)
          if (slot.generation !== generation || slot.remoteThreadId !== threadId || !this.slots.includes(slot)) return
          if (this.backend.listSources) delete entry.registrationFailed
          else slot.pendingSources = slot.pendingSources.filter(candidate => candidate !== entry)
        } catch (err) {
          if (slot.generation !== generation || slot.remoteThreadId !== threadId || !this.slots.includes(slot)) return
          entry.registrationFailed = true
          this.pushSourceNotice(slot, { kind: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      }
      this.persist()
    }
    await this.refreshSourcesForSlot(slot)
  }

  private invalidateSourcePreviews(slot: Slot): void {
    slot.sourcePreviewRequest += 1
    slot.sourcePreviewRequests.clear()
  }

  async previewSource(
    index: number,
    relativePath: string,
    previewHook: (args: { sessionFolder: string; relativePath: string; allowedRelativePaths: ReadonlySet<string> }) => Promise<SourceDocumentPreviewResult>,
  ): Promise<SourceDocumentPreviewResult> {
    const slot = this.slots[index]
    const unavailable: SourceDocumentPreviewResult = { ok: false, reason: 'not_allowed', message: 'This reference document is unavailable.' }
    if (!slot || !slot.folder) return unavailable
    const allowed = new Set(this.sourcesPayload(index).documents.map(document => document.relativePath))
    if (!allowed.has(relativePath)) return unavailable
    const generation = slot.generation
    const request = ++slot.sourcePreviewRequest
    slot.sourcePreviewRequests.set(relativePath, request)
    const result = await previewHook({ sessionFolder: slot.folder, relativePath, allowedRelativePaths: allowed })
    const stillAllowed = slot.generation === generation
      && this.slots.includes(slot)
      && slot.sourcePreviewRequest === request
      && slot.sourcePreviewRequests.get(relativePath) === request
      && this.sourcesPayload(this.slots.indexOf(slot)).documents.some(document => document.relativePath === relativePath)
    if (!stillAllowed) return unavailable
    if (!result.ok) {
      slot.unavailableSources.add(relativePath)
      this.pushSources(slot)
    } else if (slot.unavailableSources.delete(relativePath)) {
      this.pushSources(slot)
    }
    return result
  }

  openSourceInspector(index: number): void {
    const slot = this.slots[index]
    if (!slot) return
    slot.inspectorMode = 'source'
    slot.artifact = null
    unregisterArtifact(index)
    this.persist()
    this.pushWindow(slot, DockSessionIpcChannel.Artifact, null)
    const win = this.liveWindow(slot)
    if (win) this.resizeForArtifact(win, true)
  }

  closeSourceInspector(index: number): void {
    const slot = this.slots[index]
    if (!slot) return
    this.invalidateSourcePreviews(slot)
    const win = this.liveWindow(slot)
    if (slot.artifact) {
      slot.inspectorMode = 'output'
      this.pushWindow(slot, DockSessionIpcChannel.Artifact, this.artifactPayload(index, slot))
      if (win) this.resizeForArtifact(win, true)
    } else {
      slot.inspectorMode = null
      if (win) this.resizeForArtifact(win, false)
    }
  }

  private async annotateEvidence(slot: Slot): Promise<void> {
    if (!this.backend?.listEvidence || !slot.remoteThreadId) return
    const generation = slot.generation
    const handle = this.backendHandle(slot, generation)
    const summaries = await this.backend.listEvidence(handle).catch(() => null)
    if (!summaries || slot.generation !== generation || !this.slots.includes(slot)) return
    const byTool = new Map(summaries.filter((item) => item.kind === 'dock_effect' && item.toolCallId).map((item) => [item.toolCallId!, item.bundleId]))
    let changed = false
    for (const entry of slot.transcript) {
      if (entry.role !== 'assistant') continue
      for (const tool of entry.tools) {
        const bundleId = byTool.get(tool.id)
        if (bundleId && tool.evidenceBundleId !== bundleId) { tool.evidenceBundleId = bundleId; changed = true }
      }
    }
    if (changed) this.persist()
    this.pushWindow(slot, DockSessionIpcChannel.EvidenceAnnotations,
      [...byTool].map(([toolCallId, bundleId]) => ({ toolCallId, bundleId })))
  }

  async refreshEvidence(index: number): Promise<void> {
    const slot = this.slots[index]
    if (slot) await this.annotateEvidence(slot)
  }

  private reviewPayloads(slot: Slot): TurnReviewPayload[] {
    return [...slot.reviews].map(([promptBlockId, review]) => ({
      promptBlockId,
      promptExcerpt: this.promptExcerpt(slot, promptBlockId),
      review,
    }))
  }

  private promptExcerpt(slot: Slot, promptBlockId: string): string | null {
    const outcomeIndex = slot.transcript.findIndex(entry => entry.role === 'outcome' && entry.reference === promptBlockId)
    if (outcomeIndex === -1) return null
    for (let index = outcomeIndex - 1; index >= 0; index--) {
      const entry = slot.transcript[index]
      if (entry.role === 'user') return entry.text
      if (entry.role === 'outcome') break
    }
    return null
  }

  private applyReview(slot: Slot, promptBlockId: string, result: ReviewResult): void {
    if (result.status === 'success') slot.reviews.set(promptBlockId, result.review)
    else slot.reviews.delete(promptBlockId)
    this.pushWindow(slot, DockSessionIpcChannel.Reviews, this.reviewPayloads(slot))
  }

  private async refreshReview(slot: Slot, handle: SessionBackendSlot, promptBlockId: string): Promise<void> {
    const backend = this.backend
    if (!backend?.fetchReview) return
    const epoch = slot.reviewEpoch
    const generation = slot.generation
    const backendSlot = slot.backendSlot
    const request = (slot.reviewRequests.get(promptBlockId) ?? 0) + 1
    slot.reviewRequests.set(promptBlockId, request)
    const result = await backend.fetchReview(handle, promptBlockId).catch((): ReviewResult => ({ status: 'unavailable', retryable: true }))
    if (slot.reviewEpoch !== epoch
      || slot.generation !== generation
      || slot.backendSlot !== backendSlot
      || this.backend !== backend
      || slot.reviewRequests.get(promptBlockId) !== request
      || !this.slots.includes(slot)) return
    this.applyReview(slot, promptBlockId, result)
  }

  private clearSlotReviews(slot: Slot): void {
    slot.reviewEpoch += 1
    slot.reviewRequests.clear()
    slot.reviews.clear()
  }

  async refreshReviews(index: number): Promise<void> {
    const slot = this.slots[index]
    if (!slot || !this.backend?.fetchReview || !slot.remoteThreadId) return
    const generation = slot.generation
    const handle = this.backendHandle(slot, generation)
    const references = [...new Set(slot.transcript.flatMap(entry => entry.role === 'outcome' && entry.reference ? [entry.reference] : []))]
    for (const reference of references) {
      await this.refreshReview(slot, handle, reference)
      if (slot.generation !== generation || !this.slots.includes(slot)) return
    }
    for (const reference of [...slot.reviews.keys()]) if (!references.includes(reference)) slot.reviews.delete(reference)
    this.pushWindow(slot, DockSessionIpcChannel.Reviews, this.reviewPayloads(slot))
  }

  private canonicalFolder(folder: string): string {
    try { return fs.realpathSync(folder) } catch { return path.resolve(folder) }
  }

  private resetSlotForFolder(slot: Slot): void {
    slot.generation += 1
    this.clearSlotReviews(slot)
    if (slot.agent) slot.agent.abort()
    const active = slot.backendSlot
    if (active && this.backend) {
      void this.backend.stopRemote?.(active).catch(() => {})
      this.backend.disposeSlot?.(active)
    } else {
      this.disposeBackendSlot(slot)
    }
    slot.backendSlot = null
    slot.remoteStopRequested = false
    slot.remoteThreadId = null
    slot.projectCreationKey = null
    slot.projectId = null
    slot.projectResumeCache = null
    slot.agent = null
    slot.mirror = null
    slot.mirrorSessionId = null
    slot.transcript = []
    slot.agentMessages = []
    slot.firstPrompt = null
    slot.artifact = null
    slot.outputs = []
    this.outputQueues.delete(slot)
    this.outputMirrorsInFlight.delete(slot)
    this.outputMirrorRetriesRequested.delete(slot)
    this.outputMirrorSuppressed.delete(slot)
    this.outputDemotionsInFlight.delete(slot)
    this.outputDemotionRetriesRequested.delete(slot)
    // A pending source belongs to the folder it was copied INTO. Its
    // `relativePath` is relative to the old root, so carrying it across a
    // re-point (and across a relaunch, since it is persisted) would register a
    // reference document against the new folder's Thread naming a file that
    // exists only under the old one — the registry claiming a bound document
    // for a project that never contained it.
    slot.pendingSources = []
    slot.registeredSources = []
    slot.sourcesLoadState = 'loaded'
    slot.sourcesRequest += 1
    slot.unavailableSources.clear()
    slot.sourcePreviewRequests.clear()
    slot.sourceErrorNotice = null
    slot.inspectorMode = null
    unregisterArtifact(this.slots.indexOf(slot))
    slot.busy = false
  }

  /** Focus an existing window, or open one for this slot. */
  activate(
    index: number,
    { folder, placement = 'floating' }: { folder?: string; placement?: SessionPlacement } = {},
  ): SessionActivation | null {
    const slot = this.slots[index]
    if (!slot) return null

    slot.hasNotification = false

    const win = this.liveWindow(slot)

    const folderChanged = Boolean(
      folder && this.canonicalFolder(folder) !== this.canonicalFolder(slot.folder ?? os.homedir()),
    )

    // Reset and persist the old identity before creating anything rooted in
    // the new folder. This applies even while the session window is closed.
    if (folderChanged) {
      this.resetSlotForFolder(slot)
      slot.folder = folder!
      this.persist()
    }

    // Pointing an open session at a new folder means a new agent and a new
    // transcript — the old agent's tools are bound to the old root.
    if (win && folderChanged) {
      win.destroy()
      slot.win = null
      slot.placement = null
    } else if (win) {
      slot.tucked = false
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      void this.refreshResume(index)
      this.changed()
      return slot.placement ? { placement: slot.placement, window: win } : null
    }

    // A session starts in the user's home folder unless they point it somewhere
    // else. Nobody should have to answer a file-picker before saying hello.
    if (folder) slot.folder = folder
    if (!slot.folder) slot.folder = os.homedir()

    // A newly opened renderer is a new private-state lifetime even when it
    // binds to the same durable Slot and prompt references.
    this.clearSlotReviews(slot)
    slot.win = this.createSessionWindow({ slotIndex: index, folder: slot.folder, placement })
    slot.placement = placement
    slot.tucked = false
    this.wireWindow(slot)
    if (slot.sourceErrorNotice) this.pushWindow(slot, SOURCE_NOTICE_CHANNEL, slot.sourceErrorNotice)
    if (this.artifactPayload(index, slot)) this.resizeForArtifact(slot.win, true)
    dockLog.info('session_opened', {
      slot: index,
      folder: slot.folder,
      transcriptEntries: slot.transcript.length,
    })
    // No folder path in telemetry — only whether a past conversation resumed.
    dockTrack('session_opened', { restored: slot.transcript.length > 0 })
    this.persist()
    this.changed()
    void this.pushApprovals(slot)
    void this.annotateEvidence(slot)
    void this.refreshReviews(this.slots.indexOf(slot))
    void this.refreshSourcesForSlot(slot)
    this.requestSlotOutputMirrorRetries(slot)
    void this.ensureAndRefreshResume(index)
    return { placement, window: slot.win }
  }

  private wireWindow(slot: Slot): void {
    const win = slot.win
    if (!win) return
    win.on('focus', () => {
      slot.hasNotification = false
      this.changed()
      void this.pushApprovals(slot)
    })
    // Blur re-renders too so the traveling selection ring follows focus.
    win.on('blur', () => this.changed())
    win.on('minimize', () => this.changed())
    win.on('restore', () => this.changed())
    // Embedded windows hide/show instead of minimizing (route changes, tuck).
    win.on('hide', () => this.changed())
    win.on('show', () => this.changed())
    win.on('closed', () => {
      slot.win = null
      slot.placement = null
      // Author-private detail is scoped to the window. A later window refetches
      // from the authoritative route using only persisted Outcome references.
      this.clearSlotReviews(slot)
      if (slot.agent) slot.agent.abort()
      slot.busy = false
      dockLog.info('session_window_closed', { slot: this.slots.indexOf(slot) })
      this.changed()
    })
  }

  /** Everything the session renderer needs on load, including past messages. */
  sessionState(index: number): SessionInitPayload | null {
    const slot = this.slots[index]
    if (!slot) return null
    return {
      index,
      folder: slot.folder,
      busy: slot.busy,
      resume: this.resumeState(slot),
      sourceNotice: slot.sourceErrorNotice ?? undefined,
      transcript: slot.transcript,
      reviews: this.reviewPayloads(slot),
      artifact: this.artifactPayload(index, slot),
      compatibility: slot.compatibility,
      ...this.keyState(),
    }
  }

  private resumeState(slot: Slot, fresh = false): ProjectResumeState {
    const cache = slot.projectResumeCache
    return cache
      ? { status: 'available', expanded: true, writable: fresh, freshness: fresh ? 'fresh' : 'cached', cachedAt: cache.cachedAt, data: cache.resume, sourceAvailability: Object.fromEntries(cache.resume.sources.items.map((source) => [source.id, source.kind !== 'lore_thread' && Boolean(slot.folder && this.outputFile(slot.folder, source.relativePath))])) }
      : { status: 'unavailable', expanded: true, writable: false }
  }

  private async ensureAndRefreshResume(index: number): Promise<void> {
    const slot = this.slots[index]
    if (!slot || !this.backend) return
    const generation = slot.generation
    const handle = this.backendHandle(slot, generation)
    try {
      if (slot.remoteThreadId && !slot.projectId) await this.backend.ensureProject?.(handle, slot.firstPrompt ?? 'New project')
      await this.refreshResume(index)
    } catch { this.pushWindow(slot, DockSessionIpcChannel.Resume, this.resumeState(slot)) }
  }

  async refreshResume(index: number): Promise<ProjectResumeState> {
    const slot = this.slots[index]
    if (!slot || !this.backend?.readProjectResume || !slot.projectId) return slot ? this.resumeState(slot) : { status: 'unavailable', expanded: true, writable: false }
    const generation = slot.generation
    const projectId = slot.projectId
    const remoteThreadId = slot.remoteThreadId
    const handle = this.backendHandle(slot, generation)
    try {
      const data = await this.backend.readProjectResume(handle)
      if (slot.generation !== generation || slot.projectId !== projectId || slot.remoteThreadId !== remoteThreadId || !this.slots.includes(slot)) return this.resumeState(slot)
      slot.projectResumeCache = { resume: data, cachedAt: new Date().toISOString() }
      this.persist()
      const state = this.resumeState(slot, true)
      this.pushWindow(slot, DockSessionIpcChannel.Resume, state)
      return state
    } catch (error) {
      if (slot.generation !== generation || slot.projectId !== projectId || slot.remoteThreadId !== remoteThreadId || !this.slots.includes(slot)) return this.resumeState(slot)
      const missingSession = error instanceof Error && 'code' in error && (error as Error & { code: unknown }).code === 'missing_session'
      if (missingSession) {
        slot.projectId = null
        slot.projectResumeCache = null
        this.persist()
      }
      const state = this.resumeState(slot)
      this.pushWindow(slot, DockSessionIpcChannel.Resume, state)
      return state
    }
  }

  async updateObjective(index: number, expectedRevision: number, objective: string, acceptSuggestion: boolean): Promise<ProjectEditResult> {
    return this.editProject(index, async (backend, slot) => backend.updateProjectObjective?.(slot, expectedRevision, objective, acceptSuggestion))
  }

  async updateNextStep(index: number, expectedRevision: number, nextStep: string | null): Promise<ProjectEditResult> {
    return this.editProject(index, async (backend, slot) => backend.updateProjectNextStep?.(slot, expectedRevision, nextStep))
  }

  private async editProject(index: number, edit: (backend: SessionBackend, slot: SessionBackendSlot) => Promise<void> | undefined): Promise<ProjectEditResult> {
    const slot = this.slots[index]
    if (!slot || !slot.projectId || !this.backend) return { ok: false, message: 'Project editing is unavailable.' }
    try { await edit(this.backend, this.backendHandle(slot)); await this.refreshResume(index); return { ok: true } }
    catch (error) {
      const conflict = error instanceof Error && 'code' in error && (error as Error & { code: string }).code === 'conflict'
      if (conflict) {
        const refreshed = await this.refreshResume(index)
        if (refreshed.status === 'available' && refreshed.freshness === 'fresh' && refreshed.writable) return { ok: false, conflict: true, message: 'State changed; reloaded.' }
        return { ok: false, message: 'State changed, but reload failed. Retry when Project state is available.' }
      }
      return { ok: false, message: error instanceof Error ? error.message : 'Project editing failed.' }
    }
  }

  /** Clear all author-private window state without touching durable transcript entries. */
  clearEphemeralReviews(): void {
    for (const slot of this.slots) {
      this.clearSlotReviews(slot)
      this.pushWindow(slot, DockSessionIpcChannel.Reviews, [])
    }
  }

  /** Start a fresh host auth/org lifetime, then rehydrate only open windows. */
  refreshPrivateReviewAccess(): void {
    this.clearEphemeralReviews()
    if (!this.modelAccess.available()) return
    for (const [index, slot] of this.slots.entries()) {
      if (this.liveWindow(slot)) void this.refreshReviews(index)
    }
  }

  /** The blocked-banner state shared by init payloads and KeyState pushes. */
  keyState(): { hasKey: boolean; keyPrompt?: string; keyActionHidden?: boolean } {
    return {
      hasKey: this.modelAccess.available(),
      keyPrompt: this.modelAccess.unavailableMessage,
      keyActionHidden: Boolean(this.modelAccess.hidesSettingsAction),
    }
  }

  // ---- artifact pane -----------------------------------------------------

  /** null when there is no artifact or its file has gone missing. */
  private artifactPayload(index: number, slot: Slot): ArtifactPayload | null {
    if (!slot.artifact || !slot.folder) return null
    try {
      const file = resolveInRoot(slot.folder, slot.artifact.path)
      if (!fs.existsSync(file)) throw new Error('gone')
      // The artifact:// handler serves exactly this file for this slot.
      const url = registerArtifact(index, file)
      return { url, path: slot.artifact.path, title: slot.artifact.title, version: slot.artifact.version || 0 }
    } catch {
      unregisterArtifact(index)
      return null
    }
  }

  outputsPayload(index: number): OutputsPayload {
    const slot = this.slots[index]
    if (!slot) return { outputs: [] }
    return {
      outputs: [...slot.outputs].sort((a, b) => b.updatedAtMs - a.updatedAtMs).map((output) => ({
        path: output.path,
        title: output.title,
        versionOrdinal: output.versionOrdinal,
        demoted: output.demoted,
        mirrored: output.mirrored,
        available: Boolean(slot.folder && this.outputFile(slot.folder, output.path)),
        shown: slot.artifact?.path === output.path,
      })),
    }
  }

  private outputFile(folder: string, outputPath: string): string | null {
    try {
      const file = resolveInRoot(folder, outputPath)
      return fs.existsSync(file) ? file : null
    } catch {
      return null
    }
  }

  previewResumeSource(index: number, sourceId: string): boolean {
    const slot = this.slots[index]
    const source = slot?.projectResumeCache?.resume.sources.items.find((item) => item.id === sourceId)
    if (!slot?.folder || !source || source.kind === 'lore_thread') return false
    const file = this.outputFile(slot.folder, source.relativePath)
    if (!file) return false
    const opening = !slot.artifact
    slot.artifact = { path: source.relativePath, title: source.title, version: 0 }
    this.persist()
    if (opening && slot.win) this.resizeForArtifact(slot.win, true)
    this.pushWindow(slot, DockSessionIpcChannel.Artifact, this.artifactPayload(index, slot))
    return true
  }

  private queueSlotOutput(slot: Slot, operation: () => Promise<void>): void {
    const generation = slot.generation
    const sessionId = slot.remoteThreadId
    const run = async (): Promise<void> => {
      if (!this.slots.includes(slot) || slot.generation !== generation || slot.remoteThreadId !== sessionId) return
      await operation()
    }
    const queued = (this.outputQueues.get(slot) ?? Promise.resolve()).then(run, run)
    this.outputQueues.set(slot, queued)
    void queued.finally(() => {
      if (this.outputQueues.get(slot) === queued) this.outputQueues.delete(slot)
    })
  }

  private suppressSlotOutputSync(slot: Slot, logEvent: 'output_mirror_session_missing' | 'output_demotion_session_missing'): void {
    if (!slot.remoteThreadId || this.slotOutputSyncSuppressed(slot)) return
    this.outputMirrorSuppressed.set(slot, slot.remoteThreadId)
    this.outputMirrorRetriesRequested.delete(slot)
    this.outputDemotionRetriesRequested.delete(slot)
    slot.outputs = slot.outputs.map((output) => output.demotionPending ? { ...output, demotionPending: false } : output)
    this.persist()
    dockLog.warn(logEvent, { slot: this.slots.indexOf(slot) })
  }

  private slotOutputSyncSuppressed(slot: Slot): boolean {
    return Boolean(slot.remoteThreadId && this.outputMirrorSuppressed.get(slot) === slot.remoteThreadId)
  }

  private mirrorSlotOutput(slot: Slot, outputPath: string, title: string, contentHash: string, bytes: Uint8Array, versionOrdinal: number, toolCallId?: string, preserveRetryIntent = false, identityRegistered = false): void {
    if (!this.mirrorOutput || !slot.remoteThreadId || this.slotOutputSyncSuppressed(slot)) return
    const generation = slot.generation
    const sessionId = slot.remoteThreadId
    const current = () => this.slots.includes(slot) && slot.generation === generation && slot.remoteThreadId === sessionId
    const identity = `${sessionId}\0${outputPath}\0${toolCallId ?? ''}\0${versionOrdinal}\0${contentHash}`
    const pendingIdentities = this.outputMirrorIdentitiesPending.get(slot) ?? new Set<string>()
    if (!identityRegistered && pendingIdentities.has(identity)) {
      if (preserveRetryIntent) {
        const retries = this.outputMirrorIdentityRetriesRequested.get(slot) ?? new Set<string>()
        retries.add(identity)
        this.outputMirrorIdentityRetriesRequested.set(slot, retries)
      }
      return
    }
    if (!identityRegistered) {
      pendingIdentities.add(identity)
      this.outputMirrorIdentitiesPending.set(slot, pendingIdentities)
    }
    const inFlight = this.outputMirrorsInFlight.get(slot) ?? new Set<string>()
    if (inFlight.has(outputPath)) {
      if (!preserveRetryIntent || !current()) {
        pendingIdentities.delete(identity)
        return
      }
      const requested = this.outputMirrorRetriesRequested.get(slot) ?? new Map()
      const snapshots = requested.get(outputPath) ?? []
      snapshots.push({ title, contentHash, bytes, versionOrdinal, ...(toolCallId ? { toolCallId } : {}) })
      requested.set(outputPath, snapshots)
      this.outputMirrorRetriesRequested.set(slot, requested)
      return
    }
    this.outputMirrorsInFlight.set(slot, inFlight)
    inFlight.add(outputPath)
    let succeeded = false
    void this.mirrorOutput({ bytes, path: outputPath, title, contentHash, sessionId, ...(toolCallId ? { toolCallId } : {}) })
      .then(() => {
        succeeded = true
        if (!current()) return
        const latest = slot.outputs.find((output) => output.path === outputPath)
        if (latest?.toolCallId !== toolCallId) return
        slot.outputs = markOutputMirrored(slot.outputs, outputPath, versionOrdinal)
        this.persist()
        this.pushWindow(slot, DockSessionIpcChannel.Outputs, this.outputsPayload(this.slots.indexOf(slot)))
        this.retrySlotOutputDemotions(slot)
      })
      .catch((error: unknown) => {
        if (!current() || !(error instanceof DockOutputMirrorError) || error.code !== 'permanent_session_missing' || this.slotOutputSyncSuppressed(slot)) return
        this.suppressSlotOutputSync(slot, 'output_mirror_session_missing')
      })
      .finally(() => {
        inFlight.delete(outputPath)
        pendingIdentities.delete(identity)
        if (!current()) return
        const identityRetries = this.outputMirrorIdentityRetriesRequested.get(slot)
        const retryIdentity = !succeeded && (identityRetries?.delete(identity) ?? false)
        if (succeeded) identityRetries?.delete(identity)
        if (identityRetries?.size === 0) this.outputMirrorIdentityRetriesRequested.delete(slot)
        const requested = this.outputMirrorRetriesRequested.get(slot)
        const snapshots = requested?.get(outputPath)
        const next = retryIdentity
          ? { title, contentHash, bytes, versionOrdinal, ...(toolCallId ? { toolCallId } : {}) }
          : snapshots?.shift()
        if (!next) return
        if (snapshots?.length === 0) requested?.delete(outputPath)
        if (requested?.size === 0) this.outputMirrorRetriesRequested.delete(slot)
        this.mirrorSlotOutput(slot, outputPath, next.title, next.contentHash, next.bytes,
          next.versionOrdinal, next.toolCallId, true, !retryIdentity)
      })
  }

  private async retrySlotOutputMirrors(slot: Slot, inFlightWhenRequested = new Set<string>(), eligiblePaths?: Set<string>): Promise<void> {
    if (!this.mirrorOutput || !slot.remoteThreadId || !this.slots.includes(slot) || !slot.folder || this.slotOutputSyncSuppressed(slot)) return
    for (const output of slot.outputs) {
      if (eligiblePaths && !eligiblePaths.has(output.path)) continue
      if (output.mirrored || !output.contentHash) continue
      const file = this.outputFile(slot.folder, output.path)
      if (file) await this.recordSlotOutput(slot, output.path, output.title, true, inFlightWhenRequested.has(output.path))
    }
  }

  private requestSlotOutputMirrorRetries(slot: Slot): void {
    const inFlight = new Set(this.outputMirrorsInFlight.get(slot))
    const eligiblePaths = new Set(slot.outputs.filter((output) => !output.mirrored && output.contentHash).map((output) => output.path))
    this.queueSlotOutput(slot, () => this.retrySlotOutputMirrors(slot, inFlight, eligiblePaths))
    this.retrySlotOutputDemotions(slot)
  }

  private retrySlotOutputDemotions(slot: Slot): void {
    if (!this.setOutputDemoted || !slot.remoteThreadId || this.slotOutputSyncSuppressed(slot)) return
    for (const output of slot.outputs) {
      if (output.demotionPending) this.syncSlotOutputDemotion(slot, output.path, output.demoted, true)
    }
  }

  private syncSlotOutputDemotion(slot: Slot, outputPath: string, demoted: boolean, explicitRetry = false): void {
    if (this.slotOutputSyncSuppressed(slot)) {
      if (slot.outputs.some((output) => output.demotionPending)) {
        slot.outputs = slot.outputs.map((output) => output.demotionPending ? { ...output, demotionPending: false } : output)
        this.outputDemotionRetriesRequested.delete(slot)
        this.persist()
      }
      return
    }
    if (!this.setOutputDemoted || !slot.remoteThreadId) return
    const inFlight = this.outputDemotionsInFlight.get(slot) ?? new Set<string>()
    if (inFlight.has(outputPath)) {
      if (explicitRetry) {
        const requested = this.outputDemotionRetriesRequested.get(slot) ?? new Set<string>()
        requested.add(outputPath)
        this.outputDemotionRetriesRequested.set(slot, requested)
      }
      return
    }
    inFlight.add(outputPath)
    this.outputDemotionsInFlight.set(slot, inFlight)
    const generation = slot.generation
    const sessionId = slot.remoteThreadId
    void this.setOutputDemoted({ path: outputPath, sessionId, demoted }).then(() => {
      if (!this.slots.includes(slot) || slot.generation !== generation || slot.remoteThreadId !== sessionId) return
      slot.outputs = acknowledgeOutputDemotion(slot.outputs, outputPath, demoted)
      this.persist()
    }).catch((error: unknown) => {
      if (!this.slots.includes(slot) || slot.generation !== generation || slot.remoteThreadId !== sessionId) return
      if (error instanceof DockOutputMirrorError && error.code === 'permanent_session_missing') {
        this.suppressSlotOutputSync(slot, 'output_demotion_session_missing')
      }
    }).finally(() => {
      inFlight.delete(outputPath)
      if (!this.slots.includes(slot) || slot.generation !== generation || slot.remoteThreadId !== sessionId) return
      const latest = slot.outputs.find((output) => output.path === outputPath)
      const requested = this.outputDemotionRetriesRequested.get(slot)
      const retryRequested = requested?.delete(outputPath) ?? false
      if (requested?.size === 0) this.outputDemotionRetriesRequested.delete(slot)
      if (!this.slotOutputSyncSuppressed(slot) && latest?.demotionPending && (latest.demoted !== demoted || retryRequested)) this.syncSlotOutputDemotion(slot, outputPath, latest.demoted)
    })
  }

  private async recordSlotOutput(slot: Slot, outputPath: string, title: string, retry = false, preserveRetryIntent = false, toolCallId?: string): Promise<void> {
    if (!slot.folder) return
    const generation = slot.generation
    const sessionId = slot.remoteThreadId
    let file: string
    try {
      file = resolveInRoot(slot.folder, outputPath)
    } catch {
      return
    }
    let contentHash: string | null = null
    let bytes: Buffer | null = null
    try {
      bytes = await fs.promises.readFile(file)
      contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    } catch {}
    if (!this.slots.includes(slot) || slot.generation !== generation || slot.remoteThreadId !== sessionId) return
    const previous = slot.outputs.find((output) => output.path === outputPath)
    if ((!contentHash || !bytes) && previous) return
    const recorded = recordOutput(slot.outputs, { path: outputPath, title, contentHash, atMs: Date.now(), ...(toolCallId ? { toolCallId } : {}) })
    if (retry && previous?.demoted) {
      recorded.outputs = recorded.outputs.map((output) => output.path === outputPath
        ? { ...output, demoted: true, demotionPending: previous.demotionPending }
        : output)
    }
    slot.outputs = recorded.outputs
    this.persist()
    const index = this.slots.indexOf(slot)
    this.pushWindow(slot, DockSessionIpcChannel.Outputs, this.outputsPayload(index))
    const recordedOutput = slot.outputs.find((output) => output.path === outputPath)
    if (recordedOutput?.demotionPending) this.syncSlotOutputDemotion(slot, outputPath, recordedOutput.demoted)
    const repeatedShow = toolCallId !== undefined && toolCallId !== previous?.toolCallId
    if (!contentHash || !bytes || (recorded.changed === 'unchanged' && !retry && !repeatedShow)) return
    const versionOrdinal = slot.outputs.find((output) => output.path === outputPath)?.versionOrdinal
    if (!versionOrdinal) return
    this.mirrorSlotOutput(
      slot, outputPath, title, contentHash, bytes, versionOrdinal, recordedOutput?.toolCallId,
      preserveRetryIntent || repeatedShow,
    )
  }

  private applyArtifactAction(
    slot: Slot,
    call: { id?: string; name: string; input: { path?: unknown; title?: unknown } },
    ok: boolean,
  ): void {
    // Looked up at apply time: a slot removal mid-turn shifts this index.
    const index = this.slots.indexOf(slot)
    if (index === -1) return
    const action = artifactAction(slot.artifact, call.name, call.input || {}, ok, call.id)
    if (!action) return

    if (action.type === 'show') {
      this.invalidateSourcePreviews(slot)
      const opening = !slot.artifact
      if (opening) dockTrack('artifact_shown')
      slot.artifact = { path: action.path, title: action.title, version: 1 }
      this.persist()
      const win = this.liveWindow(slot)
      if (win && opening) this.resizeForArtifact(win, true)
    } else if (slot.artifact) {
      slot.artifact.version = (slot.artifact.version || 0) + 1
    }
    this.pushWindow(slot, DockSessionIpcChannel.Artifact, this.artifactPayload(index, slot))
    if (action.type === 'show') this.queueSlotOutput(slot, () => this.recordSlotOutput(slot, action.path, action.title, false, false, action.toolCallId))
  }

  private recordKnownOutputRevision(slot: Slot, call: { name: string; input: { path?: unknown } }, ok: boolean): void {
    if (!ok || (call.name !== 'write_file' && call.name !== 'edit_file') || typeof call.input.path !== 'string' || !slot.folder) return
    let requested: string
    try { requested = resolveInRoot(slot.folder, call.input.path) } catch { return }
    const known = slot.outputs.find((output) => {
      try { return resolveInRoot(slot.folder!, output.path) === requested } catch { return false }
    })
    const pending = known ?? (slot.artifact && (() => {
      try { return resolveInRoot(slot.folder!, slot.artifact!.path) === requested ? slot.artifact : null } catch { return null }
    })())
    if (pending) this.queueSlotOutput(slot, () => this.recordSlotOutput(slot, pending.path, pending.title, false, true))
  }

  selectOutput(index: number, outputPath: string): void {
    const slot = this.slots[index]
    const output = slot?.outputs.find((candidate) => candidate.path === outputPath)
    if (!slot || !output || !slot.folder || !this.outputFile(slot.folder, output.path)) {
      if (slot) this.pushWindow(slot, DockSessionIpcChannel.Outputs, this.outputsPayload(index))
      return
    }
    this.invalidateSourcePreviews(slot)
    const opening = !slot.artifact
    slot.inspectorMode = 'output'
    slot.artifact = { path: output.path, title: output.title, version: output.versionOrdinal }
    this.persist()
    const win = this.liveWindow(slot)
    if (win && opening) this.resizeForArtifact(win, true)
    this.pushWindow(slot, DockSessionIpcChannel.Artifact, this.artifactPayload(index, slot))
    this.pushWindow(slot, DockSessionIpcChannel.Outputs, this.outputsPayload(index))
  }

  setSlotOutputDemoted(index: number, outputPath: string, demoted: boolean): void {
    const slot = this.slots[index]
    if (!slot) return
    slot.outputs = setOutputDemoted(slot.outputs, outputPath, demoted)
    this.persist()
    this.pushWindow(slot, DockSessionIpcChannel.Outputs, this.outputsPayload(index))
    this.syncSlotOutputDemotion(slot, outputPath, demoted)
  }

  async saveOutputCopy(index: number, outputPath: string, destination: string): Promise<{ ok: boolean; message?: string }> {
    const slot = this.slots[index]
    const output = slot?.outputs.find((candidate) => candidate.path === outputPath)
    if (!slot || !output || !slot.folder) return { ok: false, message: 'This output is unavailable.' }
    const local = this.outputFile(slot.folder, output.path)
    try {
      if (local) await fs.promises.copyFile(local, destination)
      else {
        if (!this.fetchMirroredOutput || !slot.remoteThreadId) return { ok: false, message: 'This output is unavailable.' }
        const mirrored = await this.fetchMirroredOutput({ path: output.path, sessionId: slot.remoteThreadId })
        const response = await fetch(mirrored.downloadUrl)
        if (!response.ok) return { ok: false, message: 'This output is unavailable.' }
        await fs.promises.writeFile(destination, Buffer.from(await response.arrayBuffer()))
      }
      return { ok: true }
    } catch {
      return { ok: false, message: 'This output is unavailable.' }
    }
  }

  /**
   * What the host's share hook needs to publish the shown artifact to Lore:
   * the resolved file on disk plus the host-owned session identity. For the
   * Lore backend this is the native Dock thread id.
   */
  artifactShareInfo(index: number): { file: string; fileName: string; sessionId: string | null } | null {
    const slot = this.slots[index]
    if (!slot || !slot.artifact || !slot.folder) return null
    try {
      const file = resolveInRoot(slot.folder, slot.artifact.path)
      if (!fs.existsSync(file)) return null
      return { file, fileName: path.basename(file), sessionId: slot.remoteThreadId }
    } catch {
      return null
    }
  }

  closeArtifact(index: number): void {
    const slot = this.slots[index]
    if (!slot || !slot.artifact) return
    slot.artifact = null
    unregisterArtifact(index)
    this.persist()
    this.pushWindow(slot, DockSessionIpcChannel.Artifact, null)
    this.pushWindow(slot, DockSessionIpcChannel.Outputs, this.outputsPayload(index))
    const win = this.liveWindow(slot)
    if (win) this.resizeForArtifact(win, false)
  }

  // ---- the agent ---------------------------------------------------------

  private ensureAgent(slot: Slot): Agent {
    if (slot.agent) return slot.agent

    // Throws TransportError with user-facing copy when access is unavailable.
    const transport = this.modelAccess.createTransport()

    const folder = slot.folder ?? os.homedir()
    slot.agent = new Agent({
      transport,
      root: folder,
      folderName: folder === os.homedir() ? 'your home folder' : path.basename(folder),
      hostTools: this.createHostTools?.(),
    })
    // Resume the slot's durable conversation: the agent pushes into this same
    // array, so persisted state always reflects the current history.
    slot.agent.messages = slot.agentMessages

    // One mirror per conversation. A restored conversation resumes its
    // pre-relaunch mirror session so it uploads to Lore as one thread.
    const mirror = this.createTranscriptMirror?.(folder, slot.mirrorSessionId ?? undefined)
    if (mirror) {
      slot.mirror = mirror
      slot.mirrorSessionId = mirror.sessionId ?? slot.mirrorSessionId
      slot.agent.on('assistant_message', (content: unknown[]) => mirror.appendAssistant(content))
      slot.agent.on('tool_results_message', (results: unknown[]) => mirror.appendToolResults(results))
    }

    return slot.agent
  }

  async prompt(index: number, text: string): Promise<void> {
    const slot = this.slots[index]
    if (!slot || slot.busy || !text.trim()) return

    // Lore build: run the turn on the server backend instead of a local Agent.
    if (this.backend) {
      await this.promptViaBackend(slot, text)
      return
    }

    let agent: Agent
    try {
      agent = this.ensureAgent(slot)
    } catch (err) {
      this.appendTranscript(slot, {
        role: 'error',
        text: err instanceof Error ? err.message : String(err),
      })
      return
    }

    const isFirstPrompt = !slot.firstPrompt
    if (isFirstPrompt) {
      slot.firstPrompt = text
      this.persist()
    }

    slot.busy = true
    dockTrack('prompt_sent', { prompt_length: text.length, first_prompt: isFirstPrompt })
    this.appendTranscript(slot, { role: 'user', text })
    slot.mirror?.appendUser(text)
    this.changed()

    // One assistant bubble per turn; deltas append into it.
    const bubble: SessionEntry & { role: 'assistant' } = { role: 'assistant', text: '', tools: [] }
    // Tool calls in flight this turn, so a result can be matched to its input.
    const liveCalls = new Map<string, { id?: string; name: string; input: { path?: unknown; title?: unknown } }>()
    slot.transcript.push(bubble)
    this.pushWindow(slot, DockSessionIpcChannel.AssistantStart, {})

    const onText = (delta: string): void => {
      bubble.text += delta
      this.pushWindow(slot, DockSessionIpcChannel.Text, delta)
    }
    const onTool = (call: AgentToolEvent): void => {
      const tool: TranscriptTool = { id: call.id, label: call.label, input: call.input, output: null }
      bubble.tools.push(tool)
      liveCalls.set(call.id, { id: call.id, name: call.name, input: (call.input ?? {}) as { path?: unknown; title?: unknown } })
      this.pushWindow(slot, DockSessionIpcChannel.Tool, { id: call.id, label: call.label, input: call.input })
    }
    const onToolResult = ({ id, ok, output, doneLabel }: AgentToolResultEvent): void => {
      const entry = bubble.tools.find((t) => t.id === id)
      if (entry) {
        entry.output = output
        entry.ok = ok
        // Persist the finished label so a window reopen replays the done text.
        if (doneLabel) entry.label = doneLabel
      }
      this.pushWindow(slot, DockSessionIpcChannel.ToolResult, {
        id,
        ok,
        output,
        ...(doneLabel ? { label: doneLabel } : {}),
      })

      const call = liveCalls.get(id)
      if (call) {
        this.applyArtifactAction(slot, call, ok)
        this.recordKnownOutputRevision(slot, call, ok)
      }
    }

    agent.on('text', onText)
    agent.on('tool', onTool)
    agent.on('tool_result', onToolResult)

    // One outcome per turn, even if the agent were to emit error then done.
    const turnStartedAt = Date.now()
    let turnEnded = false
    const endTurnTelemetry = (event: 'turn_completed' | 'turn_failed'): void => {
      if (turnEnded) return
      turnEnded = true
      dockTrack(event, { duration_ms: Date.now() - turnStartedAt })
    }

    const finish = (): void => {
      agent.off('text', onText)
      agent.off('tool', onTool)
      agent.off('tool_result', onToolResult)
      // Detach BOTH terminal handlers: the agent survives across turns
      // (ensureAgent reuses it), so the sibling once() left behind by the
      // path that didn't fire would replay finish on a later turn.
      agent.off('error', onTurnError)
      agent.off('done', onTurnDone)
      slot.busy = false
      this.notifyIfAway(slot)
      // No outcome: the local agent loop settles no Evidence, so there is
      // nothing durably known about the task to claim (`SessionDonePayload`).
      this.pushWindow(slot, DockSessionIpcChannel.Done, {})
      // The turn is complete: capture the finished bubble and agent history.
      this.persist()
      this.changed()
    }

    const onTurnError = ({ message }: { message: string }): void => {
      dockLog.error('agent_error', { slot: this.slots.indexOf(slot), message })
      this.appendTranscript(slot, { role: 'error', text: message })
      endTurnTelemetry('turn_failed')
      finish()
    }
    const onTurnDone = ({ stopReason }: AgentDoneEvent): void => {
      // Same contract as the server-backed path: a stop leaves the turn
      // wherever it was, so it has to say so rather than look finished.
      if (stopReason === 'aborted') {
        this.appendTranscript(slot, { role: 'notice', text: STOPPED_TURN_NOTICE })
      }
      endTurnTelemetry('turn_completed')
      this.requestSlotOutputMirrorRetries(slot)
      finish()
    }
    agent.once('error', onTurnError)
    agent.once('done', onTurnDone)

    await agent.send(text)
  }

  /**
   * Run one turn through the injected server backend. Mirrors the local path's
   * busy/firstPrompt/telemetry/transcript handling, but delegates the model
   * loop + tool execution to the backend, which renders results through the
   * sink (mapped onto the same session IPC channels). Resolving the backend's
   * promise ends the turn.
   */
  private async promptViaBackend(
    slot: Slot,
    text: string,
    operation?: (slot: SessionBackendSlot, sink: SessionRenderSink, start: () => void) => Promise<boolean>,
    approvalDecision = false,
  ): Promise<void> {
    const backend = this.backend
    if (!backend) return

    const isFirstPrompt = !approvalDecision && !slot.firstPrompt
    if (isFirstPrompt) {
      slot.firstPrompt = text
      this.persist()
    }

    slot.busy = true
    slot.remoteStopRequested = false
    if (!approvalDecision) {
      dockTrack('prompt_sent', { prompt_length: text.length, first_prompt: isFirstPrompt })
      this.appendTranscript(slot, { role: 'user', text })
    }
    this.changed()

    const bubble: SessionEntry & { role: 'assistant' } = { role: 'assistant', text: '', tools: [] }
    const liveCalls = new Map<string, { id?: string; name: string; input: { path?: unknown; title?: unknown } }>()
    let ownsTurn = !approvalDecision
    let started = false
    const start = (): void => {
      if (started) return
      started = true
      ownsTurn = true
      slot.transcript.push(bubble)
      try { this.pushWindow(slot, DockSessionIpcChannel.AssistantStart, {}) } catch { /* renderer closed during delivery */ }
    }
    if (!approvalDecision) start()

    const generation = slot.generation
    let backendSlot!: SessionBackendSlot
    const current = (): boolean => slot.generation === generation && slot.backendSlot === backendSlot
    backendSlot = this.backendHandle(slot, generation, current, (handle) => this.refreshCompatibility(slot, handle))
    slot.backendSlot = backendSlot

    // What the turn settled, held until `Done` — the one push that ends a turn.
    let settled: SessionDonePayload = {}

    const sink: SessionRenderSink = {
      progress: (phase) => {
        if (!current()) return
        this.pushWindow(slot, DockSessionIpcChannel.Progress, phase)
      },
      text: (delta) => {
        if (!current()) return
        bubble.text += delta
        this.pushWindow(slot, DockSessionIpcChannel.Text, delta)
      },
      tool: (id, label, input, name) => {
        if (!current()) return
        bubble.tools.push({ id, label, input, output: null })
        if (name) liveCalls.set(id, { id, name, input: (input ?? {}) as { path?: unknown; title?: unknown } })
        this.pushWindow(slot, DockSessionIpcChannel.Tool, { id, label, input })
      },
      terminal: (text, sources) => {
        if (!current()) return
        bubble.text = text
        if (sources?.length) bubble.sources = sources
        else delete bubble.sources
        this.pushWindow(slot, DockSessionIpcChannel.Terminal, { text, ...(sources?.length ? { sources } : {}) })
      },
      toolResult: (id, ok, output) => {
        if (!current()) return
        const entry = bubble.tools.find((t) => t.id === id)
        if (entry) {
          entry.output = output
          entry.ok = ok
        }
        this.pushWindow(slot, DockSessionIpcChannel.ToolResult, { id, ok, output })
        const call = liveCalls.get(id)
        if (call) {
          this.applyArtifactAction(slot, call, ok)
          this.recordKnownOutputRevision(slot, call, ok)
        }
      },
      error: (message) => {
        if (!current()) return
        this.appendTranscript(slot, { role: 'error', text: message })
      },
      notice: (message) => {
        if (!current()) return
        this.appendTranscript(slot, { role: 'notice', text: message })
      },
      outcome: (value, reference, detail) => {
        if (!current()) return
        settled = {
          outcome: value,
          ...(reference ? { reference } : {}),
          ...(detail ? { detail } : {}),
        }
      },
      review: (promptBlockId) => {
        if (current()) void this.refreshReview(slot, backendSlot, promptBlockId)
      },
      approvals: (items) => {
        if (!current()) return
        slot.approvalRequest += 1
        this.pushWindow(slot, DockSessionIpcChannel.Approvals, items)
      },
    }

    const turnStartedAt = Date.now()
    let turnEnded = false
    const endTurnTelemetry = (event: 'turn_completed' | 'turn_failed'): void => {
      if (turnEnded) return
      turnEnded = true
      dockTrack(event, { duration_ms: Date.now() - turnStartedAt })
    }

    let succeeded = false
    try {
      ownsTurn = operation
        ? await operation(backendSlot, sink, start)
        : (await backend.promptRemote(backendSlot, text, sink), true)
      succeeded = ownsTurn
      if (ownsTurn) endTurnTelemetry('turn_completed')
    } catch (err) {
      if (ownsTurn) {
        if (current()) sink.error(err instanceof Error ? err.message : String(err))
        endTurnTelemetry('turn_failed')
      }
    } finally {
      if (!current()) return
      if (ownsTurn && approvalDecision) await this.pushApprovals(slot)
      if (ownsTurn) {
        void this.refreshSourcesForSlot(slot)
        if (succeeded) this.requestSlotOutputMirrorRetries(slot)
      }
      slot.busy = false
      slot.remoteStopRequested = false
      slot.backendSlot = null
      if (ownsTurn) this.notifyIfAway(slot)
      // Written to the transcript BEFORE the push, and independently of it.
      // `pushWindow` drops silently when the session window is gone, and a
      // remote turn keeps streaming after its window closes (`win.on('closed')`
      // aborts only the local agent) — so a live-only outcome would be lost
      // exactly when the user most needs the reference it carries, while the
      // prose and error entries around it replayed intact. Appended here rather
      // than inside `outcome()` so it lands once per turn, after any error the
      // catch above recorded. Deliberately not through `appendTranscript`: that
      // pushes the `Entry` channel, and this primitive's channel is `Done`.
      if (ownsTurn && settled.outcome) {
        slot.transcript.push({
          role: 'outcome',
          outcome: settled.outcome,
          ...(settled.reference ? { reference: settled.reference } : {}),
          // Persisted with the headline it belongs to, not instead of it: a
          // replay that kept one and dropped the other would put a neutral
          // "Finished" back on screen with nothing underneath — the exact state
          // that reads the same as an outcome this build could not name.
          ...(settled.detail ? { detail: settled.detail } : {}),
        })
      }
      if (ownsTurn) this.pushWindow(slot, DockSessionIpcChannel.Done, settled)
      if (ownsTurn && settled.reference && backend.fetchReview) {
        await this.refreshReview(slot, backendSlot, settled.reference)
      }
      if (ownsTurn) await this.annotateEvidence(slot)
      this.persist()
      this.changed()
      if (ownsTurn) void this.refreshResume(this.slots.indexOf(slot))
    }
  }

  /** Tear down any remote backend resources bound to a slot and forget its id. */
  private disposeBackendSlot(slot: Slot): void {
    if (!this.backend || !slot.remoteThreadId) return
    const folder = slot.folder ?? os.homedir()
    const manager = this
    this.backend.disposeSlot?.({
      folder,
      slotKey: slot,
      get remoteThreadId(): string | null {
        return slot.remoteThreadId
      },
      set remoteThreadId(value: string | null) {
        manager.setSlotRemoteThreadId(slot, value)
      },
      get pendingSources(): PendingSlotSource[] {
        return slot.pendingSources
      },
      set pendingSources(value: PendingSlotSource[]) {
        slot.pendingSources = value
      },
    })
    this.setSlotRemoteThreadId(slot, null)
  }

  stop(index: number): void {
    const slot = this.slots[index]
    if (!slot) return
    if (this.backend) {
      if (!slot.busy || slot.remoteStopRequested || !this.backend.stopRemote) return
      slot.remoteStopRequested = true
      dockTrack('generation_stopped')
      const backendSlot = slot.backendSlot
      if (!backendSlot) return
      void this.backend.stopRemote(backendSlot).catch((err) => {
        dockLog.warn('remote_stop_failed', {
          slot: this.slots.indexOf(slot),
          error: err instanceof Error ? err.message : String(err),
        })
      })
      return
    }
    if (!slot.agent) return
    if (slot.busy) dockTrack('generation_stopped')
    slot.agent.abort()
  }

  slotFolder(index: number): string | null {
    return this.slots[index]?.folder ?? null
  }

  /**
   * Agents hold the key they were built with; drop them when it changes.
   * An in-flight turn is left to finish on the old key, as the source did.
   * The conversation itself survives: the next agent is seeded from
   * `slot.agentMessages` and the mirror resumes via `slot.mirrorSessionId`.
   */
  resetAgents(): void {
    for (const slot of this.slots) {
      slot.agent = null
      slot.mirror = null
    }
  }

  private appendTranscript(slot: Slot, entry: SessionEntry): void {
    slot.transcript.push(entry)
    this.persist()
    this.pushWindow(slot, DockSessionIpcChannel.Entry, entry)
  }

  /** The agent finished while the user was looking elsewhere: badge the slot. */
  private notifyIfAway(slot: Slot): void {
    const win = this.liveWindow(slot)
    if (win && !win.isFocused()) slot.hasNotification = true
  }

  // ---- bulk actions ------------------------------------------------------

  /**
   * End the session and remove its card from the strip. The last remaining
   * slot is blanked in place instead — the store floors slotCount at 1.
   */
  closeSlot(index: number): boolean {
    const slot = this.slots[index]
    if (!slot) return false
    const win = this.liveWindow(slot)
    unregisterArtifact(index)
    if (slot.agent) slot.agent.abort()
    this.disposeBackendSlot(slot)
    if (win) win.destroy()
    dockTrack('session_closed')
    if (this.slots.length > 1) {
      this.slots.splice(index, 1)
      this.reindexArtifacts(index)
    } else {
      this.slots[index] = this.blankSlot()
    }
    dockLog.info('slot_ended', { slot: index })
    this.persist()
    this.changed()
    return true
  }

  /**
   * Removing a slot shifts every slot after it one index left, but artifact://
   * hosts are keyed by index. Drop the stale registrations and re-register
   * (and re-push) each shifted slot's artifact under its new index.
   */
  private reindexArtifacts(from: number): void {
    for (let i = from; i <= this.slots.length; i++) unregisterArtifact(i)
    for (let i = from; i < this.slots.length; i++) {
      const slot = this.slots[i]
      if (slot.artifact) this.pushWindow(slot, DockSessionIpcChannel.Artifact, this.artifactPayload(i, slot))
      this.pushWindow(slot, DockSessionIpcChannel.Outputs, this.outputsPayload(i))
    }
  }

  /** Return a session window to its Workbench slot without moving it. */
  private static tuckAway(slot: Slot, win: BrowserWindow): boolean {
    if (slot.tucked || win.isMinimized() || !win.isVisible()) return false
    slot.tucked = true
    win.hide()
    return true
  }

  minimizeSlot(index: number): boolean {
    const slot = this.slots[index]
    const win = slot && this.liveWindow(slot)
    if (!win || slot.tucked || win.isMinimized()) return false
    const hidden = SessionManager.tuckAway(slot, win)
    this.changed()
    return hidden
  }

  minimizeAll(): number {
    let count = 0
    for (const slot of this.slots) {
      const win = this.liveWindow(slot)
      if (win && SessionManager.tuckAway(slot, win)) count++
    }
    this.changed()
    return count
  }

  disposeAll(): void {
    this.unsubscribeCompatibility?.()
    this.unsubscribeCompatibility = undefined
    this.persist()
    for (const slot of this.slots) {
      if (slot.agent) slot.agent.abort()
      const win = this.liveWindow(slot)
      if (win) win.destroy()
    }
  }
}
