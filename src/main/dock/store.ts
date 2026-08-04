/**
 * Persisted dock-widget state (slot count, slot names/folders, visibility),
 * ported from claude-dock `src/shared/store.js`.
 *
 * Lives at `userData/dock-state.json` — namespaced so it can never collide
 * with Lore's own `session.bin` / `window-state.json`.
 */
import fs from 'node:fs'
import path from 'node:path'

import { LAYOUT, type CitationSource, type DockPosition, type ProjectResumeCache, type ProjectResumePayload, type SessionEntry, type TranscriptTool } from '../../shared/dock'
import { MAX_SLOT_OUTPUTS, type SlotArtifact, type SlotOutput } from '../../shared/dockArtifact'
import { dockLog } from './log'

export interface PersistedSlot {
  customName: string | null
  folder: string | null
  artifact: SlotArtifact | null
  outputs: SlotOutput[]
  firstPrompt: string | null
  /** The replayable display transcript, so a reopened slot shows its session. */
  transcript: SessionEntry[]
  /** The agent's verbatim Anthropic message history, so the model resumes with context. */
  agentMessages: unknown[]
  /** Lore transcript-mirror session id, so post-relaunch turns append to the same upload file. */
  mirrorSessionId: string | null
  /** Server-side Dock conversation identity. No auth or connection state is persisted. */
  remoteThreadId: string | null
  projectCreationKey?: string | null
  projectId?: string | null
  projectResumeCache?: ProjectResumeCache | null
  /**
   * Reference documents ingested while this Slot had no remote Thread yet
   * (TAN-5456 Task 9), so a source added before the first prompt survives a
   * relaunch and is registered once a Thread exists.
   */
  pendingSources: PendingSlotSource[]
}

/** One reference document a Slot has copied locally but not yet registered. */
export interface PendingSlotSource {
  relativePath: string
  title: string
  /** Present only after the most recent registration attempt failed. */
  registrationFailed?: boolean
}

export interface PersistedDockState {
  slotCount: number
  slots: PersistedSlot[]
  /** Whether the dock strip was visible when the app last ran. */
  dockVisible: boolean
  /** Last user-selected top-left screen coordinate; clamped on restore. */
  dockPosition: DockPosition | null
  /** Last horizontal position of the compact bottom-edge handle. */
  dockHandlePosition: DockPosition | null
  /** Keep the full strip visible instead of resting as a compact edge handle. */
  dockPinned: boolean
}

export const DEFAULT_STATE: PersistedDockState = {
  slotCount: LAYOUT.initialSlots,
  slots: [],
  dockVisible: false,
  dockPosition: null,
  dockHandlePosition: null,
  // The dock always rests as the full, draggable strip — never the compact
  // edge handle. showDock normalizes any legacy persisted `false` to open on
  // launch, so existing installs open too. Kept persisted (always true) so the
  // drag-position path in persistDockPosition writes dockPosition.
  dockPinned: true,
}

const MIN_NATIVE_COORDINATE = -2_147_483_648
const MAX_NATIVE_COORDINATE = 2_147_483_647

function screenCoordinate(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  return rounded >= MIN_NATIVE_COORDINATE && rounded <= MAX_NATIVE_COORDINATE ? rounded : null
}

