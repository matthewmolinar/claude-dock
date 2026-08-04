/**
 * Dock session (chat) renderer, ported from claude-dock
 * `renderer/session/session.js`. Streams assistant text into bubbles and
 * tool activity into collapsible chips; replays the transcript on load.
 */
import { ARTIFACT_PANE_MIN_WIDTH, ARTIFACT_PANE_WIDTH, clampArtifactPaneWidth, describeTurnOutcome, openDesignatedWorkProgram, type ApprovalPayload, type ArtifactPayload, type CitationSource, type OutputsPayload, type ProjectEditResult, type ProjectResumePayload, type ProjectResumeState, type SessionBridge, type SourceActionNotice, type SourcesPayload, type ToolResultPayload, type ToolStartPayload, type TurnOutcomePresentation, type TurnReviewPayload } from '../../shared/dock'
import { renderMarkdown } from '../../shared/dockMarkdown'
import { resolveBlockerDestination } from './blockerNavigation'
import { initLoreWave } from './loreWave'
import { renderOutcome, renderReviewForOutcome } from './reviewCard'
import { approvalActions, approvalControlState, beginEvidenceFetch, compatibilityNoticeView, copyEvidenceUrl, createSaveOutputCopyAction, evidenceFailure, evidencePresentation, evidenceShareTarget, implementWorkProgramItemPromptSeed, outputsChromeVisibility, outputsPresentation, projectResumePresentation, reconcileApprovals, reconcileReviews, reduceSessionState, replaceAssistantText, resolveWorkProgramAction, revisePromptSeed, settleEvidenceFetch, sourceInspectorPresentation, sourcesPresentation, type EvidenceViewState, type SessionWorkState } from './sessionState'
import type { EvidenceDetail } from '../../shared/dockHostTypes'

declare global {
  interface Window {
    session: SessionBridge
  }
}

const api = window.session

const thread = document.getElementById('thread') as HTMLElement
const input = document.getElementById('input') as HTMLTextAreaElement
const addReferenceBtn = document.getElementById('addReference') as HTMLButtonElement
const sendBtn = document.getElementById('send') as HTMLButtonElement
const stopBtn = document.getElementById('stop') as HTMLButtonElement
const folderBtn = document.getElementById('folder') as HTMLButtonElement
const titlebar = document.getElementById('titlebar') as HTMLElement
const needsKey = document.getElementById('needsKey') as HTMLElement
const compatibilityNotice = document.getElementById('compatibilityNotice') as HTMLElement
const checkForUpdates = document.getElementById('checkForUpdates') as HTMLButtonElement
const artifactPane = document.getElementById('artifactPane') as HTMLElement
const artifactTitle = document.getElementById('artifactTitle') as HTMLElement
const artifactFrame = document.getElementById('artifactFrame') as HTMLIFrameElement
const artifactError = document.getElementById('artifactError') as HTMLElement
const sourcePreview = document.getElementById('sourcePreview') as HTMLElement
const artifactClose = document.getElementById('artifactClose') as HTMLButtonElement
const artifactResize = document.getElementById('artifactResize') as HTMLElement
const sourcesToggle = document.getElementById('sourcesToggle') as HTMLButtonElement
const sourcesList = document.getElementById('sourcesList') as HTMLElement
const sourceNotice = document.getElementById('sourceNotice') as HTMLElement
const outputsMenu = document.getElementById('outputsMenu') as HTMLElement
const outputsShell = document.getElementById('outputsShell') as HTMLElement
const outputsToggle = document.getElementById('outputsToggle') as HTMLButtonElement
const outputsList = document.getElementById('outputsList') as HTMLElement
const showRemovedOutputs = document.getElementById('showRemovedOutputs') as HTMLButtonElement
const evidencePane = document.getElementById('evidencePane') as HTMLElement
const evidenceContent = document.getElementById('evidenceContent') as HTMLElement
const resumeToggle = document.getElementById('resumeToggle') as HTMLButtonElement
const resumeToggleSummary = document.getElementById('resumeToggleSummary') as HTMLElement
const resumeContent = document.getElementById('resumeContent') as HTMLElement

// The empty state's animated wave (the CSS hides #empty once messages exist).
const waveCanvas = document.getElementById('loreWave') as HTMLCanvasElement | null
if (waveCanvas) initLoreWave(waveCanvas)

let workState: SessionWorkState = 'idle'
let bubble: HTMLElement | null = null // the assistant text node currently being streamed into
let turnBubbles: HTMLElement[] = [] // provider prose nodes eligible for terminal replacement
let pending: HTMLElement | null = null // the "Working…" indicator
interface ActivityGroup {
  root: HTMLElement
  summary: HTMLButtonElement
  history: HTMLElement
  exceptions: HTMLElement
  successful: Set<string>
  order: string[]
}
interface ActivityEntry {
  wrap: HTMLElement
  chip: HTMLElement
  detail: HTMLElement
  group: ActivityGroup
}
const chips = new Map<string, ActivityEntry>()
const evidenceByTool = new Map<string, string>()
let approvals = new Map<string, ApprovalPayload>()
let grantSubmissionEffectId: string | null = null
let approvalDecisionInFlight = false
let activityGroup: ActivityGroup | null = null
let reviews = new Map<string, TurnReviewPayload>()
let evidenceState: EvidenceViewState = { status: 'idle', detail: null, generation: 0 }
let resumeExpanded = true
let resumeState: ProjectResumeState = { status: 'unavailable', expanded: true, writable: false }

function resumeButton(label: string, action: () => void, disabled = false): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.disabled = disabled
  button.addEventListener('click', action)
  return button
}

function resumeField(label: string, value: string): HTMLElement {
  const field = document.createElement('div')
  field.className = 'resume-field'
  const heading = document.createElement('strong')
  heading.textContent = label
  const text = document.createElement('span')
  text.textContent = value
  field.append(heading, text)
  return field
}

function seedComposer(text: string): void {
  input.value = text
  input.focus()
  input.setSelectionRange(text.length, text.length)
  syncSend()
}

function scrollToReview(turnRef: string): void {
  const target = resolveBlockerDestination(thread, 'review', turnRef)
  if (target) target.scrollIntoView({ block: 'center' })
  else thread.focus()
}

function openBlocker(target: 'review' | 'approval' | 'reconcile', turnRef: string): void {
  const destination = resolveBlockerDestination(thread, target, turnRef)
  if (destination) destination.scrollIntoView({ block: 'center' })
  else thread.focus()
}

