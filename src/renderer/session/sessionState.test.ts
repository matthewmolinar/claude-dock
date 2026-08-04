import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import type { ApprovalPayload, ArtifactPayload, OutputsPayload, ProjectResumePayload, ProjectResumeState, SessionCompatibilityState, SourcesPayload, TurnReviewPayload } from '../../shared/dock'
import { approvalActions, approvalControlState, beginEvidenceFetch, compatibilityNoticeView, copyEvidenceUrl, createSaveOutputCopyAction, evidenceFailure, evidencePresentation, evidenceShareTarget, implementWorkProgramItemPromptSeed, isWorkProgramMarkdownPath, outputsChromeVisibility, outputsPresentation, parseWorkProgramActionMessage, projectResumePresentation, reconcileApprovals, reconcileReviews, reduceSessionState, replaceAssistantText, resolveWorkProgramAction, revisePromptSeed, settleEvidenceFetch, sourceInspectorPresentation, sourcesPresentation } from './sessionState'

function projectResume(overrides: Partial<ProjectResumePayload> = {}): ProjectResumePayload {
  return {
    project: { id: 'project-1', primaryThreadId: 'th_primary', updatedAt: '2026-08-02T10:00:00.000Z' },
    nextStepRevision: 0,
    objective: { text: 'Ship the durable resume', source: 'user', sourceTurnRef: null, revision: 3, updatedAt: '2026-08-02T09:00:00.000Z', updatedByUserId: 'user-1', suggestion: null },
    repository: { label: 'lore' },
    sources: { items: [], totalCount: 0 },
    outputs: { items: [], totalCount: 0 },
    workProgram: null,
    decisions: { items: [], totalCount: 0 },
    currentWork: { kind: 'none' },
    latestCompletedWork: null,
    nextAction: { kind: 'none' },
    ...overrides,
  }
}

function resumeState(data = projectResume(), overrides: Partial<Extract<ProjectResumeState, { status: 'available' }>> = {}): ProjectResumeState {
  return { status: 'available', expanded: true, writable: true, freshness: 'fresh', cachedAt: '2026-08-02T10:00:00.000Z', data, sourceAvailability: {}, ...overrides }
}

test('resume presentation uses exact unavailable and empty labels', () => {
  assert.deepEqual(projectResumePresentation({ status: 'unavailable', expanded: true, writable: false }), {
    status: 'unavailable', message: 'Project state temporarily unavailable', writable: false,
  })
  const view = projectResumePresentation(resumeState())
  assert.equal(view.status, 'available')
  if (view.status !== 'available') return
  assert.equal(view.workProgramLabel, 'No work program yet')
  assert.equal(view.completedWork.label, 'No completed work yet')
  assert.equal(view.nextAction.label, 'No next step suggested')
  assert.equal(view.currentWork.label, 'No current work')
})

test('cached resume reports its timestamp and disables every write', () => {
  const view = projectResumePresentation(resumeState(projectResume(), { freshness: 'cached', writable: false, cachedAt: '2026-08-02T08:30:00.000Z' }))
  assert.equal(view.status, 'available')
  if (view.status !== 'available') return
  assert.equal(view.cacheLabel, 'Offline · Last updated Aug 2, 2026, 8:30 AM')
  assert.equal(view.writable, false)
  assert.equal(view.objective.canEdit, false)
  assert.equal(view.nextAction.canEdit, false)
})

test('objective suggestion stays pending and carries the confirmed revision', () => {
  const data = projectResume({ objective: { text: 'Confirmed goal', source: 'user', sourceTurnRef: null, revision: 7, updatedAt: '2026-08-02T09:00:00.000Z', updatedByUserId: 'user-1', suggestion: { text: 'Suggested redirect', sourceTurnRef: 'turn-2', suggestedAt: '2026-08-02T09:30:00.000Z' } } })
  const view = projectResumePresentation(resumeState(data))
  assert.equal(view.status, 'available')
  if (view.status !== 'available') return
  assert.deepEqual(view.objective, { text: 'Confirmed goal', revision: 7, provenance: 'Confirmed by you', canEdit: true, suggestion: { text: 'Suggested redirect', sourceTurnRef: 'turn-2' } })
})

