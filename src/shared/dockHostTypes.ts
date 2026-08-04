/**
 * Host payload shapes the synced dock surface needs to *describe* but does not
 * own. Part of the OSS-synced surface (see apps/desktop/scripts/dock-oss-sync.mjs).
 *
 * These are hand-written mirrors of `packages/contracts`. The synced surface
 * must compile standalone in loredotlink/lore-workbench, whose entire
 * dependency set is `electron`, `@anthropic-ai/sdk` and `@types/node` — so it
 * cannot import `@lore/contracts`, and it cannot import `zod` to infer from the
 * schemas either. This is the same trade already made for `MAX_OUTPUT` in
 * `main/dock/harness/tools.ts`: duplicate the value, keep the boundary.
 *
 * Note that `import type` would not have helped. The `type` keyword erases at
 * emit, but TypeScript still resolves the specifier to find the declaration, so
 * a type-only import of a package lore-workbench lacks is still a TS2307 there.
 * The sync job demonstrated this on 2026-07-15.
 *
 * **Mirroring is allowed; drifting is not.** `dockHostTypes.contract.test.ts`
 * sits outside the synced surface and asserts these types are mutually
 * assignable with the real contracts, in both directions, at typecheck time. A
 * contract change that these do not follow fails `tsc -b`. Widen or narrow a
 * shape here only together with that test going green.
 */

/** Mirrors `SupportedSourceDocumentExtension` (contracts/sourceDocuments). */
export type SupportedSourceDocumentExtension =
  | '.md' | '.markdown' | '.txt' | '.html' | '.htm' | '.json' | '.yaml' | '.yml'
  | '.toml' | '.csv' | '.ts' | '.tsx' | '.js' | '.jsx' | '.py' | '.go' | '.rs'
  | '.sql' | '.sh'