export function sanitize(raw: unknown): PersistedDockState {
  const state: PersistedDockState = { ...DEFAULT_STATE, slots: [] }
  if (!raw || typeof raw !== 'object') return state
  const input = raw as Record<string, unknown>

  if (Number.isInteger(input.slotCount)) {
    state.slotCount = Math.min(Math.max(input.slotCount as number, 1), 12)
  }

  if (Array.isArray(input.slots)) {
    state.slots = input.slots.slice(0, state.slotCount).map((s: unknown) => {
      const slot = (s ?? {}) as Record<string, unknown>
      const rawArtifact = (slot.artifact ?? null) as Record<string, unknown> | null
      const artifact =
        rawArtifact && typeof rawArtifact.path === 'string' && typeof rawArtifact.title === 'string'
          ? { path: rawArtifact.path, title: rawArtifact.title }
          : null
      return {
        customName: typeof slot.customName === 'string' ? slot.customName : null,
        folder: typeof slot.folder === 'string' ? slot.folder : null,
        artifact,
        outputs: Object.hasOwn(slot, 'outputs')
          ? sanitizeOutputs(slot.outputs)
          : artifact
            ? [{
                path: artifact.path,
                title: artifact.title,
                contentHash: null,
                versionOrdinal: 1,
                demoted: false,
                demotionPending: false,
                updatedAtMs: 0,
                mirrored: false,
              }]
            : [],
        firstPrompt: typeof slot.firstPrompt === 'string' ? slot.firstPrompt : null,
        transcript: sanitizeTranscript(slot.transcript),
        agentMessages: Array.isArray(slot.agentMessages) ? (slot.agentMessages as unknown[]) : [],
        mirrorSessionId: typeof slot.mirrorSessionId === 'string' ? slot.mirrorSessionId : null,
        remoteThreadId: typeof slot.remoteThreadId === 'string' ? slot.remoteThreadId : null,
        projectCreationKey: typeof slot.projectCreationKey === 'string' ? slot.projectCreationKey : null,
        projectId: typeof slot.projectId === 'string' ? slot.projectId : null,
        projectResumeCache: sanitizeProjectResumeCache(slot.projectResumeCache),
        // Defaults to `[]` for a persisted Slot from before this field
        // existed, and for anything malformed within it.
        pendingSources: sanitizePendingSources(slot.pendingSources),
      }
    })
  }

  if (typeof input.dockVisible === 'boolean') {
    state.dockVisible = input.dockVisible
  }
  if (typeof input.dockPinned === 'boolean') {
    state.dockPinned = input.dockPinned
  }
  const position = input.dockPosition as Record<string, unknown> | null
  const x = screenCoordinate(position?.x)
  const y = screenCoordinate(position?.y)
  if (x !== null && y !== null) {
    state.dockPosition = { x, y }
  }
  const handlePosition = input.dockHandlePosition as Record<string, unknown> | null
  const handleX = screenCoordinate(handlePosition?.x)
  const handleY = screenCoordinate(handlePosition?.y)
  if (handleX !== null && handleY !== null) {
    state.dockHandlePosition = { x: handleX, y: handleY }
  }
  return state
}