test('Lore-authored objectives are autofilled and remain editable while fresh', () => {
  const data = projectResume({ objective: { text: 'Inferred goal', source: 'lore', sourceTurnRef: 'turn-1', revision: 1, updatedAt: '2026-08-02T09:00:00.000Z', updatedByUserId: null, suggestion: null } })
  const view = projectResumePresentation(resumeState(data))
  assert.equal(view.status, 'available')
  if (view.status !== 'available') return
  assert.equal(view.objective.provenance, 'Autofilled')
  assert.equal(view.objective.canEdit, true)
})

test('durable current work distinguishes unsettled and terminal references', () => {
  const unsettled = projectResumePresentation(resumeState(projectResume({ currentWork: { kind: 'unsettled', turnRef: 'turn-running', startedAt: '2026-08-02T09:00:00.000Z', reason: 'reconciliation_pending' } })))
  assert.equal(unsettled.status, 'available')
  if (unsettled.status === 'available') assert.deepEqual(unsettled.currentWork, { kind: 'unsettled', label: 'Reconciliation pending', turnRef: 'turn-running' })
  const terminal = projectResumePresentation(resumeState(projectResume({ currentWork: { kind: 'terminal', turnRef: 'turn-done', outcomeId: 'outcome-1', outcome: 'verified_success', detail: 'Done', verification: 'passed', completedAt: '2026-08-02T09:00:00.000Z', effectCount: 1, reviewId: 'review-1' } })))
  assert.equal(terminal.status, 'available')
  if (terminal.status === 'available') assert.deepEqual(terminal.currentWork, { kind: 'terminal', label: 'Verified success · Verification passed', turnRef: 'turn-done', reviewId: 'review-1' })
})

test('host blocker replaces recommendation while recommendations remain composer seeds', () => {
  const recommendation = { kind: 'recommendation' as const, text: 'Run focused tests', source: 'lore' as const, sourceTurnRef: 'turn-1', updatedByUserId: null, revision: 4, updatedAt: '2026-08-02T09:00:00.000Z' }
  const recommended = projectResumePresentation(resumeState(projectResume({ nextAction: recommendation })))
  assert.equal(recommended.status, 'available')
  if (recommended.status === 'available') assert.deepEqual(recommended.nextAction, { kind: 'recommendation', label: 'Run focused tests', provenance: 'Suggested by Lore', seed: 'Run focused tests', revision: 4, canEdit: true })
  const blocked = projectResumePresentation(resumeState(projectResume({ nextAction: { kind: 'host_blocker', target: 'review', turnRef: 'turn-2', label: 'Review failed verification' } })))
  assert.equal(blocked.status, 'available')
  if (blocked.status === 'available') assert.deepEqual(blocked.nextAction, { kind: 'host_blocker', label: 'Review failed verification', target: 'review', turnRef: 'turn-2', canEdit: false })
})

test('empty next action exposes its authoritative revision for Add', () => {
  const view = projectResumePresentation(resumeState(projectResume({ nextStepRevision: 6 })))
  assert.equal(view.status, 'available')
  if (view.status === 'available') assert.deepEqual(view.nextAction, { kind: 'none', label: 'No next step suggested', revision: 6, canEdit: true })
})
test('stop transitions a working session to stopping exactly once', () => {
  const stopping = reduceSessionState('working', 'stop')
  assert.equal(stopping, 'stopping')
  assert.equal(reduceSessionState(stopping, 'stop'), 'stopping')
})

test('completion returns working or stopping sessions to idle', () => {
  assert.equal(reduceSessionState('working', 'done'), 'idle')
  assert.equal(reduceSessionState('stopping', 'done'), 'idle')
})

test('a new prompt starts work only while idle', () => {
  assert.equal(reduceSessionState('idle', 'prompt'), 'working')
  assert.equal(reduceSessionState('stopping', 'prompt'), 'stopping')
})

