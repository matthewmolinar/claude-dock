import type { DockTurnReviewDetail } from '../../shared/dockHostTypes'
import type { TurnOutcomePresentation } from '../../shared/dock'

type Review = DockTurnReviewDetail
type Entry = Review['document']['entries'][number]

const labels: Record<string, string> = {
  complete: 'Complete review', partial: 'Partial review', unavailable: 'Unavailable',
  git: 'Git comparison', file: 'File comparison', ledger_only: 'Ledger only',
  verified_success: 'Verified success', unverified_completion: 'Unverified completion', partial_success: 'Partial success',
  blocked: 'Blocked', exhausted: 'Exhausted', cancelled: 'Cancelled', failed: 'Failed', unknown: 'Unknown',
  not_required: 'Reconciliation not required', pending: 'Reconciliation pending', attempted: 'Reconciliation attempted',
  installed: 'Reconciliation installed',
  workbench_effect: 'Workbench effect', shell_observed_unresolved: 'Shell observed · unresolved', unresolved: 'Unresolved',
  passed: 'Passed', unchecked: 'Unchecked',
  run: 'Run', requested_not_run: 'Requested, not run',
  not_dispatched: 'Not dispatched', in_flight: 'In flight', committed: 'Committed',
  failed_before_commit: 'Failed before commit', aborted: 'Aborted',
  success: 'Success', error: 'Error', command_unavailable: 'Command unavailable',
  path_unavailable: 'Path unavailable', not_compared: 'Not compared', non_committed: 'Not committed',
  baseline_file_too_large: 'Baseline file too large', baseline_budget_exhausted: 'Baseline budget exhausted',
  baseline_raced: 'Baseline changed during review', baseline_path_unavailable: 'Baseline path unavailable',
  path_limit: 'Path limit reached', patch_truncated: 'Patch truncated', git_finalize_unavailable: 'Git finalization unavailable',
  ignored_shell_changes_unobservable: 'Ignored shell changes are unobservable', repository_changed: 'Repository changed',
  executor_unavailable: 'Executor unavailable',
  structured_result_budget: 'Structured result budget reached',
  created: 'Created', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed',
  'fs.writeFile': 'Write file', 'fs.editFile': 'Edit file', 'shell.exec': 'Shell command',
}

function label(value: string): string {
  return labels[value] ?? value.replaceAll('_', ' ')
}

function text(document: Document, tag: string, value: string, className?: string): HTMLElement {
  const element = document.createElement(tag)
  if (className) element.className = className
  element.textContent = value
  return element
}

function metadata(document: Document, values: Array<string | null>): HTMLElement {
  const line = text(document, 'p', values.filter(Boolean).join(' · '), 'review-metadata')
  return line
}

function section(document: Document, name: string, title: string): HTMLElement {
  const element = document.createElement('section')
  element.dataset.section = name
  element.append(text(document, 'h3', title))
  return element
}

function taskTitle(promptExcerpt: string | null): string {
  const prompt = promptExcerpt ?? ''
  const prefix = prompt.match(/^\s*(?:please\s+ask\s+lore\s+to|ask\s+lore\s+to|ask\s+lore)(?=\s|$)/i)
  const title = prefix ? prompt.slice(prefix[0].length).trim() : prompt
  if (!title.trim()) return 'Completed task'
  return title.replace(/\S/u, (first) => first.toUpperCase())
}

function renderReviewItem(document: Document, heading: string, details: string[]): HTMLElement {
  const item = document.createElement('div')
  item.className = 'review-item'
  item.append(text(document, 'strong', heading))
  item.append(metadata(document, details))
  return item
}

interface NeedsReviewPresentation {
  key: string
  render(document: Document): HTMLElement
}