function editActionButton(label: string, action: () => Promise<ProjectEditResult>, parent: HTMLElement, disabled: boolean): HTMLButtonElement {
  const feedback = document.createElement('span')
  feedback.setAttribute('role', 'status')
  const button = resumeButton(label, () => {
    button.disabled = true
    feedback.textContent = 'Saving…'
    void action().then((result) => { feedback.textContent = result.ok ? 'Saved.' : result.message }).catch(() => { feedback.textContent = 'Save failed.' }).finally(() => { button.disabled = disabled })
  }, disabled)
  parent.append(feedback)
  return button
}

function editControl(initial: string, saveLabel: string, save: (text: string) => Promise<ProjectEditResult>): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'resume-edit'
  const editor = document.createElement('input')
  editor.value = initial
  editor.setAttribute('aria-label', saveLabel)
  const feedback = document.createElement('span')
  feedback.setAttribute('role', 'status')
  const saveButton = resumeButton('Save', () => {
    saveButton.disabled = true
    void save(editor.value.trim()).then((result) => {
      feedback.textContent = result.ok ? 'Saved.' : result.message ?? 'Save failed.'
    }).finally(() => { saveButton.disabled = false })
  })
  wrap.append(editor, saveButton, feedback)
  return wrap
}

function resumePopover(label: string, items: readonly HTMLElement[]): HTMLElement {
  const details = document.createElement('details')
  details.className = 'resume-popover'
  const summary = document.createElement('summary')
  summary.textContent = label
  const list = document.createElement('div')
  list.className = 'resume-popover-list'
  list.append(...items)
  details.append(summary, list)
  return details
}

function sourceControls(data: ProjectResumePayload, availability: Record<string, boolean>): HTMLElement[] {
  return data.sources.items.map((source) => {
    const meta = document.createElement('div')
    meta.className = 'resume-popover-item'
    const action = resumeButton(source.title, () => {
      if (source.kind === 'lore_thread' && source.loreThreadId) api.openLoreSource(source.loreThreadId, null)
      else void api.previewResumeSource(source.id)
    }, source.kind === 'lore_thread' ? !source.loreThreadId : !availability[source.id])
    const detail = document.createElement('small')
    detail.textContent = source.kind === 'lore_thread' ? 'Lore thread' : `${source.kind} · ${source.relativePath}${action.disabled ? ' · unavailable' : ''}`
    meta.append(action, detail)
    return meta
  })
}

function renderResume(state: ProjectResumeState): void {
  resumeState = state
  const view = projectResumePresentation(state)
  resumeContent.replaceChildren()
  resumeContent.hidden = !resumeExpanded
  resumeToggle.setAttribute('aria-expanded', String(resumeExpanded))
  resumeToggleSummary.textContent = view.status === 'available' ? `— ${view.objective.text}` : ''
  if (!resumeExpanded) return
  if (view.status === 'unavailable') {
    resumeContent.append(resumeField('Status', view.message), resumeButton('Retry', () => { void api.refreshResume() }))
    return
  }
  if (state.status !== 'available') return
  const data = state.data
  if (view.cacheLabel) resumeContent.append(resumeField('Status', view.cacheLabel))
  const objective = resumeField('Objective', view.objective.text)
  objective.append(document.createTextNode(` · ${view.objective.provenance}`))
  if (view.objective.canEdit) objective.append(resumeButton('Edit', () => objective.append(editControl(view.objective.text, 'Edit objective', (text) => api.updateObjective(view.objective.revision, text, false)))))
  if (view.objective.suggestion) {
    const suggestedText = view.objective.suggestion.text
    const objectiveRevision = view.objective.revision
    const suggestion = resumeField('Suggested objective', suggestedText)
    suggestion.append(editActionButton('Accept', () => api.updateObjective(objectiveRevision, suggestedText, true), suggestion, !view.writable))
    resumeContent.append(objective, suggestion)
  } else resumeContent.append(objective)

  const next = resumeField('Next', view.nextAction.label)
  if (view.nextAction.kind === 'recommendation') {
    const recommendation = view.nextAction
    next.append(document.createTextNode(` · ${recommendation.provenance}`), resumeButton('Use', () => seedComposer(recommendation.seed)))
    if (recommendation.canEdit) next.append(resumeButton('Edit', () => next.append(editControl(recommendation.label, 'Edit next step', (text) => api.updateNextStep(recommendation.revision, text || null)))))
  } else if (view.nextAction.kind === 'host_blocker') {
    const blockerTurnRef = view.nextAction.turnRef
    const blockerTarget = data.nextAction.kind === 'host_blocker' ? data.nextAction.target : 'review'
    next.append(resumeButton('Open', () => openBlocker(blockerTarget, blockerTurnRef)))
  } else if (view.nextAction.canEdit) {
    const revision = data.nextStepRevision
    next.append(resumeButton('Add', () => next.append(editControl('', 'Add next step', (text) => api.updateNextStep(revision, text || null)))))
  }
  resumeContent.append(next)

  const links = document.createElement('div')
  links.className = 'resume-links'
  links.append(
    data.sources.items.length ? resumePopover(view.sourcesLabel, sourceControls(data, state.sourceAvailability)) : resumeField('Sources', 'No sources yet'),
    resumeButton(view.outputsLabel, () => { outputsList.hidden = false; outputsToggle.setAttribute('aria-expanded', 'true'); outputsToggle.focus() }, data.outputs.totalCount === 0),
    data.workProgram ? resumeButton(view.workProgramLabel, () => { openDesignatedWorkProgram(data, (outputPath) => { void api.selectOutput(outputPath) }) }) : resumeButton(view.workProgramLabel, () => {}, true),
    data.decisions.items.length ? resumePopover(view.decisionsLabel, data.decisions.items.map((decision) => {
      const item = document.createElement('div'); item.className = 'resume-popover-item'
      item.append(resumeButton(decision.summary, () => api.openLoreSource(data.project.primaryThreadId, decision.sourceBlockId)), document.createTextNode(` ${decision.kind}`)); return item
    })) : resumeField('Decisions', 'No decisions yet'),
  )
  resumeContent.append(links, resumeField('Current work', view.currentWork.label))
  const completed = resumeField('Latest completed work', view.completedWork.label)
  if (view.completedWork.kind === 'terminal') {
    const turnRef = view.completedWork.turnRef
    completed.append(resumeButton('Open review', () => scrollToReview(turnRef)))
  }
  resumeContent.append(completed)
}

resumeToggle.addEventListener('click', () => { resumeExpanded = !resumeExpanded; renderResume(resumeState) })
api.onResume(renderResume)
let canAddReferenceDocument = false
let canPreviewReferenceDocuments = false

// ---- rendering -------------------------------------------------------------

function row(child: HTMLElement): HTMLElement {
  const r = document.createElement('div')
  r.className = 'row'
  r.append(child)
  thread.append(r)
  document.body.classList.add('has-messages')
  return r
}