test('terminal presentation replaces provider preamble without slicing', () => {
  const answer = 'answer'.repeat(4000)
  assert.equal(replaceAssistantText('provider preamble', answer), answer)
})

test('approval pushes are keyed by tool call and preserve a declined terminal state', () => {
  const answerable: ApprovalPayload = {
    effectId: 'effect-1', toolCallId: 'call-1', turnId: 'turn-1', scope: 'src/app.ts', tier: 'replace',
    contentLength: 42, state: 'answerable',
  }
  const declined = { ...answerable, state: 'declined' as const }
  const current = reconcileApprovals(new Map(), [declined])
  const repeated = reconcileApprovals(current, [answerable])

  assert.equal(repeated.get('call-1')?.state, 'declined')
  assert.equal(repeated.get('effect-1'), undefined)
})

test('approval pushes replace missing non-terminal items', () => {
  const item: ApprovalPayload = {
    effectId: 'effect-1', toolCallId: 'call-1', turnId: 'turn-1', scope: 'src/app.ts', tier: 'replace',
    contentLength: 42, state: 'answerable',
  }
  assert.deepEqual(reconcileApprovals(new Map([['call-1', item]]), []), new Map())
})

test('only an eligible shell approval offers standing authority', () => {
  const base: ApprovalPayload = { effectId: 'dfx_1', toolCallId: 'call_1', turnId: 'turn-1', scope: 'Slot', tier: 'non_allowlisted_shell', contentLength: null, state: 'answerable', summary: 'Run a shell command', eligiblePrefix: 'this command prefix' }
  assert.deepEqual(approvalActions(base), ['grant_once', 'grant_prefix', 'deny'])
  assert.deepEqual(approvalActions({ ...base, tier: 'whole_file_replacement', eligiblePrefix: null }), ['grant_once', 'deny'])
  assert.deepEqual(approvalActions({ ...base, eligiblePrefix: null }), ['grant_once', 'deny'])
})

test('approval controls are thread-wide read-only during grant submission and resumed work', () => {
  const first: ApprovalPayload = { effectId: 'effect-1', toolCallId: 'call-1', turnId: 'turn-1', scope: 'a', tier: 'write', contentLength: 1, state: 'answerable' }
  const second = { ...first, effectId: 'effect-2', toolCallId: 'call-2' }

  assert.deepEqual(approvalControlState(first, 'idle', 'effect-1'), { disabled: true, applying: true, message: 'Applying approved change…' })
  assert.deepEqual(approvalControlState(second, 'idle', 'effect-1'), { disabled: true, applying: false, message: 'Another approval is being applied.' })
  assert.deepEqual(approvalControlState(second, 'working', null), { disabled: true, applying: false, message: 'Approval controls are read-only while Lore is working.' })
  assert.deepEqual(approvalControlState(second, 'idle', null), { disabled: false, applying: false, message: null })
})

test('canonical granted approvals remain applying independent of command similarity', () => {
  const granted: ApprovalPayload = { effectId: 'effect-1', toolCallId: 'call-1', turnId: 'turn-1', scope: 'same command text', tier: 'write', contentLength: 1, state: 'granted' }
  const answerable = { ...granted, effectId: 'effect-2', toolCallId: 'call-2', state: 'answerable' as const }

  assert.deepEqual(approvalControlState(granted, 'idle', null), { disabled: true, applying: true, message: 'Applying approved change…' })
  assert.deepEqual(approvalControlState(answerable, 'idle', null), { disabled: false, applying: false, message: null })
})

test('a new or failed Evidence fetch cannot retain stale detail', () => {
  const first = beginEvidenceFetch(0)
  const second = beginEvidenceFetch(first.generation)
  assert.equal(settleEvidenceFetch(second, first.generation, 'success', effectDetail), second)
  assert.deepEqual(settleEvidenceFetch(second, second.generation, 'not_found'), { status: 'not_found', detail: null, generation: 2 })
  assert.deepEqual(settleEvidenceFetch(second, second.generation, 'unavailable'), { status: 'unavailable', detail: null, generation: 2 })
  assert.deepEqual(settleEvidenceFetch(second, second.generation, 'failure'), { status: 'failure', detail: null, generation: 2 })
  assert.deepEqual(evidenceFailure(), { status: 'failure', message: 'Evidence could not be loaded.' })
})