function sanitizeProjectResumeCache(raw: unknown): ProjectResumeCache | null {
  if (!raw || typeof raw !== 'object') return null
  const cache = raw as Record<string, unknown>
  if (!date(cache.cachedAt)) return null
  return isProjectResumePayload(cache.resume) ? { cachedAt: cache.cachedAt, resume: cache.resume } : null
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const text = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
// Kept host-neutral while matching the canonical `z.iso.datetime()` contract.
const ISO_DATETIME = /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z$/
const date = (value: unknown): value is string => typeof value === 'string' && ISO_DATETIME.test(value)
const url = (value: unknown): value is string => typeof value === 'string' && URL.canParse(value)
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum
const relativePath = (value: unknown): value is string => text(value) && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..')
const nullableText = (value: unknown): boolean => value === null || text(value)

function terminal(value: unknown): boolean {
  if (!record(value) || !exact(value, ['kind', 'turnRef', 'outcomeId', 'outcome', 'detail', 'verification', 'completedAt', 'effectCount', 'reviewId'])) return false
  return value.kind === 'terminal' && text(value.turnRef) && text(value.outcomeId) && ['verified_success', 'unverified_completion', 'partial_success', 'blocked', 'exhausted', 'cancelled', 'failed', 'unknown'].includes(String(value.outcome))
    && text(value.detail, 4_000) && ['passed', 'failed', 'unchecked', 'unknown', 'unavailable'].includes(String(value.verification)) && date(value.completedAt) && integer(value.effectCount) && nullableText(value.reviewId)
}

function collection(value: unknown, cap: number, item: (entry: unknown) => boolean): boolean {
  return record(value) && exact(value, ['items', 'totalCount']) && Array.isArray(value.items) && value.items.length <= cap && value.items.every(item) && integer(value.totalCount) && value.totalCount >= value.items.length
}

function isProjectResumePayload(value: unknown): value is ProjectResumePayload {
  if (!record(value) || !exact(value, ['project', 'objective', 'nextStepRevision', 'repository', 'sources', 'outputs', 'workProgram', 'decisions', 'currentWork', 'latestCompletedWork', 'nextAction'])) return false
  const project = value.project; const objective = value.objective
  if (!record(project) || !exact(project, ['id', 'primaryThreadId', 'updatedAt']) || !/^dprj_.+/.test(String(project.id)) || !/^th_.+/.test(String(project.primaryThreadId)) || !date(project.updatedAt)) return false
  if (!record(objective) || !exact(objective, ['text', 'source', 'sourceTurnRef', 'revision', 'updatedAt', 'updatedByUserId', 'suggestion']) || !text(objective.text, 100_000) || !integer(objective.revision, 1) || !date(objective.updatedAt)) return false
  if (!(objective.source === 'lore' ? text(objective.sourceTurnRef) && objective.updatedByUserId === null : objective.source === 'user' && objective.sourceTurnRef === null && text(objective.updatedByUserId))) return false
  if (objective.suggestion !== null && (!record(objective.suggestion) || !exact(objective.suggestion, ['text', 'sourceTurnRef', 'suggestedAt']) || !text(objective.suggestion.text, 4_000) || !text(objective.suggestion.sourceTurnRef) || !date(objective.suggestion.suggestedAt))) return false
  if (!integer(value.nextStepRevision) || (value.repository !== null && (!record(value.repository) || !exact(value.repository, ['label']) || !text(value.repository.label, 1_000)))) return false
  if (!collection(value.sources, 20, (entry) => record(entry) && (entry.kind === 'lore_thread'
    ? exact(entry, ['id', 'kind', 'title', 'relativePath', 'boundAt', 'loreThreadId', 'loreThreadUrl']) && /^th_.+/.test(String(entry.loreThreadId)) && url(entry.loreThreadUrl)
    : (entry.kind === 'document' || entry.kind === 'artifact') && exact(entry, ['id', 'kind', 'title', 'relativePath', 'boundAt', 'loreThreadId']) && entry.loreThreadId === null)
    && text(entry.id) && text(entry.title, 1_000) && relativePath(entry.relativePath) && date(entry.boundAt))) return false
  if (!collection(value.outputs, 20, (entry) => record(entry) && exact(entry, ['id', 'path', 'title', 'versionOrdinal', 'mimeType', 'updatedAt']) && text(entry.id) && relativePath(entry.path) && text(entry.title, 1_000) && integer(entry.versionOrdinal, 1) && nullableText(entry.mimeType) && date(entry.updatedAt))) return false
  if (value.workProgram !== null && (!record(value.workProgram) || !exact(value.workProgram, ['outputId', 'title', 'selectedItemLabel']) || !text(value.workProgram.outputId) || !text(value.workProgram.title, 1_000) || !(value.workProgram.selectedItemLabel === null || text(value.workProgram.selectedItemLabel, 4_000)))) return false
  if (!collection(value.decisions, 10, (entry) => record(entry) && exact(entry, ['id', 'kind', 'summary', 'sourceBlockId', 'createdAt']) && text(entry.id) && ['asked', 'requested', 'decided', 'corrected', 'shared', 'requirement'].includes(String(entry.kind)) && text(entry.summary, 4_000) && text(entry.sourceBlockId) && date(entry.createdAt))) return false
  const current = value.currentWork
  if (!record(current) || !(current.kind === 'none' ? exact(current, ['kind']) : current.kind === 'unsettled' ? exact(current, ['kind', 'turnRef', 'startedAt', 'reason']) && text(current.turnRef) && date(current.startedAt) && ['turn_running', 'effect_in_flight', 'effect_unknown', 'reconciliation_pending'].includes(String(current.reason)) : terminal(current))) return false
  if (value.latestCompletedWork !== null && !terminal(value.latestCompletedWork)) return false
  const action = value.nextAction
  if (!record(action) || !(action.kind === 'none' ? exact(action, ['kind']) : action.kind === 'host_blocker'
    ? exact(action, ['kind', 'target', 'turnRef', 'label']) && ['reconcile', 'approval', 'review'].includes(String(action.target)) && text(action.turnRef) && text(action.label, 4_000)
    : action.kind === 'recommendation' && exact(action, ['kind', 'text', 'source', 'sourceTurnRef', 'updatedByUserId', 'revision', 'updatedAt']) && text(action.text, 2_000) && integer(action.revision) && date(action.updatedAt) && (action.source === 'lore' ? text(action.sourceTurnRef) && action.updatedByUserId === null : action.source === 'user' && action.sourceTurnRef === null && text(action.updatedByUserId)))) return false
  return true
}

function sanitizeOutputs(raw: unknown): SlotOutput[] {
  if (!Array.isArray(raw)) return []
  const outputs = raw.flatMap((item): SlotOutput[] => {
    if (!item || typeof item !== 'object') return []
    const output = item as Record<string, unknown>
    if (typeof output.path !== 'string') return []
    return [{
      path: output.path,
      title: typeof output.title === 'string' ? output.title : output.path,
      contentHash:
        typeof output.contentHash === 'string' && /^sha256:[0-9a-f]{64}$/.test(output.contentHash)
          ? output.contentHash
          : null,
      versionOrdinal:
        Number.isSafeInteger(output.versionOrdinal) && (output.versionOrdinal as number) > 0
          ? output.versionOrdinal as number
          : 1,
      demoted: typeof output.demoted === 'boolean' ? output.demoted : false,
      demotionPending: typeof output.demotionPending === 'boolean' ? output.demotionPending : false,
      updatedAtMs:
        Number.isSafeInteger(output.updatedAtMs) && (output.updatedAtMs as number) >= 0
          ? output.updatedAtMs as number
          : 0,
      mirrored: typeof output.mirrored === 'boolean' ? output.mirrored : false,
    }]
  })
  if (outputs.length <= MAX_SLOT_OUTPUTS) return outputs
  return outputs.sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, MAX_SLOT_OUTPUTS)
}