function needsReviewPresentations(review: Review): NeedsReviewPresentation[] {
  const presentations: NeedsReviewPresentation[] = []
  const represented = new Set<string>()
  const concernsByHostFact = new Map<string, Array<{ details: string[] }>>()
  const aggregateLimitations = new Set<string>()
  const add = (presentation: NeedsReviewPresentation): void => {
    if (represented.has(presentation.key)) return
    represented.add(presentation.key)
    presentations.push(presentation)
  }
  const identity = (source: string, ...fields: unknown[]): string => JSON.stringify([source, ...fields])
  const effectHostFacts = (effectIds: string[], path: string | null, reason: string): string[] => path === null
    ? []
    : effectIds.map((effectId) => identity('effect-host-fact', effectId, path, reason))
  const addConcern = (key: string, heading: string, details: string[], hostFacts: string[]): void => {
    const existing = new Set(hostFacts.flatMap((fact) => concernsByHostFact.get(fact) ?? []))
    if (existing.size > 0) {
      for (const concern of existing) {
        for (const detail of details) if (!concern.details.includes(detail)) concern.details.push(detail)
      }
      return
    }
    const concern = { details: [...new Set(details)] }
    add({ key, render: (document) => renderReviewItem(document, heading, concern.details) })
    for (const fact of hostFacts) {
      const concerns = concernsByHostFact.get(fact) ?? []
      if (!concerns.includes(concern)) concerns.push(concern)
      concernsByHostFact.set(fact, concerns)
    }
  }

  if (review.document.omittedCount > 0) {
    add({
      key: 'document:omitted-count',
      render: (document) => renderReviewItem(document, `${review.document.omittedCount} changes omitted`, []),
    })
  }
  for (const limitation of review.document.limitations) {
    aggregateLimitations.add(limitation)
    add({
      key: `document:limitation:${limitation}`,
      render: (document) => renderReviewItem(document, label(limitation), []),
    })
  }
  for (const omission of review.document.entries) {
    if (omission.kind !== 'omission') continue
    addConcern(
      identity('document-omission', omission.path, omission.reason, omission.effectIds),
      omission.path ?? 'Omitted change',
      [omission.change ? label(omission.change) : null, label(omission.reason)].filter((value): value is string => value !== null),
      effectHostFacts(omission.effectIds, omission.path ?? null, omission.reason),
    )
  }

  for (const need of review.needsReview) {
    const hostFacts = effectHostFacts([need.effectId], need.path, need.reason)
    const overlapsConcern = hostFacts.some((fact) => concernsByHostFact.has(fact))
    addConcern(
      identity('explicit-need', need.effectId, need.toolCallId, need.path, need.reason),
      need.path ?? label(need.primitive),
      [label(need.reason), ...(overlapsConcern ? [label(need.primitive)] : []), label(need.settlement), `Verification ${label(need.verification)}`],
      hostFacts,
    )
  }

  for (const file of review.files) {
    const details = [
      file.association !== 'workbench_effect' ? label(file.association) : null,
      file.limitation && !aggregateLimitations.has(file.limitation) ? label(file.limitation) : null,
    ].filter((value): value is string => value !== null)
    if (details.length === 0) continue
    addConcern(
      identity('file-fallback', file.path, file.association, file.limitation, file.effectIds),
      file.path,
      details,
      file.comparisonKind === 'omission' && file.limitation ? effectHostFacts(file.effectIds, file.path, file.limitation) : [],
    )
  }
  return presentations
}

function binaryMetadata(entry: Extract<Entry, { kind: 'binary' }>): string[] {
  const lengths = entry.beforeLength !== null || entry.afterLength !== null
    ? `${entry.beforeLength ?? 'unknown'} bytes → ${entry.afterLength ?? 'unknown'} bytes` : null
  const modes = entry.beforeMode !== null || entry.afterMode !== null
    ? `${entry.beforeMode ?? 'none'} → ${entry.afterMode ?? 'none'}` : null
  const digests = entry.beforeDigest !== null || entry.afterDigest !== null
    ? `Digests ${entry.beforeDigest ?? 'none'} → ${entry.afterDigest ?? 'none'}` : null
  return [lengths, modes, digests].filter((value): value is string => value !== null)
}

function renderFile(document: Document, review: Review, file: Review['files'][number]): HTMLElement {
  const entry = review.document.entries.find((candidate) => candidate.path === file.path)
  const item = document.createElement('div')
  item.className = 'review-item'
  item.append(text(document, 'strong', file.path))
  item.append(metadata(document, [file.association === 'workbench_effect' ? label(file.association) : null, file.settlement ? label(file.settlement) : null, `Verification ${label(file.verification)}`]))
  if (entry?.kind === 'patch') {
    const disclosure = document.createElement('details')
    disclosure.append(text(document, 'summary', `${label(entry.change)} patch`))
    disclosure.append(text(document, 'pre', entry.patch))
    item.append(disclosure)
  } else if (entry?.kind === 'binary') {
    item.append(metadata(document, ['Binary metadata only', ...binaryMetadata(entry)]))
  }
  return item
}

