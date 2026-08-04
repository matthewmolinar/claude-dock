import type { ApprovalPayload, ArtifactPayload, EvidenceResult, OutputsPayload, ProjectResumeState, ProjectTerminalWorkPayload, SessionCompatibilityState, SourcesPayload, TurnReviewPayload } from '../../shared/dock'
import type { SourceDocumentPreviewResult } from '../../shared/dockSourcePreview'
import type { EvidenceDetail } from '../../shared/dockHostTypes'

export type SessionWorkState = 'idle' | 'working' | 'stopping'
export type SessionWorkEvent = 'prompt' | 'stop' | 'done'

export type CompatibilityNoticeView =
  | { hidden: true }
  | { hidden: false; message: string; action: string }

function words(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./, (character) => character.toUpperCase())
}

function terminalWorkPresentation(work: ProjectTerminalWorkPayload): { kind: 'terminal'; label: string; turnRef: string; reviewId: string | null } {
  return { kind: 'terminal', label: `${words(work.outcome)} · Verification ${words(work.verification).toLowerCase()}`, turnRef: work.turnRef, reviewId: work.reviewId }
}

export function projectResumePresentation(state: ProjectResumeState) {
  if (state.status === 'unavailable') return { status: 'unavailable' as const, message: 'Project state temporarily unavailable', writable: false as const }
  const { data } = state
  const currentWork = data.currentWork.kind === 'none'
    ? { kind: 'none' as const, label: 'No current work' }
    : data.currentWork.kind === 'unsettled'
      ? { kind: 'unsettled' as const, label: words(data.currentWork.reason), turnRef: data.currentWork.turnRef }
      : terminalWorkPresentation(data.currentWork)
  const nextAction = data.nextAction.kind === 'none'
    ? { kind: 'none' as const, label: 'No next step suggested', revision: data.nextStepRevision, canEdit: state.writable }
    : data.nextAction.kind === 'host_blocker'
      ? { kind: 'host_blocker' as const, label: data.nextAction.label, target: data.nextAction.target, turnRef: data.nextAction.turnRef, canEdit: false as const }
      : { kind: 'recommendation' as const, label: data.nextAction.text, provenance: data.nextAction.source === 'lore' ? 'Suggested by Lore' : 'Set by you', seed: data.nextAction.text, revision: data.nextAction.revision, canEdit: state.writable }
  const cachedDate = new Date(state.cachedAt)
  return {
    status: 'available' as const,
    writable: state.writable,
    cacheLabel: state.freshness === 'cached' ? `Offline · Last updated ${cachedDate.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })}` : null,
    objective: {
      text: data.objective.text,
      revision: data.objective.revision,
      provenance: data.objective.source === 'lore' ? 'Autofilled' : 'Confirmed by you',
      canEdit: state.writable,
      suggestion: data.objective.suggestion && { text: data.objective.suggestion.text, sourceTurnRef: data.objective.suggestion.sourceTurnRef },
    },
    nextAction,
    currentWork,
    completedWork: data.latestCompletedWork ? terminalWorkPresentation(data.latestCompletedWork) : { kind: 'none' as const, label: 'No completed work yet' },
    workProgramLabel: data.workProgram?.title ?? 'No work program yet',
    sourcesLabel: data.sources.totalCount ? `Sources ${data.sources.totalCount}` : 'No sources yet',
    outputsLabel: data.outputs.totalCount ? `Outputs ${data.outputs.totalCount}` : 'No outputs yet',
    decisionsLabel: data.decisions.totalCount ? `Decisions ${data.decisions.totalCount}` : 'No decisions yet',
  }
}

export function compatibilityNoticeView(
  compatibility: SessionCompatibilityState | undefined,
): CompatibilityNoticeView {
  if (compatibility?.status !== 'update_required') return { hidden: true }
  return {
    hidden: false,
    message: 'Update Lore to restore file and command tools.',
    action: 'Check for Updates',
  }
}