function sanitizeTranscript(raw: unknown): SessionEntry[] {
  if (!Array.isArray(raw)) return []
  const out: SessionEntry[] = []
  for (const e of raw) {
    const entry = (e ?? {}) as Record<string, unknown>
    // The only entry keyed on something other than `text`: it stores the raw
    // outcome so a replay re-derives the copy rather than resurrecting a
    // rendered claim written by an older build. `detail` is the host's own
    // sentence and cannot be re-derived here, so it is kept — but kept the same
    // way everything else is, by validating it rather than trusting the file.
    if (entry.role === 'outcome') {
      if (typeof entry.outcome !== 'string' || !entry.outcome) continue
      out.push({
        role: 'outcome',
        outcome: entry.outcome,
        ...(typeof entry.reference === 'string' && entry.reference ? { reference: entry.reference } : {}),
        ...(typeof entry.detail === 'string' && entry.detail ? { detail: entry.detail } : {}),
      })
      continue
    }
    if (typeof entry.text !== 'string') continue
    if (entry.role === 'user' || entry.role === 'error' || entry.role === 'notice') {
      out.push({ role: entry.role, text: entry.text })
    } else if (entry.role === 'assistant') {
      const sources = sanitizeCitationSources(entry.sources)
      out.push({
        role: 'assistant',
        text: entry.text,
        tools: Array.isArray(entry.tools) ? (entry.tools as TranscriptTool[]) : [],
        ...(sources.length ? { sources } : {}),
      })
    }
  }
  return out
}

function sanitizePendingSources(raw: unknown): PendingSlotSource[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): PendingSlotSource[] => {
    if (!item || typeof item !== 'object') return []
    const entry = item as Record<string, unknown>
    if (typeof entry.relativePath !== 'string' || typeof entry.title !== 'string') return []
    return [{
      relativePath: entry.relativePath,
      title: entry.title,
      ...(entry.registrationFailed === true ? { registrationFailed: true } : {}),
    }]
  })
}

function sanitizeCitationSources(raw: unknown): CitationSource[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): CitationSource[] => {
    if (!item || typeof item !== 'object') return []
    const source = item as Record<string, unknown>
    if (
      typeof source.threadId !== 'string'
      || (source.blockId !== null && typeof source.blockId !== 'string')
      || typeof source.title !== 'string'
      || (source.summary !== null && typeof source.summary !== 'string')
      || typeof source.startedAt !== 'string'
      || (source.matchedBy !== 'summary' && source.matchedBy !== 'decision' && source.matchedBy !== 'thread')
      || (source.decisionSummary !== null && typeof source.decisionSummary !== 'string')
    ) return []
    return [{
      threadId: source.threadId,
      blockId: source.blockId,
      title: source.title,
      summary: source.summary,
      startedAt: source.startedAt,
      matchedBy: source.matchedBy,
      decisionSummary: source.decisionSummary,
    }]
  })
}

export class DockStore {
  private file: string
  private state: PersistedDockState
  private timer: NodeJS.Timeout | null = null

  constructor(file: string) {
    this.file = file
    this.state = sanitize(this.read())
  }

  private read(): unknown {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return null
    }
  }

  get(): PersistedDockState {
    return this.state
  }

  set(patch: Partial<PersistedDockState>): void {
    this.state = sanitize({ ...this.state, ...patch })
    this.scheduleSave()
  }

  /** Coalesce bursts of writes; slot renames fire on every keystroke. */
  scheduleSave(delay = 250): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.save(), delay)
    this.timer.unref?.()
  }

  save(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      // Write-then-rename so an interrupted save cannot truncate the real file.
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      // Persistence is a convenience; never let it take down the app.
      dockLog.warn('state_save_failed', { file: this.file, error: err instanceof Error ? err.message : String(err) })
    }
  }
}