function renderCommand(document: Document, command: Review['commands'][number]): HTMLElement {
  const item = document.createElement('div')
  item.className = 'review-item'
  item.append(text(document, 'strong', command.command ?? 'Command unavailable', 'review-command'))
  item.append(metadata(document, [label(command.state), label(command.settlement), `Verification ${label(command.verification)}`, command.receiptPresent ? 'Receipt present' : 'Receipt absent', `Result ${label(command.reportedResult.state)}`, command.reportedResult.truncated ? 'Result truncated' : null]))
  if (command.reportedResult.text !== null) item.append(text(document, 'pre', command.reportedResult.text))
  return item
}

/** Render only host-classified review facts. Strings are always inserted as text. */
export function renderReviewCard(document: Document, review: DockTurnReviewDetail, promptExcerpt: string | null = null): HTMLElement {
  const card = document.createElement('article')
  card.className = 'review-card'
  card.dataset.reviewId = review.reviewId

  const summary = section(document, 'summary', taskTitle(promptExcerpt))
  summary.querySelector('h3')!.className = 'review-task-title'
  const status = {
    complete: 'Review complete',
    partial: 'Review incomplete',
    unavailable: 'Review unavailable',
  }[review.document.status]
  summary.append(text(document, 'p', status, 'review-status'))
  const details = document.createElement('details')
  details.append(text(document, 'summary', 'Review details'))
  details.append(metadata(document, [`Prompt ${review.document.promptBlockId}`]))
  details.append(metadata(document, [label(review.document.mode), label(review.outcome), review.reconciliation === 'exhausted' ? 'Reconciliation exhausted' : label(review.reconciliation)]))
  if (review.document.workItemRef) details.append(metadata(document, [`Work item ${review.document.workItemRef}`]))
  summary.append(details)
  card.append(summary)

  const needsReviewPresentationsList = needsReviewPresentations(review)
  if (needsReviewPresentationsList.length > 0) {
    const needsReview = section(document, 'needs-review', 'Needs review')
    for (const presentation of needsReviewPresentationsList) needsReview.append(presentation.render(document))
    card.append(needsReview)
  }

  if (review.files.length > 0) {
    const files = section(document, 'files', 'Files changed')
    for (const file of review.files) files.append(renderFile(document, review, file))
    card.append(files)
  }

  if (review.commands.length > 0) {
    const commands = section(document, 'commands', 'Commands')
    for (const command of review.commands) commands.append(renderCommand(document, command))
    card.append(commands)
  }

  return card
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Build the Outcome host from the canonical presentation, including its stable association. */
export function renderOutcome(document: Document, presentation: TurnOutcomePresentation): HTMLElement {
  const { headline, verified, promptBlockId, reference, detail } = presentation
  const element = document.createElement('div')
  element.className = 'outcome'
  if (promptBlockId) element.dataset.promptBlockId = promptBlockId
  if (verified) {
    const check = document.createElementNS(SVG_NS, 'svg')
    check.setAttribute('class', 'outcome-check')
    check.setAttribute('viewBox', '0 0 16 16')
    check.setAttribute('width', '16')
    check.setAttribute('height', '16')
    check.setAttribute('fill', 'none')
    check.setAttribute('aria-hidden', 'true')
    const stroke = document.createElementNS(SVG_NS, 'path')
    stroke.setAttribute('d', 'M3 8.5 6.25 12 13 4')
    stroke.setAttribute('stroke', 'currentColor')
    stroke.setAttribute('stroke-width', '1.75')
    stroke.setAttribute('stroke-linecap', 'round')
    stroke.setAttribute('stroke-linejoin', 'round')
    check.append(stroke)
    element.append(check)
  }
  element.append(text(document, 'span', headline, 'outcome-headline'))
  if (reference) element.append(text(document, 'span', reference, 'outcome-reference'))
  if (detail) element.append(text(document, 'p', detail, 'outcome-detail'))
  return element
}

/** Replace the single card belonging to a prompt-keyed Outcome. */
export function renderReviewForOutcome(
  document: Document,
  root: ParentNode,
  promptBlockId: string,
  review: DockTurnReviewDetail | null,
  promptExcerpt: string | null = null,
): void {
  const outcome = [...root.querySelectorAll<HTMLElement>('.outcome')]
    .find((element) => element.dataset.promptBlockId === promptBlockId)
  outcome?.querySelector('.review-card')?.remove()
  if (outcome && review) outcome.append(renderReviewCard(document, review, promptExcerpt))
}