const effectDetail = {
  bundleId: 'evb_1', authorUserId: 'user_1', organizationId: null, visibility: 'private' as const,
  createdAt: '2026-07-31T12:00:00.000Z', promotedAt: null, copyUrl: 'https://lore.test/exact',
  kind: 'dock_effect' as const, effectId: 'dfx_1', toolCallId: 'call_1', action: 'fs.writeFile', scope: '/a',
  settlement: 'committed' as const, retryClass: 'byte_idempotent' as const,
  attempts: [{ ordinal: 1, status: 'committed' as const, receiptPresent: true, dispatchedAt: '2026-07-31T12:00:00.000Z', respondedAt: null }],
  verifications: [{ status: 'passed' as const, policy: 'digest', policyVersion: 1, expectedDigest: 'a', observedDigest: 'a', verifiedAt: '2026-07-31T12:00:00.000Z' }],
  authority: { source: 'approval' as const, authorizationId: 'auth_1', approvalId: 'apr_1', standingPolicyId: null, requirement: null },
}

test('Evidence presentation and sharing are derived only from safe server detail', async () => {
  assert.equal(evidenceShareTarget(effectDetail, 'org_current'), true)
  assert.equal(evidenceShareTarget({ ...effectDetail, visibility: 'organization' }, 'org_current'), false)
  assert.equal(evidenceShareTarget(effectDetail, null), false)
  assert.deepEqual(evidencePresentation({ ...effectDetail, authority: { ...effectDetail.authority, requirement: { tier: 'whole_file_replacement' as const, scope: '/a', policyVersion: 'v2' } } }), [
    'Action fs.writeFile', 'Scope /a', 'Settlement committed',
    'Attempt 1 committed; Receipt present', 'Verification passed digest',
    'Authority source approval', 'Authorization auth_1', 'Approval apr_1',
    'Requirement tier whole_file_replacement', 'Requirement scope /a', 'Requirement policyVersion v2',
    'Visibility private',
  ])
  let copied = ''
  await copyEvidenceUrl(effectDetail, async (value) => { copied = value })
  assert.equal(copied, 'https://lore.test/exact')
})

test('update-required compatibility has the persistent update notice view', () => {
  const states: SessionCompatibilityState[] = [
    { status: 'update_required', reason: 'version_metadata_missing' },
    { status: 'update_required', reason: 'version_no_overlap' },
  ]

  for (const state of states) {
    assert.deepEqual(compatibilityNoticeView(state), {
      hidden: false,
      message: 'Update Lore to restore file and command tools.',
      action: 'Check for Updates',
    })
  }
})

test('ready or unknown compatibility hides the update notice', () => {
  assert.deepEqual(compatibilityNoticeView({ status: 'ready' }), { hidden: true })
  assert.deepEqual(compatibilityNoticeView(undefined), { hidden: true })
})

test('review pushes replace the complete prompt-keyed state rather than append', () => {
  const first = { promptBlockId: 'prompt-1', promptExcerpt: null, review: { reviewId: 'first' } } as TurnReviewPayload
  const replacement = { promptBlockId: 'prompt-1', promptExcerpt: null, review: { reviewId: 'replacement' } } as TurnReviewPayload
  const second = { promptBlockId: 'prompt-2', promptExcerpt: null, review: { reviewId: 'second' } } as TurnReviewPayload

  const next = reconcileReviews(new Map([['prompt-1', first]]), [replacement, second])
  assert.equal(next.size, 2)
  assert.equal(next.get('prompt-1')?.review.reviewId, 'replacement')
  assert.equal(reconcileReviews(next, []).size, 0)
})

test('session renderer applies review events and reload hydration through one replacement path', () => {
  const source = readFileSync(new URL('./session.ts', import.meta.url), 'utf8')
  assert.match(source, /api\.onReviews\(renderReviews\)/)
  assert.match(source, /renderReviews\(state\.reviews\)/)
  assert.match(source, /presentation\.promptBlockId/)
})