function atBottom(): boolean {
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80
}

function scroll(force = false): void {
  if (force || atBottom()) thread.scrollTop = thread.scrollHeight
}

function addMessage(role: string, text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = `msg ${role}`
  el.textContent = text
  row(el)
  scroll(role === 'user')
  return el
}

function sourceExcerpt(source: CitationSource): string | null {
  return source.decisionSummary || source.summary
}

function renderSourceInspector(inspector: HTMLElement, sources: CitationSource[], sourceIndex: number): void {
  const source = sources[sourceIndex]
  if (!source) return
  inspector.replaceChildren()
  inspector.hidden = false

  const header = document.createElement('div')
  header.className = 'source-header'
  const number = document.createElement('span')
  number.className = 'source-number'
  number.textContent = `Source ${sourceIndex + 1}`
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'source-close'
  close.setAttribute('aria-label', 'Close source')
  close.textContent = '×'
  close.addEventListener('click', () => { inspector.hidden = true })
  header.append(number, close)

  const title = document.createElement('h3')
  title.textContent = source.title
  const metadata = document.createElement('p')
  metadata.className = 'source-metadata'
  const date = new Date(source.startedAt)
  const displayedDate = Number.isNaN(date.valueOf())
    ? source.startedAt
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  metadata.textContent = `${displayedDate} · matched by ${source.matchedBy}`

  inspector.append(header, title, metadata)
  const excerpt = sourceExcerpt(source)
  if (excerpt) {
    const quote = document.createElement('blockquote')
    quote.textContent = excerpt
    inspector.append(quote)
  }
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'source-open'
  open.textContent = source.blockId ? 'Open thread at this point ↗' : 'Open thread ↗'
  open.addEventListener('click', () => api.openLoreSource(source.threadId, source.blockId))
  inspector.append(open)
}

function renderAssistantContent(el: HTMLElement, text: string, sources: CitationSource[] = []): void {
  el.dataset.rawText = text
  // dockMarkdown escapes all input before interpreting its constrained element
  // set; assigning that output is what turns the safe markup into DOM.
  el.innerHTML = renderMarkdown(text, { citationCount: sources.length, links: 'inert' })
  if (sources.length === 0) return

  const sourceBar = document.createElement('div')
  sourceBar.className = 'source-bar'
  const showSources = document.createElement('button')
  showSources.type = 'button'
  showSources.className = 'show-sources'
  showSources.textContent = `Sources (${sources.length})`
  const inspector = document.createElement('aside')
  inspector.className = 'source-inspector'
  inspector.hidden = true
  showSources.addEventListener('click', () => {
    if (inspector.hidden) renderSourceInspector(inspector, sources, 0)
    else inspector.hidden = true
  })
  sourceBar.append(showSources)
  el.append(sourceBar, inspector)

  el.querySelectorAll<HTMLButtonElement>('.citation').forEach((citation) => {
    citation.addEventListener('click', () => {
      const sourceIndex = Number(citation.dataset.sourceIndex)
      if (Number.isInteger(sourceIndex)) renderSourceInspector(inspector, sources, sourceIndex)
    })
  })
}