/** Pure state transition shared by renderer behavior and focused tests. */
export function reduceSessionState(state: SessionWorkState, event: SessionWorkEvent): SessionWorkState {
  if (event === 'done') return 'idle'
  if (event === 'prompt') return state === 'idle' ? 'working' : state
  return state === 'working' ? 'stopping' : state
}

/** Canonical terminal prose replaces (rather than appends to) provider prose. */
export function replaceAssistantText(_current: string, terminal: string): string {
  return terminal
}

export function reconcileApprovals(
  current: ReadonlyMap<string, ApprovalPayload>,
  pushed: readonly ApprovalPayload[],
): Map<string, ApprovalPayload> {
  const next = new Map(pushed.map((item) => [item.toolCallId, item]))
  for (const [toolCallId, item] of current) {
    if (item.state === 'declined') next.set(toolCallId, item)
  }
  return next
}

/** Review pushes are complete snapshots, keyed to the Outcome prompt reference. */
export function reconcileReviews(
  _current: ReadonlyMap<string, TurnReviewPayload>,
  pushed: readonly TurnReviewPayload[],
): Map<string, TurnReviewPayload> {
  return new Map(pushed.map(item => [item.promptBlockId, item]))
}

export function approvalActions(item: ApprovalPayload): Array<'grant_once' | 'grant_prefix' | 'deny'> {
  return item.tier === 'non_allowlisted_shell' && item.eligiblePrefix
    ? ['grant_once', 'grant_prefix', 'deny']
    : ['grant_once', 'deny']
}

export function approvalControlState(
  item: ApprovalPayload,
  workState: SessionWorkState,
  grantSubmissionEffectId: string | null,
): { disabled: boolean; applying: boolean; message: string | null } {
  if (item.state === 'granted' || item.effectId === grantSubmissionEffectId) {
    return { disabled: true, applying: true, message: 'Applying approved change…' }
  }
  if (grantSubmissionEffectId) {
    return { disabled: true, applying: false, message: 'Another approval is being applied.' }
  }
  if (workState !== 'idle') {
    return { disabled: true, applying: false, message: 'Approval controls are read-only while Lore is working.' }
  }
  return { disabled: false, applying: false, message: null }
}

export type EvidenceViewState =
  | { status: 'idle' | 'loading' | 'not_found' | 'unavailable' | 'failure'; detail: null; generation: number }
  | { status: 'success'; detail: EvidenceDetail; generation: number }

export function beginEvidenceFetch(generation: number): EvidenceViewState { return { status: 'loading', detail: null, generation: generation + 1 } }
export function settleEvidenceFetch(current: EvidenceViewState, generation: number, status: Exclude<EvidenceViewState['status'], 'idle' | 'loading'>, detail?: EvidenceDetail): EvidenceViewState {
  if (generation !== current.generation) return current
  return status === 'success' && detail ? { status, detail, generation } : { status: status === 'success' ? 'failure' : status, detail: null, generation }
}

export function evidenceFailure(): EvidenceResult {
  return { status: 'failure', message: 'Evidence could not be loaded.' }
}

export function evidenceShareTarget(detail: EvidenceDetail, shareOrganizationId: string | null): boolean {
  return detail.visibility === 'private' && Boolean(shareOrganizationId)
}