function output(overrides: Partial<OutputsPayload['outputs'][number]> = {}): OutputsPayload['outputs'][number] {
  return { path: 'reports/audit.md', title: 'Q3 Audit', versionOrdinal: 1, demoted: false, mirrored: true, available: true, shown: false, ...overrides }
}

test('outputs presentation handles empty and single promoted output states', () => {
  assert.deepEqual(outputsPresentation({ outputs: [] }), { rows: [], count: 0, hasDemoted: false, showRemovedRecovery: false })
  assert.deepEqual(outputsPresentation({ outputs: [output({ shown: true })] }), {
    rows: [{ path: 'reports/audit.md', label: 'Q3 Audit', meta: '', shown: true, demoted: false, available: true, mirrored: true }],
    count: 1,
    hasDemoted: false,
    showRemovedRecovery: false,
  })
})

test('outputs presentation preserves payload order, including equal-version outputs', () => {
  const payload = { outputs: [output({ path: 'new.md', title: 'New', versionOrdinal: 2 }), output({ path: 'equal.md', title: 'Equal', versionOrdinal: 2 }), output({ path: 'old.md', title: 'Old' })] }
  assert.deepEqual(outputsPresentation(payload).rows.map((row) => row.path), ['new.md', 'equal.md', 'old.md'])
})

test('outputs presentation derives safe labels, metadata, and promoted count', () => {
  const view = outputsPresentation({ outputs: [
    output({ path: 'nested/untitled.txt', title: '', versionOrdinal: 3, mirrored: false }),
    output({ path: 'gone.md', title: 'Gone', available: false }),
    output({ path: 'removed.md', title: 'Removed', demoted: true }),
  ] })
  assert.equal(view.count, 2)
  assert.equal(view.hasDemoted, true)
  assert.deepEqual(view.rows.map(({ label, meta, demoted }) => ({ label, meta, demoted })), [
    { label: 'untitled.txt', meta: 'revised ×3 · not yet in Lore', demoted: false },
    { label: 'Gone', meta: 'file unavailable', demoted: false },
    { label: 'Removed', meta: '', demoted: true },
  ])
})

test('all-demoted outputs expose recovery while keeping the promoted count control hidden', () => {
  const view = outputsPresentation({ outputs: [output({ demoted: true })] })
  assert.equal(view.count, 0)
  assert.equal(view.hasDemoted, true)
  assert.equal(view.showRemovedRecovery, true)
  assert.deepEqual(outputsChromeVisibility(view, false), { shellHidden: false, menuHidden: true, toggleHidden: true })
  assert.deepEqual(outputsChromeVisibility(view, true), { shellHidden: false, menuHidden: false, toggleHidden: true })
  assert.deepEqual(outputsChromeVisibility(outputsPresentation({ outputs: [output()] }), false), { shellHidden: false, menuHidden: false, toggleHidden: false })
})

test('outputs shell is independent of preview and stays reachable with missing local files', () => {
  assert.deepEqual(outputsChromeVisibility(outputsPresentation({ outputs: [] }), false), {
    shellHidden: true, menuHidden: true, toggleHidden: true,
  })
  assert.deepEqual(outputsChromeVisibility(outputsPresentation({ outputs: [output({ available: false })] }), false), {
    shellHidden: false, menuHidden: false, toggleHidden: false,
  })
})

test('revise prompt seeds use the display label without interpreting quotes', () => {
  const row = outputsPresentation({ outputs: [output()] }).rows[0]!
  assert.equal(revisePromptSeed(row), 'Revise "Q3 Audit" (reports/audit.md): ')
  assert.equal(revisePromptSeed({ ...row, label: 'The "real" audit' }), 'Revise "The "real" audit" (reports/audit.md): ')
  const untitled = outputsPresentation({ outputs: [output({ path: 'drafts/final.md', title: '' })] }).rows[0]!
  assert.equal(revisePromptSeed(untitled), 'Revise "final.md" (drafts/final.md): ')
})