/** Mirrors `EvidenceWorkbenchSummary` (contracts/evidence). */
export type EvidenceWorkbenchSummary = {
  bundleId: string
  kind: 'dock_effect' | 'dock_turn_outcome'
  toolCallId: string | null
  status: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// Evidence detail (contracts/evidence)
// ---------------------------------------------------------------------------

export type EvidenceSettlement =
  | 'not_dispatched' | 'in_flight' | 'committed' | 'failed_before_commit' | 'aborted' | 'unknown'
export type EvidenceVerificationStatus = 'passed' | 'failed' | 'unchecked' | 'unknown'

export type EvidenceVerification = {
  status: EvidenceVerificationStatus
  policy: string
  policyVersion: number
  expectedDigest: string | null
  observedDigest: string | null
  verifiedAt: string
}

export type EvidenceAuthorityRequirement = {
  tier: 'whole_file_replacement' | 'deletion' | 'non_allowlisted_shell' | 'submit_class_browser'
  scope: string
  policyVersion: string
} | null

export type EvidenceAuthority =
  | { authorizationId: string; requirement: EvidenceAuthorityRequirement; source: 'approval'; approvalId: string; standingPolicyId: null }
  | { authorizationId: string; requirement: EvidenceAuthorityRequirement; source: 'standing_policy'; approvalId: null; standingPolicyId: string }
  | { authorizationId: string; requirement: EvidenceAuthorityRequirement; source: 'none'; approvalId: null; standingPolicyId: null }

type EvidenceDetailBase = {
  bundleId: string
  authorUserId: string
  organizationId: string | null
  visibility: 'private' | 'organization'
  createdAt: string
  promotedAt: string | null
  copyUrl: string | null
}

export type EvidenceEffectDetail = EvidenceDetailBase & {
  kind: 'dock_effect'
  effectId: string
  toolCallId: string
  action: string
  scope: string | null
  settlement: EvidenceSettlement
  retryClass: 'read_only' | 'byte_idempotent' | 'reconcile_first' | 'never'
  attempts: {
    ordinal: number
    status: EvidenceSettlement
    receiptPresent: boolean
    dispatchedAt: string
    respondedAt: string | null
  }[]
  verifications: EvidenceVerification[]
  authority: EvidenceAuthority
}

export type EvidenceOutcomeDetail = EvidenceDetailBase & {
  kind: 'dock_turn_outcome'
  promptBlockId: string
  outcome: DockTurnOutcome
  stopReason: 'end_turn' | 'aborted' | 'error'
  iterations: number | null
  settledAt: string
  verificationConclusions: { status: EvidenceVerificationStatus }[]
}

/** Mirrors `EvidenceDetail` (contracts/evidence). */
export type EvidenceDetail = EvidenceEffectDetail | EvidenceOutcomeDetail

// ---------------------------------------------------------------------------
// Turn review detail (contracts/dockTurnReview)
// ---------------------------------------------------------------------------

export type DockTurnOutcome =
  | 'verified_success' | 'unverified_completion' | 'partial_success' | 'blocked'
  | 'exhausted' | 'cancelled' | 'failed' | 'unknown'

export type DockTurnReviewLimitation =
  | 'baseline_file_too_large' | 'baseline_budget_exhausted' | 'baseline_raced'
  | 'baseline_path_unavailable' | 'path_limit' | 'patch_truncated'
  | 'git_finalize_unavailable' | 'ignored_shell_changes_unobservable'
  | 'repository_changed' | 'path_unavailable' | 'command_unavailable'
  | 'executor_unavailable' | 'structured_result_budget'

export type DockTurnReviewChange = 'created' | 'modified' | 'deleted' | 'renamed'

export type DockTurnReviewComparisonEntry =
  | {
      kind: 'patch'
      path: string
      change: DockTurnReviewChange
      beforeMode: string | null
      afterMode: string | null
      patch: string
      effectIds: string[]
    }
  | {
      kind: 'binary'
      path: string
      change: DockTurnReviewChange
      beforeMode: string | null
      afterMode: string | null
      beforeDigest: string | null
      afterDigest: string | null
      beforeLength: number | null
      afterLength: number | null
      effectIds: string[]
    }
  | {
      kind: 'omission'
      path?: string
      change?: DockTurnReviewChange
      reason: DockTurnReviewLimitation
      effectIds: string[]
    }

export type DockTurnReviewDocument = {
  version: 1
  status: 'complete' | 'partial' | 'unavailable'
  mode: 'git' | 'file' | 'ledger_only'
  promptBlockId: string
  workItemRef: string | null
  outcomeId: string
  entries: DockTurnReviewComparisonEntry[]
  commandEffects: { effectId: string; toolCallId: string }[]
  attemptedEffects: { effectId: string; toolCallId: string }[]
  omittedCount: number
  limitations: DockTurnReviewLimitation[]
}

/** Turn-review verification carries an extra `unavailable` the Evidence one does not. */
export type DockTurnReviewVerification = EvidenceVerificationStatus | 'unavailable'

export type DockTurnReviewFileDetail = {
  path: string
  association: 'workbench_effect' | 'shell_observed_unresolved' | 'unresolved'
  effectIds: string[]
  settlement: EvidenceSettlement | null
  verification: DockTurnReviewVerification
  comparisonKind: 'patch' | 'binary' | 'omission'
  limitation: DockTurnReviewLimitation | null
}

type DockTurnReviewCommandFields = {
  effectId: string
  toolCallId: string
  state: 'run' | 'requested_not_run'
  settlement: EvidenceSettlement
  receiptPresent: boolean
  reportedResult: {
    state: 'success' | 'error' | 'unavailable'
    text: string | null
    truncated: boolean
  }
  verification: DockTurnReviewVerification
}

export type DockTurnReviewCommandDetail =
  | (DockTurnReviewCommandFields & { availability: 'available'; command: string })
  | (DockTurnReviewCommandFields & { availability: 'command_unavailable'; command: null })

export type DockTurnReviewNeedsReviewDetail = {
  effectId: string
  toolCallId: string
  primitive: 'fs.writeFile' | 'fs.editFile' | 'shell.exec'
  path: string | null
  reason: 'path_unavailable' | 'not_compared' | 'non_committed'
  settlement: EvidenceSettlement
  verification: DockTurnReviewVerification
}

/** Mirrors `DockTurnReviewDetail` (contracts/dockTurnReview). */
export type DockTurnReviewDetail = {
  reviewId: string
  reconciliation: 'not_required' | 'pending' | 'attempted' | 'installed' | 'exhausted'
  document: DockTurnReviewDocument
  outcome: DockTurnOutcome
  files: DockTurnReviewFileDetail[]
  commands: DockTurnReviewCommandDetail[]
  needsReview: DockTurnReviewNeedsReviewDetail[]
}

/**
 * There is deliberately no validator seam here. Evidence is validated once, by
 * `main/dockSessionBackend.fetchEvidence`, which is host code and runs
 * `evidenceDetailSchema.parse` before the payload crosses IPC; a failure there
 * surfaces as `status: 'failure'`. The synced renderer consumes the already
 * typed `EvidenceResult` and adds no second check, so there is no second
 * validator to keep in step with the contract — and none is reachable anyway,
 * since Zod is not a lore-workbench dependency.
 */