export function evidencePresentation(detail: EvidenceDetail): string[] {
  if (detail.kind === 'dock_turn_outcome') return [`Outcome ${detail.outcome}`, `Settlement ${detail.stopReason}`, ...detail.verificationConclusions.map((item) => `Verification ${item.status}`), `Visibility ${detail.visibility}`]
  const authorityId = detail.authority.source === 'approval'
    ? `Approval ${detail.authority.approvalId}`
    : detail.authority.source === 'standing_policy' ? `Standing policy ${detail.authority.standingPolicyId}` : null
  const requirement = detail.authority.requirement
  return [`Action ${detail.action}`, `Scope ${detail.scope ?? 'This Slot'}`, `Settlement ${detail.settlement}`, ...detail.attempts.map((item) => `Attempt ${item.ordinal} ${item.status}; Receipt ${item.receiptPresent ? 'present' : 'absent'}`), ...detail.verifications.map((item) => `Verification ${item.status} ${item.policy}`), `Authority source ${detail.authority.source}`, `Authorization ${detail.authority.authorizationId}`, ...(authorityId ? [authorityId] : []), ...(requirement ? [`Requirement tier ${requirement.tier}`, `Requirement scope ${requirement.scope}`, `Requirement policyVersion ${requirement.policyVersion}`] : []), `Visibility ${detail.visibility}`]
}

export interface OutputRowView {
  path: string
  label: string
  meta: string
  shown: boolean
  demoted: boolean
  available: boolean
  mirrored: boolean
}

function outputBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export function outputsPresentation(payload: OutputsPayload): {
  rows: OutputRowView[]
  count: number
  hasDemoted: boolean
  showRemovedRecovery: boolean
} {
  const rows = payload.outputs.map((output) => {
    const meta = [
      output.versionOrdinal > 1 ? `revised ×${output.versionOrdinal}` : '',
      output.available ? '' : 'file unavailable',
      output.mirrored ? '' : 'not yet in Lore',
    ].filter(Boolean).join(' · ')
    return {
      path: output.path,
      label: output.title.trim() || outputBasename(output.path),
      meta,
      shown: output.shown,
      demoted: output.demoted,
      available: output.available,
      mirrored: output.mirrored,
    }
  })
  const count = rows.filter((row) => !row.demoted).length
  const hasDemoted = rows.some((row) => row.demoted)
  return {
    rows,
    count,
    hasDemoted,
    showRemovedRecovery: count === 0 && hasDemoted,
  }
}

export function outputsChromeVisibility(
  view: Pick<ReturnType<typeof outputsPresentation>, 'count' | 'showRemovedRecovery'>,
  removedOutputsVisible: boolean,
): { shellHidden: boolean; menuHidden: boolean; toggleHidden: boolean } {
  const toggleHidden = view.count === 0
  return {
    shellHidden: view.count === 0 && !view.showRemovedRecovery,
    menuHidden: toggleHidden && !(view.showRemovedRecovery && removedOutputsVisible),
    toggleHidden,
  }
}

export function revisePromptSeed(row: OutputRowView): string {
  return `Revise "${row.label}" (${row.path}): `
}

export interface SourceRowView {
  relativePath: string
  label: string
  status: string
  available: boolean
}

const sourceStatus = {
  ready: 'Ready for Lore',
  pending: 'Pending registration',
  waiting: 'Waiting for Lore',
  unavailable: 'Document unavailable',
} as const

export function sourcesPresentation(payload: SourcesPayload): {
  rows: SourceRowView[]
  count: number
  loadFailed: boolean
  retryable: boolean
} {
  const rows = payload.documents.map((document) => ({
    relativePath: document.relativePath,
    label: document.title.trim() || outputBasename(document.relativePath),
    status: sourceStatus[document.state],
    available: document.state !== 'unavailable',
  }))
  return {
    rows,
    count: rows.length,
    loadFailed: payload.loadState === 'error',
    retryable: payload.documents.some(document => document.state === 'waiting'),
  }
}

export type SourceInspectorPresentation =
  | { status: 'error'; message: string }
  | { status: 'success'; title: string; relativePath: string; text: string; format: 'markdown' | 'text' }

export function sourceInspectorPresentation(result: SourceDocumentPreviewResult): SourceInspectorPresentation {
  if (!result.ok) return { status: 'error', message: result.message }
  return {
    status: 'success',
    title: result.title,
    relativePath: result.relativePath,
    text: result.text,
    format: result.extension === '.md' || result.extension === '.markdown' ? 'markdown' : 'text',
  }
}