test('work-program action messages accept only the exact host bridge shape', () => {
  const message = { type: 'work-program:implement', itemId: 'WP-001' }
  assert.deepEqual(parseWorkProgramActionMessage(message), message)
  assert.equal(parseWorkProgramActionMessage({ ...message, title: 'untrusted' }), null)
  assert.equal(parseWorkProgramActionMessage({ ...message, itemId: 'WP-1' }), null)
  assert.equal(parseWorkProgramActionMessage({ ...message, type: 'work-program:revise' }), null)
  assert.equal(parseWorkProgramActionMessage(Object.create(message)), null)
  assert.equal(parseWorkProgramActionMessage([message.type, message.itemId]), null)
  assert.equal(parseWorkProgramActionMessage(null), null)
})

test('work-program implementation prompt normalizes host-owned title and path', () => {
  assert.equal(
    implementWorkProgramItemPromptSeed({
      itemId: 'WP-001',
      title: '  Q3\n  Work   Program ',
      path: ' reports/\n q3-work-program.md  ',
    }),
    'Implement work-program item WP-001 from "Q3 Work Program" (reports/ q3-work-program.md). Read that item and use its problem, source finding or evidence, intended outcome, priority rationale, dependencies and risks, and completion test as the implementation brief.',
  )
})

test('work-program action resolution requires exact current origin, path, and one shown Markdown output', () => {
  const artifact: ArtifactPayload = {
    url: 'artifact://markdown-slot-0-0123456789abcdef0123456789abcdef/',
    path: 'reports/program.md', title: 'Program', version: 2,
  }
  const shown = output({ path: artifact.path, title: artifact.title, shown: true })
  const message = { type: 'work-program:implement', itemId: 'WP-001' }
  const currentOrigin = 'artifact://markdown-slot-0-0123456789abcdef0123456789abcdef'
  assert.deepEqual(resolveWorkProgramAction(currentOrigin, message, artifact, [shown]), {
    itemId: 'WP-001', title: 'Program', path: 'reports/program.md',
  })
  assert.equal(resolveWorkProgramAction('artifact://markdown-slot-0-old', message, artifact, [shown]), null)
  assert.equal(resolveWorkProgramAction(currentOrigin, message, artifact, [{ ...shown, path: 'other/program.md' }]), null)
  assert.equal(resolveWorkProgramAction(currentOrigin, message, artifact, []), null)
  assert.equal(resolveWorkProgramAction(currentOrigin, message, artifact, [shown, { ...shown, path: 'other.md' }]), null)
  assert.equal(resolveWorkProgramAction(currentOrigin, message, { ...artifact, path: 'program.html' }, [{ ...shown, path: 'program.html' }]), null)
  assert.equal(resolveWorkProgramAction(currentOrigin, { ...message, extra: true }, artifact, [shown]), null)
})

test('work-program actions require a parent-owned Markdown output path', () => {
  for (const path of [
    'reports/work-program.md',
    'reports/nested/Q3.WORK-PROGRAM.MD',
    'reports/work-program.markdown',
    'reports/nested/Q3.WORK-PROGRAM.MARKDOWN',
  ]) {
    assert.equal(isWorkProgramMarkdownPath(path), true, path)
  }

  for (const path of [
    'reports/work-program.html',
    'reports/work-program.md.html',
    'reports/work-program.txt',
    'reports/work-programmd',
    'reports/work-program.md.',
    '.md',
    'reports/.markdown',
    'reports/work-program.md\n',
    'reports/work-program.md\r\n',
    'reports/work-program.md\r',
    'reports/work-program.md\u2028',
    'reports/work-program.md\u2029',
    'reports/work-program.md ',
    'reports/work-program.md\t',
    'reports/work-program.md\0',
    'reports/work-program.md?download=1',
    'reports/work-program.markdown#section',
  ]) {
    assert.equal(isWorkProgramMarkdownPath(path), false, JSON.stringify(path))
  }
})