function addAssistantMessage(text: string, sources: CitationSource[] = []): HTMLElement {
  const el = document.createElement('div')
  el.className = 'msg assistant markdown'
  renderAssistantContent(el, text, sources)
  row(el)
  scroll()
  return el
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * What a settled turn adds: what is known about the task, in two layers. The
 * checkmark is drawn only when the presentation says it was earned, and the
 * reference is text to quote — deliberately not a control, because
 * operator-guided reconciliation is not something this surface can do yet.
 *
 * The detail is the second layer and stays there: its own full-width line
 * below the headline, quieter and smaller, never folded into the headline
 * text. "Finished" must go on reading as a neutral finish — the detail is
 * there for someone who looks, not a hedge attached to the claim itself.
 */
function addOutcome(presentation: TurnOutcomePresentation): HTMLElement {
  // No `role="status"`: a live region is only announced reliably when it is in
  // the DOM before its content changes, and this node is created populated. It
  // would promise an announcement that assistive tech inconsistently delivers.
  // The line reads as part of the transcript, like every other entry here.
  const el = renderOutcome(document, presentation)

  row(el)
  if (presentation.promptBlockId) renderReview(presentation.promptBlockId)
  scroll()
  return el
}

function renderReview(promptBlockId: string): void {
  const payload = reviews.get(promptBlockId)
  try {
    renderReviewForOutcome(document, thread, promptBlockId, payload?.review ?? null, payload?.promptExcerpt ?? null)
  } catch {
    // A forward-skewed review must not take the durable Outcome down with it.
  }
}

function renderReviews(items: TurnReviewPayload[]): void {
  reviews = reconcileReviews(reviews, items)
  for (const card of thread.querySelectorAll('.review-card')) card.remove()
  for (const promptBlockId of reviews.keys()) renderReview(promptBlockId)
  scroll()
}

function showPending(label = 'Working…'): void {
  if (pending) {
    const status = pending.querySelector<HTMLElement>('.pending-label')
    if (status) status.textContent = label
    return
  }
  pending = document.createElement('div')
  pending.id = 'pending'
  pending.className = 'activity-row'
  const spinner = document.createElement('span')
  spinner.className = 'spinner'
  const status = document.createElement('span')
  status.className = 'pending-label'
  status.textContent = label
  pending.append(spinner, status)
  row(pending)
  scroll()
}

function clearPending(): void {
  if (pending && pending.parentElement) pending.parentElement.remove()
  pending = null
}

function createActivityGroup(): ActivityGroup {
  const root = document.createElement('div')
  root.className = 'activity-group'
  const summary = document.createElement('button')
  summary.type = 'button'
  summary.className = 'activity-summary activity-row'
  summary.setAttribute('aria-expanded', 'false')
  summary.hidden = true
  const icon = document.createElement('span')
  icon.className = 'activity-icon'
  const label = document.createElement('span')
  label.className = 'activity-label'
  summary.append(icon, label)
  const history = document.createElement('div')
  history.className = 'activity-history'
  history.hidden = true
  const exceptions = document.createElement('div')
  exceptions.className = 'activity-exceptions'
  root.append(summary, history, exceptions)
  const group = { root, summary, history, exceptions, successful: new Set<string>(), order: [] }
  summary.addEventListener('click', () => {
    history.hidden = !history.hidden
    summary.setAttribute('aria-expanded', String(!history.hidden))
    scroll()
  })
  row(root)
  return group
}

function currentActivityGroup(): ActivityGroup {
  activityGroup ??= createActivityGroup()
  return activityGroup
}

function updateActivityGroup(group: ActivityGroup): void {
  const count = group.successful.size
  group.summary.hidden = count === 0
  const label = group.summary.querySelector<HTMLElement>('.activity-label')
  if (label) label.textContent = `${count} ${count === 1 ? 'step' : 'steps'} completed`
}

function promoteActivityException(id: string): void {
  const entry = chips.get(id)
  if (!entry) return
  entry.group.successful.delete(id)
  entry.group.exceptions.append(entry.wrap)
  updateActivityGroup(entry.group)
}

function addChip({ id, label, input }: ToolStartPayload): void {
  const group = currentActivityGroup()
  group.order.push(id)
  const wrap = document.createElement('div')
  wrap.className = 'activity'
  wrap.dataset.open = 'false'

  const chip = document.createElement('button')
  chip.className = 'chip activity-row'
  chip.dataset.state = 'running'
  const spinner = document.createElement('span')
  spinner.className = 'spinner'
  chip.append(spinner, document.createTextNode(label))

  const detail = document.createElement('div')
  detail.className = 'chip-detail'
  detail.textContent = input == null ? '' : JSON.stringify(input, null, 2)

  chip.addEventListener('click', () => {
    wrap.dataset.open = wrap.dataset.open === 'true' ? 'false' : 'true'
    scroll()
  })

  wrap.append(chip, detail)
  group.exceptions.append(wrap)
  chips.set(id, { wrap, chip, detail, group })
  renderEvidenceAction(id)
  renderApproval(id)
  scroll()
  // The next assistant text after a tool call belongs in a fresh bubble.
  bubble = null
}

function renderEvidenceAction(toolCallId: string): void {
  const entry = chips.get(toolCallId)
  const bundleId = evidenceByTool.get(toolCallId)
  entry?.wrap.querySelector('.view-evidence')?.remove()
  if (!entry || !bundleId) return
  const button = document.createElement('button')
  button.className = 'view-evidence'
  button.textContent = 'View Evidence'
  button.addEventListener('click', () => void openEvidence(bundleId))
  entry.detail.append(button)
}

function field(label: string, value: string): HTMLElement {
  const row = document.createElement('p')
  const strong = document.createElement('strong')
  strong.textContent = `${label}: `
  row.append(strong, document.createTextNode(value))
  return row
}

function renderEvidence(detail: EvidenceDetail, shareOrganizationId: string | null): void {
  evidenceContent.replaceChildren()
  evidencePane.hidden = false
  for (const line of evidencePresentation(detail)) evidenceContent.append(field(line.split(' ')[0], line.slice(line.indexOf(' ') + 1)))
  if (evidenceShareTarget(detail, shareOrganizationId)) {
    const share = document.createElement('button')
    share.textContent = 'Share with organization'
    share.addEventListener('click', () => {
      share.disabled = true
      const generation = evidenceState.generation
      void api.shareEvidence(detail.bundleId)
        .then((result) => showEvidenceResult(result, generation))
        .catch(() => showEvidenceResult(evidenceFailure(), generation))
    })
    evidenceContent.append(share)
  }
  if (detail.copyUrl) {
    const copy = document.createElement('button')
    copy.textContent = 'Copy link'
    copy.addEventListener('click', () => void copyEvidenceUrl(detail, (value) => navigator.clipboard.writeText(value)).then(() => { copy.textContent = 'Link copied' }))
    evidenceContent.append(copy)
  }
}

function showEvidenceResult(result: Awaited<ReturnType<SessionBridge['fetchEvidence']>>, generation: number): void {
  if (generation !== evidenceState.generation) return
  evidenceContent.replaceChildren()
  evidencePane.hidden = false
  if (result.status === 'success') {
    // No schema check here: `dockSessionBackend.fetchEvidence` already runs the
    // payload through `evidenceDetailSchema.parse` before it crosses IPC, and a
    // parse failure there becomes `status: 'failure'`. Re-validating in the
    // renderer would mean a second validator to keep in step with the contract,
    // and the synced surface cannot reach Zod in the first place.
    evidenceState = settleEvidenceFetch(evidenceState, generation, 'success', result.evidence)
    renderEvidence(result.evidence, result.shareOrganizationId)
  }
  else {
    evidenceState = settleEvidenceFetch(evidenceState, generation, result.status)
    const message = document.createElement('p')
    message.textContent = result.message
    evidenceContent.append(message)
  }
}

async function openEvidence(bundleId: string): Promise<void> {
  artifactPane.hidden = true
  evidenceState = beginEvidenceFetch(evidenceState.generation)
  const generation = evidenceState.generation
  evidenceContent.replaceChildren(field('Status', 'Loading…'))
  evidencePane.hidden = false
  try {
    showEvidenceResult(await api.fetchEvidence(bundleId), generation)
  } catch {
    showEvidenceResult(evidenceFailure(), generation)
  }
}

function resolveChip({ id, ok, output, label }: ToolResultPayload): void {
  const entry = chips.get(id)
  if (!entry) return
  entry.chip.dataset.state = ok ? 'done' : 'failed'
  // A host tool can supply a finished-state label; swap the chip's text node
  // (last child, after the status dot) for it. Other tools keep their running
  // label untouched.
  if (label && entry.chip.lastChild) entry.chip.lastChild.nodeValue = label
  entry.detail.textContent = output || '(no output)'
  renderEvidenceAction(id)
  if (!ok) {
    entry.wrap.dataset.open = 'true'
    promoteActivityException(id)
  } else if (approvals.has(id) || evidenceByTool.has(id)) {
    promoteActivityException(id)
  } else {
    entry.group.successful.add(id)
    const position = entry.group.order.indexOf(id)
    const next = entry.group.order.slice(position + 1)
      .find(toolId => entry.group.successful.has(toolId))
    entry.group.history.insertBefore(entry.wrap, next ? chips.get(next)?.wrap ?? null : null)
    updateActivityGroup(entry.group)
  }
  renderApproval(id)
  scroll()
}

function renderApproval(toolCallId: string, message?: string): void {
  const entry = chips.get(toolCallId)
  if (!entry) return
  entry.wrap.querySelector('.approval-card')?.remove()
  const item = approvals.get(toolCallId)
  if (!item) return
  promoteActivityException(toolCallId)
  const controlState = approvalControlState(item, workState, grantSubmissionEffectId)

  entry.chip.dataset.state = item.state === 'answerable' || item.state === 'unanswerable'
    ? 'awaiting'
    : item.state === 'granted' ? 'running' : 'declined'
  const card = document.createElement('div')
  card.className = 'approval-card'
  card.dataset.state = item.state
  card.dataset.promptBlockId = item.turnId
  const title = document.createElement('strong')
  title.textContent = item.state === 'unanswerable' ? 'Approval unavailable' :
    item.state === 'declined' ? 'Change declined' : controlState.message ?? 'Approve this change?'
  const summary = document.createElement('p')
  summary.textContent = `${item.summary ?? 'Review this action'} · ${item.scope}`
  card.append(title, summary)

  if (item.state === 'unanswerable') {
    const explanation = document.createElement('p')
    explanation.textContent = 'This change cannot be approved because its prior state could not be verified.'
    card.append(explanation)
  } else if (item.state === 'answerable' || item.state === 'granted') {
    const controls = document.createElement('div')
    controls.className = 'approval-controls'
    const approve = document.createElement('button')
    approve.textContent = 'Run once'
    const deny = document.createElement('button')
    deny.textContent = "Don't run"
    const standing = approvalActions(item).includes('grant_prefix') ? document.createElement('button') : null
    if (standing) standing.textContent = 'Always allow this command prefix in this Slot'
    controls.append(approve, ...(standing ? [standing] : []), deny)
    if (controlState.disabled || approvalDecisionInFlight) {
      approve.disabled = true
      deny.disabled = true
      if (standing) standing.disabled = true
      card.append(controls)
      entry.wrap.append(card)
      return
    }
    const decide = (decision: 'grant_once' | 'grant_prefix' | 'deny'): void => {
      approve.disabled = true
      deny.disabled = true
      if (standing) standing.disabled = true
      approvalDecisionInFlight = true
      if (decision !== 'deny') {
        grantSubmissionEffectId = item.effectId
      }
      renderWorkState()
      void api.decideApproval(item.effectId, decision).then((result) => {
        if (result.ok) {
          approvals.set(toolCallId, { ...item, state: decision === 'deny' ? 'declined' : 'granted' })
          if (decision !== 'deny') {
            workState = reduceSessionState(workState, 'prompt')
          } else {
            approvalDecisionInFlight = false
          }
          renderWorkState()
          renderApprovals([...approvals.values()])
        } else {
          approvalDecisionInFlight = false
          if (decision !== 'deny') grantSubmissionEffectId = null
          renderWorkState()
          for (const id of approvals.keys()) renderApproval(id, id === toolCallId ? result.message || 'The decision could not be saved.' : undefined)
        }
      }).catch((error: unknown) => {
        approvalDecisionInFlight = false
        if (decision !== 'deny') grantSubmissionEffectId = null
        renderWorkState()
        for (const id of approvals.keys()) renderApproval(id, id === toolCallId ? error instanceof Error ? error.message : 'The decision could not be saved.' : undefined)
      })
    }
    approve.addEventListener('click', () => decide('grant_once'))
    standing?.addEventListener('click', () => decide('grant_prefix'))
    deny.addEventListener('click', () => decide('deny'))
    card.append(controls)
  }
  if (message) {
    const error = document.createElement('p')
    error.className = 'approval-error'
    error.textContent = message
    card.append(error)
  }
  entry.wrap.append(card)
}

function renderApprovals(items: ApprovalPayload[]): void {
  approvals = reconcileApprovals(approvals, items)
  for (const toolCallId of chips.keys()) renderApproval(toolCallId)
  scroll()
}

function appendText(delta: string): void {
  if (!bubble) {
    bubble = addAssistantMessage('')
    turnBubbles.push(bubble)
  }
  renderAssistantContent(bubble, `${bubble.dataset.rawText ?? ''}${delta}`)
  scroll()
}

// ---- state -----------------------------------------------------------------

function renderWorkState(): void {
  const busy = workState !== 'idle'
  const composerLocked = busy || approvalDecisionInFlight
  input.disabled = composerLocked
  sendBtn.hidden = composerLocked
  stopBtn.hidden = !busy
  stopBtn.disabled = workState === 'stopping'
  stopBtn.setAttribute('aria-label', workState === 'stopping' ? 'Stopping response' : 'Stop response')
  if (!busy) {
    clearPending()
    bubble = null
    input.focus()
    syncSend()
  }
  for (const toolCallId of approvals.keys()) renderApproval(toolCallId)
}

function syncSend(): void {
  sendBtn.disabled = workState !== 'idle' || approvalDecisionInFlight || input.value.trim().length === 0
}

function submit(): void {
  const text = input.value.trim()
  if (!text || workState !== 'idle' || approvalDecisionInFlight) return
  addMessage('user', text)
  input.value = ''
  autosize()
  syncSend()
  workState = reduceSessionState(workState, 'prompt')
  renderWorkState()
  showPending()
  api.prompt(text)
}

function autosize(): void {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`
}

// ---- wiring ----------------------------------------------------------------

input.addEventListener('input', () => {
  autosize()
  syncSend()
})

input.addEventListener('paste', () => {
  requestAnimationFrame(autosize)
})

input.addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter makes a new line. That is what a chat app does.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit()
  }
})

sendBtn.addEventListener('click', submit)
addReferenceBtn.addEventListener('click', () => api.addReferenceDocument())
stopBtn.addEventListener('click', () => {
  const next = reduceSessionState(workState, 'stop')
  if (next === workState) return
  workState = next
  renderWorkState()
  api.stop()
})

document.getElementById('close')?.addEventListener('click', () => api.closeWindow())
document.getElementById('min')?.addEventListener('click', () => api.minimizeWindow())
document.getElementById('zoom')?.addEventListener('click', () => api.zoomWindow())
document.getElementById('openSettings')?.addEventListener('click', () => api.openSettings())
folderBtn.addEventListener('click', () => api.revealFolder())

thread.addEventListener('scroll', () => {
  titlebar.classList.toggle('scrolled', thread.scrollTop > 4)
})

window.addEventListener('focus', () => {
  document.body.classList.remove('blurred')
  if (workState === 'idle') input.focus()
})
window.addEventListener('blur', () => document.body.classList.add('blurred'))
if (!document.hasFocus()) document.body.classList.add('blurred')

api.onAssistantStart(() => {
  workState = reduceSessionState(workState, 'prompt')
  renderWorkState()
  bubble = null
  turnBubbles = []
  activityGroup = null
})
api.onProgress((phase) => {
  const labels = {
    connecting: 'Connecting…',
    thinking: 'Thinking…',
    responding: 'Responding…',
  } as const
  showPending(labels[phase])
})
api.onText(appendText)
api.onTool(addChip)
api.onToolResult(resolveChip)
api.onTerminal(({ text, sources }) => {
  clearPending()
  for (const providerBubble of turnBubbles) providerBubble.parentElement?.remove()
  bubble = addAssistantMessage(replaceAssistantText('', text), sources)
  turnBubbles = [bubble]
  scroll()
})
api.onEntry((entry) => {
  clearPending()
  if (entry.role === 'user') return // already rendered optimistically
  // An outcome entry is written to the transcript for replay but never pushed
  // here — its channel is `Done`, which is what keeps one primitive to one
  // channel. Ignored rather than rendered, so a future push cannot double it.
  if (entry.role === 'outcome') return
  if (entry.role === 'assistant') addAssistantMessage(entry.text, entry.sources)
  else addMessage(entry.role, entry.text)
})
api.onDone((done) => {
  clearPending()
  // A host that derives no outcome sends `{}` and nothing is added, which is
  // how this turn ended before outcomes existed.
  const settled = describeTurnOutcome(done?.outcome, done?.reference, done?.detail)
  if (settled) addOutcome(settled)
  workState = reduceSessionState(workState, 'done')
  grantSubmissionEffectId = null
  approvalDecisionInFlight = false
  renderWorkState()
})
/** Apply blocked-banner state: host-supplied copy wins over the HTML default. */
function applyKeyState(state: { hasKey: boolean; keyPrompt?: string; keyActionHidden?: boolean }): void {
  needsKey.hidden = state.hasKey
  const prompt = needsKey.querySelector('p')
  if (prompt && state.keyPrompt) prompt.textContent = state.keyPrompt
  const action = needsKey.querySelector('button')
  if (action) action.hidden = Boolean(state.keyActionHidden)
}

/** Compatibility is display-only and deliberately never touches composer state. */
function applyCompatibilityState(state: Parameters<typeof compatibilityNoticeView>[0]): void {
  const view = compatibilityNoticeView(state)
  compatibilityNotice.hidden = view.hidden
  if (view.hidden) return
  const message = compatibilityNotice.querySelector('p')
  if (message) message.textContent = view.message
  checkForUpdates.textContent = view.action
}

api.onKeyState(applyKeyState)
api.onCompatibility(applyCompatibilityState)
api.onApprovals(renderApprovals)
api.onReviews(renderReviews)
api.onEvidenceAnnotations((items) => {
  for (const item of items) {
    evidenceByTool.set(item.toolCallId, item.bundleId)
    promoteActivityException(item.toolCallId)
    renderEvidenceAction(item.toolCallId)
  }
})
document.getElementById('evidenceClose')?.addEventListener('click', () => { evidenceState = beginEvidenceFetch(evidenceState.generation); evidencePane.hidden = true; evidenceContent.replaceChildren() })

// ---- artifact pane ---------------------------------------------------------

const ARTIFACT_RESIZE_STEP = 16
let preferredArtifactPaneWidth = ARTIFACT_PANE_WIDTH
let artifactResizeDrag: { pointerId: number; startX: number; startWidth: number } | null = null
let outputsPayload: OutputsPayload = { outputs: [] }
let removedOutputsVisible = false
let sourcePreviewGeneration = 0
let inspectorMode: 'artifact' | 'source' | null = null
let activeArtifact: ArtifactPayload | null = null

function outputAction(label: string, ariaLabel: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.setAttribute('aria-label', ariaLabel)
  button.addEventListener('click', (event) => { event.stopPropagation(); action() })
  return button
}

function renderOutputs(payload: OutputsPayload): void {
  outputsPayload = payload
  const view = outputsPresentation(payload)
  const visibility = outputsChromeVisibility(view, removedOutputsVisible)
  outputsShell.hidden = visibility.shellHidden
  outputsMenu.hidden = visibility.menuHidden
  outputsToggle.hidden = visibility.toggleHidden
  showRemovedOutputs.hidden = !view.showRemovedRecovery
  outputsToggle.textContent = `Outputs ${view.count}`
  outputsList.replaceChildren()
  for (const row of view.rows) {
    if (row.demoted && !removedOutputsVisible) continue
    const item = document.createElement('div')
    item.className = 'output-row'
    if (row.shown) item.dataset.shown = 'true'
    if (!row.available) item.dataset.unavailable = 'true'
    const select = document.createElement('button')
    select.type = 'button'
    select.className = 'output-select'
    select.disabled = !row.available || row.demoted
    select.setAttribute('aria-label', `${row.shown ? 'Shown output' : 'Show output'} ${row.label}`)
    const label = document.createElement('strong')
    label.textContent = row.label
    const path = document.createElement('span')
    path.textContent = row.path
    select.append(label, path)
    if (row.meta) {
      const meta = document.createElement('small')
      meta.textContent = row.meta
      select.append(meta)
    }
    select.addEventListener('click', () => void api.selectOutput(row.path))
    const actions = document.createElement('div')
    actions.className = 'output-actions'
    let saveOutputCopy: () => Promise<void>
    const saveCopy = outputAction('Save a copy…', `Save a copy of ${row.label}`, () => {
      void saveOutputCopy()
    })
    saveOutputCopy = createSaveOutputCopyAction(saveCopy, () => api.saveOutputCopy(row.path))
    actions.append(
      saveCopy,
      outputAction('Revise', `Revise ${row.label}`, () => { input.value = revisePromptSeed(row); input.focus(); input.setSelectionRange(input.value.length, input.value.length); syncSend() }),
      outputAction(row.demoted ? 'Add to outputs' : 'Remove from outputs', `${row.demoted ? 'Add' : 'Remove'} ${row.label} ${row.demoted ? 'to' : 'from'} outputs`, () => { void api.demoteOutput(row.path, !row.demoted) }),
    )
    item.append(select, actions)
    outputsList.append(item)
  }
  if (view.hasDemoted) {
    outputsList.append(outputAction(removedOutputsVisible ? 'Hide removed' : 'Show removed', removedOutputsVisible ? 'Hide removed outputs' : 'Show removed outputs', () => { removedOutputsVisible = !removedOutputsVisible; renderOutputs(outputsPayload) }))
  }
}

showRemovedOutputs.addEventListener('click', () => {
  removedOutputsVisible = true
  outputsList.hidden = false
  renderOutputs(outputsPayload)
})

outputsToggle.addEventListener('click', () => {
  outputsList.hidden = !outputsList.hidden
  outputsToggle.setAttribute('aria-expanded', String(!outputsList.hidden))
})

function closeSourceInspector(returnFocus = false): void {
  sourcePreviewGeneration += 1
  if (inspectorMode === 'source') {
    artifactPane.hidden = true
    sourcePreview.replaceChildren()
    sourcePreview.hidden = true
    inspectorMode = null
  }
  api.closeInspector()
  if (returnFocus) sourcesToggle.focus()
}

async function openSource(relativePath: string): Promise<void> {
  const generation = ++sourcePreviewGeneration
  evidenceState = beginEvidenceFetch(evidenceState.generation)
  evidencePane.hidden = true
  inspectorMode = 'source'
  artifactPane.hidden = false
  artifactClose.setAttribute('aria-label', 'Close source preview')
  setArtifactPaneWidth(preferredArtifactPaneWidth, false)
  artifactFrame.hidden = true
  artifactFrame.removeAttribute('src')
  artifactShare.hidden = true
  artifactError.hidden = true
  sourcePreview.hidden = false
  sourcePreview.replaceChildren()
  artifactTitle.textContent = 'Loading source…'
  const loading = document.createElement('p')
  loading.textContent = 'Loading preview…'
  sourcePreview.append(loading)
  try {
    const presentation = sourceInspectorPresentation(await api.previewSource(relativePath))
    if (generation !== sourcePreviewGeneration) return
    sourcePreview.replaceChildren()
    if (presentation.status === 'error') {
      artifactTitle.textContent = 'Source unavailable'
      const message = document.createElement('p')
      message.textContent = presentation.message
      sourcePreview.append(message)
      return
    }
    artifactTitle.textContent = presentation.title
    if (presentation.format === 'markdown') {
      sourcePreview.innerHTML = renderMarkdown(presentation.text, { links: 'external' })
      sourcePreview.querySelectorAll<HTMLButtonElement>('.markdown-external-link').forEach((link) => {
        link.addEventListener('click', () => {
          const url = link.dataset.externalUrl
          if (url) api.openSourceLink(url)
        })
      })
    } else {
      const text = document.createElement('pre')
      text.textContent = presentation.text
      sourcePreview.append(text)
    }
  } catch {
    if (generation !== sourcePreviewGeneration) return
    artifactTitle.textContent = 'Source unavailable'
    sourcePreview.textContent = 'This document preview could not be loaded.'
  }
}

function renderSources(payload: SourcesPayload): void {
  const view = sourcesPresentation(payload)
  sourcesToggle.textContent = `Sources ${view.count}`
  sourcesToggle.setAttribute('aria-label', `Reference documents, ${view.count} ${view.count === 1 ? 'document' : 'documents'}`)
  sourcesList.replaceChildren()
  const heading = document.createElement('h2')
  heading.className = 'sources-heading'
  heading.textContent = 'Reference documents'
  sourcesList.append(heading)
  if (view.loadFailed) {
    const failure = document.createElement('div')
    failure.className = 'sources-state'
    failure.textContent = 'Couldn’t load sources'
    failure.append(outputAction('Retry', 'Retry loading sources', () => view.retryable ? api.retrySources() : api.refreshSources()))
    sourcesList.append(failure)
  } else if (view.count === 0) {
    const empty = document.createElement('p')
    empty.className = 'sources-state'
    empty.textContent = 'Added text documents become available to Lore.'
    sourcesList.append(empty)
  }
  for (const row of view.rows) {
    const item = document.createElement('div')
    item.className = 'source-document-row'
    if (!row.available) item.dataset.unavailable = 'true'
    const select = document.createElement('button')
    select.type = 'button'
    select.className = 'source-document-select'
    select.disabled = !canPreviewReferenceDocuments
    select.setAttribute('aria-label', `Open preview for ${row.label}`)
    const label = document.createElement('strong')
    label.textContent = row.label
    const status = document.createElement('small')
    status.textContent = row.status
    select.append(label, status)
    if (canPreviewReferenceDocuments) select.addEventListener('click', () => void openSource(row.relativePath))
    item.append(select)
    sourcesList.append(item)
  }
  if (view.retryable && !view.loadFailed) {
    sourcesList.append(outputAction('Retry failed', 'Retry failed source registrations', () => api.retrySources()))
  }
  if (canAddReferenceDocument) {
    sourcesList.append(outputAction('Add reference document…', 'Add reference document', () => api.addSource()))
  }
}

function closeSourcesMenu(restoreFocus = false): void {
  if (sourcesList.hidden) return
  const focusWasInside = sourcesList.contains(document.activeElement)
  sourcesList.hidden = true
  sourcesToggle.setAttribute('aria-expanded', 'false')
  if (restoreFocus || focusWasInside) sourcesToggle.focus()
}

sourcesToggle.addEventListener('click', () => {
  if (!sourcesList.hidden) closeSourcesMenu()
  else {
    sourcesList.hidden = false
    sourcesToggle.setAttribute('aria-expanded', 'true')
  }
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !sourcesList.hidden) {
    closeSourcesMenu(true)
    event.preventDefault()
  }
})
document.addEventListener('pointerdown', (event) => {
  if (!sourcesList.hidden && event.target instanceof Node && !sourcesList.contains(event.target) && event.target !== sourcesToggle) {
    closeSourcesMenu()
  }
})

let sourceNoticeTimer: ReturnType<typeof setTimeout> | null = null
function hideSourceNotice(): void {
  if (sourceNoticeTimer) clearTimeout(sourceNoticeTimer)
  sourceNoticeTimer = null
  sourceNotice.hidden = true
}
function renderSourceNotice(notice: SourceActionNotice): void {
  hideSourceNotice()
  closeSourcesMenu()
  sourceNotice.dataset.kind = notice.kind
  const message = sourceNotice.querySelector('span')
  if (message) message.textContent = notice.message
  sourceNotice.hidden = false
  if (notice.kind === 'success') sourceNoticeTimer = setTimeout(hideSourceNotice, 3000)
}
sourceNotice.querySelector('button')?.addEventListener('click', () => {
  hideSourceNotice()
  api.dismissSourceNotice()
})

function setArtifactPaneWidth(width: number, remember = true): void {
  const clamped = clampArtifactPaneWidth(width, document.body.clientWidth)
  if (remember) preferredArtifactPaneWidth = clamped
  artifactPane.style.flexBasis = `${clamped}px`
  artifactResize.setAttribute('aria-valuemin', String(ARTIFACT_PANE_MIN_WIDTH))
  artifactResize.setAttribute(
    'aria-valuemax',
    String(clampArtifactPaneWidth(Number.POSITIVE_INFINITY, document.body.clientWidth)),
  )
  artifactResize.setAttribute('aria-valuenow', String(Math.round(clamped)))
}

window.addEventListener('resize', () => {
  if (!artifactPane.hidden) setArtifactPaneWidth(preferredArtifactPaneWidth, false)
})

artifactResize.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || artifactResizeDrag) return
  artifactResizeDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: artifactPane.getBoundingClientRect().width,
  }
  artifactResize.setPointerCapture(event.pointerId)
  document.body.classList.add('resizing-artifact')
  event.preventDefault()
})

artifactResize.addEventListener('pointermove', (event) => {
  if (!artifactResizeDrag || event.pointerId !== artifactResizeDrag.pointerId) return
  setArtifactPaneWidth(
    artifactResizeDrag.startWidth + artifactResizeDrag.startX - event.clientX,
  )
})

function finishArtifactResize(pointerId?: number): void {
  if (!artifactResizeDrag || (pointerId !== undefined && pointerId !== artifactResizeDrag.pointerId)) return
  const activePointerId = artifactResizeDrag.pointerId
  artifactResizeDrag = null
  document.body.classList.remove('resizing-artifact')
  try {
    artifactResize.releasePointerCapture(activePointerId)
  } catch {
    // Capture may already be gone after cancellation or focus loss.
  }
}

artifactResize.addEventListener('pointerup', event => finishArtifactResize(event.pointerId))
artifactResize.addEventListener('pointercancel', event => finishArtifactResize(event.pointerId))
artifactResize.addEventListener('lostpointercapture', event => finishArtifactResize(event.pointerId))
window.addEventListener('blur', () => finishArtifactResize())

artifactResize.addEventListener('keydown', (event) => {
  const width = artifactPane.getBoundingClientRect().width
  let next: number | null = null
  if (event.key === 'ArrowLeft') next = width + ARTIFACT_RESIZE_STEP
  if (event.key === 'ArrowRight') next = width - ARTIFACT_RESIZE_STEP
  if (event.key === 'Home') next = ARTIFACT_PANE_MIN_WIDTH
  if (event.key === 'End') next = Number.POSITIVE_INFINITY
  if (next === null) return
  setArtifactPaneWidth(next)
  event.preventDefault()
})

function renderArtifact(artifact: ArtifactPayload | null): void {
  activeArtifact = artifact
  if (!artifact) {
    if (inspectorMode !== 'source') artifactPane.hidden = true
    artifactFrame.removeAttribute('src')
    return
  }
  evidenceState = beginEvidenceFetch(evidenceState.generation)
  evidencePane.hidden = true
  sourcePreviewGeneration += 1
  inspectorMode = 'artifact'
  artifactPane.hidden = false
  artifactClose.setAttribute('aria-label', 'Close artifact')
  setArtifactPaneWidth(preferredArtifactPaneWidth, false)
  artifactError.hidden = true
  sourcePreview.hidden = true
  sourcePreview.replaceChildren()
  artifactFrame.hidden = false
  artifactShare.hidden = false
  artifactTitle.textContent = artifact.title
  setShareLabel('Share')
  // The version query forces a reload when the agent edits the shown file.
  artifactFrame.src = `${artifact.url}?v=${artifact.version}`
}

window.addEventListener('message', (event) => {
  if (event.source !== artifactFrame.contentWindow || !activeArtifact) return
  const action = resolveWorkProgramAction(event.origin, event.data, activeArtifact, outputsPayload.outputs)
  if (!action) return
  input.value = implementWorkProgramItemPromptSeed({
    itemId: action.itemId,
    title: action.title,
    path: action.path,
  })
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
  syncSend()
})

artifactFrame.addEventListener('error', () => {
  artifactFrame.hidden = true
  artifactError.hidden = false
})

artifactClose.addEventListener('click', () => {
  if (inspectorMode === 'source') closeSourceInspector(true)
  else api.closeArtifact()
})

// Share: publish to Lore, URL lands on the clipboard. The label carries the
// outcome ("Link copied" / the failure), then settles back to "Share".
const artifactShare = document.getElementById('artifactShare') as HTMLButtonElement
let shareResetTimer: ReturnType<typeof setTimeout> | null = null

function setShareLabel(label: string, settleMs?: number): void {
  if (shareResetTimer) clearTimeout(shareResetTimer)
  shareResetTimer = null
  artifactShare.textContent = label
  if (settleMs) {
    shareResetTimer = setTimeout(() => {
      artifactShare.textContent = 'Share'
      artifactShare.title = ''
    }, settleMs)
  }
}

artifactShare.addEventListener('click', () => {
  artifactShare.disabled = true
  setShareLabel('Sharing…')
  void api
    .shareArtifact()
    .then((result) => {
      if (result.ok) {
        setShareLabel('Link copied', 2000)
      } else {
        artifactShare.title = result.message
        setShareLabel('Share failed', 3000)
      }
    })
    .finally(() => {
      artifactShare.disabled = false
    })
})

checkForUpdates.addEventListener('click', api.checkForUpdates)

api.onArtifact(renderArtifact)
api.onOutputs(renderOutputs)
api.onSources(renderSources)
api.onSourceNotice(renderSourceNotice)

// ---- boot ------------------------------------------------------------------

function prettyFolder(folder: string): string {
  return folder.replace(/^\/Users\/[^/]+/, '~')
}

async function init(): Promise<void> {
  const state = await api.init()
  canAddReferenceDocument = Boolean(state?.canAddReferenceDocument)
  canPreviewReferenceDocuments = Boolean(state?.canPreviewReferenceDocuments)
  addReferenceBtn.hidden = !canAddReferenceDocument
  const folder = (state && state.folder) || api.folder
  const pretty = prettyFolder(folder)
  folderBtn.textContent = pretty
  folderBtn.title = `${folder} — click to open in Finder`
  document.title = `Dock — ${pretty}`

  // Replay anything that happened before this window was opened or reloaded.
  for (const entry of (state && state.transcript) || []) {
    if (entry.role === 'assistant') {
      activityGroup = null
      for (const tool of entry.tools || []) {
        if (tool.evidenceBundleId) evidenceByTool.set(tool.id, tool.evidenceBundleId)
        addChip({ id: tool.id, label: tool.label, input: tool.input })
        if (tool.output !== null) {
          resolveChip({ id: tool.id, ok: Boolean(tool.ok), output: tool.output })
        }
      }
      if (entry.text) {
        bubble = null
        bubble = addAssistantMessage(entry.text, entry.sources)
      }
    } else if (entry.role === 'outcome') {
      // Re-derived, not replayed verbatim: the stored value is the outcome, so
      // today's copy applies to a turn an older build settled, and a value this
      // build cannot name still reads as a non-committal completion.
      const settled = describeTurnOutcome(entry.outcome, entry.reference, entry.detail)
      if (settled) addOutcome(settled)
    } else {
      addMessage(entry.role, entry.text)
    }
  }
  bubble = null
  turnBubbles = []
  activityGroup = null

  if (state) {
    renderResume(state.resume ?? { status: 'unavailable', expanded: true, writable: false })
    applyKeyState(state)
    applyCompatibilityState(state.compatibility)
    renderReviews(state.reviews)
    renderSources(state.sources ?? { loadState: 'loaded', documents: [] })
    if (state.sourceNotice) renderSourceNotice(state.sourceNotice)
  }
  workState = state?.busy ? 'working' : 'idle'
  renderWorkState()
  renderArtifact((state && state.artifact) || null)
  if (state && state.busy) showPending()
  scroll(true)
  syncSend()
}

void init()