export interface WorkProgramActionMessage {
  type: 'work-program:implement'
  itemId: string
}

export function parseWorkProgramActionMessage(value: unknown): WorkProgramActionMessage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Reflect.ownKeys(value).filter((key) => Object.prototype.propertyIsEnumerable.call(value, key))
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('itemId')) return null
  const message = value as Record<string, unknown>
  if (message.type !== 'work-program:implement' || typeof message.itemId !== 'string' || !/^WP-\d{3}$/.test(message.itemId)) return null
  return { type: message.type, itemId: message.itemId }
}

function normalizedPromptValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function implementWorkProgramItemPromptSeed(input: {
  itemId: string
  title: string
  path: string
}): string {
  const title = normalizedPromptValue(input.title)
  const path = normalizedPromptValue(input.path)
  return `Implement work-program item ${input.itemId} from "${title}" (${path}). Read that item and use its problem, source finding or evidence, intended outcome, priority rationale, dependencies and risks, and completion test as the implementation brief.`
}

export function isWorkProgramMarkdownPath(path: string): boolean {
  const basename = path.slice(path.lastIndexOf('/') + 1)
  const extensionStart = basename.lastIndexOf('.')
  if (extensionStart <= 0) return false
  const extension = basename.slice(extensionStart).toLowerCase()
  return extension === '.md' || extension === '.markdown'
}

export function resolveWorkProgramAction(
  eventOrigin: string,
  value: unknown,
  artifact: ArtifactPayload,
  outputs: OutputsPayload['outputs'],
): { itemId: string; title: string; path: string } | null {
  const message = parseWorkProgramActionMessage(value)
  if (!message || !isWorkProgramMarkdownPath(artifact.path)) return null
  try {
    const parsed = new URL(artifact.url)
    const artifactOrigin = parsed.origin === 'null' ? `${parsed.protocol}//${parsed.host}` : parsed.origin
    if (eventOrigin !== artifactOrigin) return null
  } catch {
    return null
  }
  const shown = outputs.filter((output) => output.shown)
  if (shown.length !== 1 || shown[0].path !== artifact.path) return null
  return { itemId: message.itemId, title: shown[0].title, path: shown[0].path }
}

async function saveOutputCopyFeedback(
  save: () => Promise<{ ok: boolean; message?: string }>,
): Promise<{ label: string; title: string }> {
  try {
    const result = await save()
    if (result.ok) return { label: 'Saved', title: '' }
    return {
      label: result.message === 'Save canceled.' ? 'Save canceled' : 'Save failed',
      title: result.message ?? 'This output could not be saved.',
    }
  } catch {
    return { label: 'Save failed', title: 'This output could not be saved.' }
  }
}

export function createSaveOutputCopyAction(
  control: { disabled: boolean; textContent: string | null; title: string },
  save: () => Promise<{ ok: boolean; message?: string }>,
  timers: {
    scheduleReset: (reset: () => void) => unknown
    cancelReset: (timer: unknown) => void
  } = {
    scheduleReset: (reset) => setTimeout(reset, 3000),
    cancelReset: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  },
): () => Promise<void> {
  let resetTimer: unknown = null
  return async () => {
    if (resetTimer !== null) timers.cancelReset(resetTimer)
    resetTimer = null
    control.disabled = true
    control.textContent = 'Saving…'
    control.title = ''
    const feedback = await saveOutputCopyFeedback(save)
    control.textContent = feedback.label
    control.title = feedback.title
    control.disabled = false
    resetTimer = timers.scheduleReset(() => {
      control.textContent = 'Save a copy…'
      control.title = ''
      resetTimer = null
    })
  }
}

export async function copyEvidenceUrl(detail: EvidenceDetail, writeText: (value: string) => Promise<void>): Promise<void> {
  if (detail.copyUrl) await writeText(detail.copyUrl)
}