test('session renderer validates artifact message provenance and host-owned output context', () => {
  const source = readFileSync(new URL('./session.ts', import.meta.url), 'utf8')
  assert.match(source, /event\.source !== artifactFrame\.contentWindow/)
  assert.match(source, /resolveWorkProgramAction\(event\.origin, event\.data, activeArtifact, outputsPayload\.outputs\)/)
  assert.match(source, /implementWorkProgramItemPromptSeed/)
  assert.doesNotMatch(source, /api\.prompt\([^)]*implementWorkProgramItemPromptSeed/)
})

test('artifact Markdown alone opts into delegated work-program actions', () => {
  const source = readFileSync(new URL('../../main/dock/artifactProtocol.ts', import.meta.url), 'utf8')
  assert.match(source, /renderMarkdown\(source, \{ workProgramActions: true \}\)/)
  assert.match(source, /data-work-program-item/)
  assert.match(source, /parent\.postMessage\(\{ type: 'work-program:implement', itemId \}, '\*'\)/)
})

test('save output copy action exposes a failed bridge result on its control', async () => {
  const control = { disabled: false, textContent: 'Save a copy…', title: '' }
  const save = createSaveOutputCopyAction(
    control,
    async () => ({ ok: false, message: 'This output is unavailable.' }),
    { scheduleReset: () => 1, cancelReset: () => {} },
  )

  await save()

  assert.deepEqual(control, { disabled: false, textContent: 'Save failed', title: 'This output is unavailable.' })
})

test('retrying save output copy cancels stale feedback before the next result', async () => {
  const control = { disabled: false, textContent: 'Save a copy…', title: '' }
  const canceled: unknown[] = []
  let scheduled = 0
  let finishRetry!: (result: { ok: boolean; message?: string }) => void
  let attempts = 0
  const save = createSaveOutputCopyAction(
    control,
    async () => {
      attempts += 1
      if (attempts === 1) return { ok: false, message: 'First failure' }
      return new Promise((resolve) => { finishRetry = resolve })
    },
    { scheduleReset: () => ++scheduled, cancelReset: (timer) => canceled.push(timer) },
  )

  await save()
  const retry = save()
  assert.deepEqual(canceled, [1])
  assert.deepEqual(control, { disabled: true, textContent: 'Saving…', title: '' })
  finishRetry({ ok: true })
  await retry
  assert.deepEqual(control, { disabled: false, textContent: 'Saved', title: '' })
})

test('session renderer wires init and push through one compatibility state application', () => {
  const source = readFileSync(new URL('./session.ts', import.meta.url), 'utf8')
  assert.match(source, /api\.onCompatibility\(applyCompatibilityState\)/)
  assert.match(source, /applyCompatibilityState\(state\.compatibility\)/)
  assert.match(source, /checkForUpdates[^\n]*addEventListener\('click', api\.checkForUpdates\)/)
})

function source(overrides: Partial<SourcesPayload['documents'][number]> = {}): SourcesPayload['documents'][number] {
  return { relativePath: '.lore/sources/docs/architecture.md', title: 'Architecture', state: 'ready', ...overrides }
}

test('sources presentation keeps empty and failed inventories distinct', () => {
  assert.deepEqual(sourcesPresentation({ loadState: 'loaded', documents: [] }), { rows: [], count: 0, loadFailed: false, retryable: false })
  assert.deepEqual(sourcesPresentation({ loadState: 'error', documents: [source({ state: 'pending' })] }), {
    rows: [{ relativePath: '.lore/sources/docs/architecture.md', label: 'Architecture', status: 'Pending registration', available: true }],
    count: 1, loadFailed: true, retryable: false,
  })
  assert.equal(sourcesPresentation({ loadState: 'loaded', documents: [source({ state: 'waiting' })] }).retryable, true)
})

test('source inspector presentation selects markdown only for markdown previews', () => {
  assert.equal(sourceInspectorPresentation({ ok: true, title: 'Notes', relativePath: 'notes.md', extension: '.md', text: '# Hi' }).status, 'success')
  assert.deepEqual(sourceInspectorPresentation({ ok: false, reason: 'unreadable', message: 'Could not read it.' }), { status: 'error', message: 'Could not read it.' })
})
