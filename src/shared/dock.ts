/**
 * Pure dock-widget domain logic and DTO types shared by the main process,
 * the dock/session/settings preloads, and their renderers.
 *
 * Ported from claude-dock `src/shared/{layout,title}.js`. Must stay free of
 * Node imports: `tsconfig.web.json` compiles this file for the renderer.
 *
 * This file is part of the surface synced to the open-source lore-workbench
 * repo (see apps/desktop/scripts/dock-oss-sync.mjs) — keep it host-agnostic.
 */
import type { DockTurnReviewDetail, EvidenceDetail } from './dockHostTypes'
import type { MacDockOrientation, MoveMacDockResult } from './dockMacDock'
import type { SourceDocumentPreviewResult } from './dockSourcePreview'

interface ProjectObjectivePayloadBase {
  text: string
  revision: number
  updatedAt: string
  suggestion: { text: string; sourceTurnRef: string; suggestedAt: string } | null
}

export type ProjectObjectivePayload = ProjectObjectivePayloadBase & (
  | { source: 'lore'; sourceTurnRef: string; updatedByUserId: null }
  | { source: 'user'; sourceTurnRef: null; updatedByUserId: string }
)

export interface ProjectRecommendationPayload {
  text: string
  source: 'lore' | 'user'
  sourceTurnRef: string | null
  updatedByUserId: string | null
  revision: number
  updatedAt: string
}

export interface ProjectTerminalWorkPayload {
  kind: 'terminal'
  turnRef: string
  outcomeId: string
  outcome: 'verified_success' | 'unverified_completion' | 'partial_success' | 'blocked' | 'exhausted' | 'cancelled' | 'failed' | 'unknown'
  detail: string
  verification: 'passed' | 'failed' | 'unchecked' | 'unknown' | 'unavailable'
  completedAt: string
  effectCount: number
  reviewId: string | null
}

/** Host-neutral bounded projection consumed by the shared Workbench surface. */
export interface ProjectResumePayload {
  project: { id: string; primaryThreadId: string; updatedAt: string }
  objective: ProjectObjectivePayload
  nextStepRevision: number
  repository: { label: string } | null
  sources: {
    items: Array<{
      id: string
      kind: 'document' | 'artifact' | 'lore_thread'
      title: string
      relativePath: string
      boundAt: string
      loreThreadId: string | null
      loreThreadUrl?: string
    }>
    totalCount: number
  }
  outputs: {
    items: Array<{ id: string; path: string; title: string; versionOrdinal: number; mimeType: string | null; updatedAt: string }>
    totalCount: number
  }
  workProgram: { outputId: string; title: string; selectedItemLabel: string | null } | null
  decisions: {
    items: Array<{ id: string; kind: 'asked' | 'requested' | 'decided' | 'corrected' | 'shared' | 'requirement'; summary: string; sourceBlockId: string; createdAt: string }>
    totalCount: number
  }
  currentWork:
    | { kind: 'none' }
    | { kind: 'unsettled'; turnRef: string; startedAt: string; reason: 'turn_running' | 'effect_in_flight' | 'effect_unknown' | 'reconciliation_pending' }
    | ProjectTerminalWorkPayload
  latestCompletedWork: ProjectTerminalWorkPayload | null
  nextAction:
    | { kind: 'host_blocker'; target: 'reconcile' | 'approval' | 'review'; turnRef: string; label: string }
    | ({ kind: 'recommendation' } & ProjectRecommendationPayload)
    | { kind: 'none' }
}

export function openDesignatedWorkProgram(data: ProjectResumePayload, selectOutput: (path: string) => void): boolean {
  if (!data.workProgram) return false
  const output = data.outputs.items.find((item) => item.id === data.workProgram?.outputId)
  if (!output) return false
  selectOutput(output.path)
  return true
}

export interface DockProjectClient {
  createThreadAndProject(input: { creationKey: string; objective: string }): Promise<{ projectId: string; threadId: string }>
  ensure(input: { threadId: string; objective: string }): Promise<{ projectId: string; threadId: string }>
  readResume(input: { projectId: string; repositoryLabel?: string }): Promise<ProjectResumePayload>
  updateObjective(input: { projectId: string; expectedRevision: number; objective: string; acceptSuggestion: boolean }): Promise<ProjectObjectivePayload>
  updateNextStep(input: { projectId: string; expectedRevision: number; nextStep: string | null }): Promise<{ recommendation: ProjectRecommendationPayload | null; nextStepRevision: number }>
}

export interface ProjectResumeCache {
  resume: ProjectResumePayload
  cachedAt: string
}

export type ProjectResumeState =
  | { status: 'unavailable'; expanded: true; writable: false }
  | { status: 'available'; expanded: true; writable: boolean; freshness: 'fresh' | 'cached'; cachedAt: string; data: ProjectResumePayload; sourceAvailability: Record<string, boolean> }

export type ProjectEditResult = { ok: true } | { ok: false; conflict?: true; message: string }

/** Author-private API result. Task 8 will add bounded fetching and hydration. */
export type ReviewResult =
  | { status: 'success'; review: DockTurnReviewDetail }
  | { status: 'not_found' }
  | { status: 'unavailable'; retryable: true }

/** Host-neutral summary of one active source-registry binding. */
export interface RegisteredSlotSource {
  id: string
  kind: 'document' | 'lore_thread' | 'artifact'
  relativePath: string
  title: string
  /** ISO timestamp used only to keep refresh ordering stable. */
  boundAt: string
}

export type SourceDocumentState = 'ready' | 'pending' | 'waiting' | 'unavailable'

/** Renderer-safe inventory row. Document bytes and absolute paths never cross this boundary. */
export interface SourceDocumentItem {
  relativePath: string
  title: string
  state: SourceDocumentState
}

export interface SourcesPayload {
  /** An error means `documents` is partial local knowledge, not an authoritative empty result. */
  loadState: 'loaded' | 'error'
  documents: SourceDocumentItem[]
}

/** Feedback attached to a Sources action rather than persisted in conversation history. */
export interface SourceActionNotice {
  kind: 'success' | 'error'
  message: string
}

export interface TurnReviewPayload {
  promptBlockId: string
  /** Host-derived from the persisted user entry associated with the Outcome. */
  promptExcerpt: string | null
  review: DockTurnReviewDetail
}

/**
 * Layout constants shared by the main process (window sizing) and the dock
 * renderer (CSS custom properties). Kept in sync via the `Init` IPC payload
 * rather than duplicated literals.
 */
export const LAYOUT = {
  slotWidth: 150,
  slotHeight: 62,
  gap: 8,
  // Slim tray proportions, matched to the homepage Workbench strip.
  margin: 9,
  bottomOffset: 8,
  addButtonWidth: 44,
  /**
   * The push-to-talk mic control at the strip's left end — the add button's
   * left-side mirror. Hosts opt in via `RegisterDockWidgetOptions.micButton`;
   * the effective layout zeroes this when the host has no mic surface.
   */
  micButtonWidth: 44,
  /** Transparent room above the floating strip for its hover-only dismiss control. */
  headerHeight: 22,
  initialSlots: 3,
  /**
   * Extra height the strip window gains while a slot's card stack is open —
   * room for a five-card fan plus the hovered card's note reveal.
   */
  shelfHeight: 330,
  /**
   * Keep the dock comfortably usable when the slot row is sparse or absent.
   */
  minWidth: 308,
  /** Resting edge handle shown while the full strip is tucked away. */
  compactWidth: 64,
  compactHeight: 42,
} as const

/** Widened so hosts can derive variants (e.g. `micButtonWidth: 0` when off). */
export type DockLayout = { [K in keyof typeof LAYOUT]: number }

export interface DockFrame {
  x: number
  y: number
  width: number
  height: number
}

export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

export interface DockPosition {
  x: number
  y: number
}

export interface DockPresentation {
  expanded: boolean
  pinned: boolean
}

export type DockSurface = 'floating' | 'in-app'

export function getDockWidth(slotCount: number, layout: DockLayout = LAYOUT): number {
  const { slotWidth, gap, addButtonWidth, micButtonWidth, margin, minWidth } = layout
  const mic = micButtonWidth > 0 ? micButtonWidth + gap : 0
  const width =
    mic +
    slotWidth * slotCount +
    gap * (slotCount - 1) +
    gap +
    addButtonWidth +
    margin * 2
  return Math.max(width, minWidth)
}

export function getDockHeight(layout: DockLayout = LAYOUT): number {
  return layout.headerHeight + layout.slotHeight + layout.margin * 2
}

/**
 * Compute the dock's on-screen frame.
 *
 * `workArea` already excludes the macOS menu bar and the system Dock, whichever
 * edge it lives on. That is why the widget needs no Accessibility permission and
 * no `defaults write com.apple.dock orientation` workaround.
 */
export function computeDockFrame(
  workArea: WorkArea,
  slotCount: number,
  layout: DockLayout = LAYOUT,
): DockFrame {
  const width = Math.min(getDockWidth(slotCount, layout), workArea.width)
  const height = Math.min(getDockHeight(layout), workArea.height)
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(Math.max(workArea.y, workArea.y + workArea.height - height - layout.bottomOffset)),
    width,
    height,
  }
}

/**
 * Extra bottom clearance for the in-app strip beyond the floating dock's
 * `bottomOffset`, so the tray floats clear of the main window's bottom border
 * instead of sitting on it.
 */
export const IN_APP_BOTTOM_CLEARANCE = 16

/**
 * Frame for the Workbench hosted inside Lore's main window. Opening the card
 * shelf grows the child upward while preserving the strip's bottom anchor.
 */
export function computeInAppDockFrame(
  workArea: WorkArea,
  slotCount: number,
  shelfOpen = false,
  layout: DockLayout = LAYOUT,
): DockFrame {
  const bottomGap = layout.bottomOffset + IN_APP_BOTTOM_CLEARANCE
  const width = Math.min(getDockWidth(slotCount, layout), workArea.width)
  const stripHeight = Math.min(getDockHeight(layout), workArea.height)
  const shelfHeight = shelfOpen
    ? Math.min(layout.shelfHeight, Math.max(0, workArea.height - stripHeight - bottomGap))
    : 0
  const height = stripHeight + shelfHeight
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(Math.max(workArea.y, workArea.y + workArea.height - height - bottomGap)),
    width,
    height,
  }
}

/**
 * Which strip originally launched a slot's session window. Both are detached;
 * the Workbench placement uses the host content region for its initial frame.
 */
export type SessionPlacement = 'floating' | 'embedded'

/** Host chrome an embedded session window must stay clear of. */
export interface EmbeddedInsets {
  /** The host's app bar height. */
  top: number
  /** The host's sidebar width. */
  left: number
}

/** Embedded session windows share the free session window's floor sizes. */
export const SESSION_MIN_WIDTH = 420
export const SESSION_MIN_HEIGHT = 380

/**
 * The region of the host's content bounds that embedded session windows may
 * occupy: below the app bar, right of the sidebar, above the in-app strip.
 */
export function embeddedSessionRegion(
  contentBounds: WorkArea,
  insets: EmbeddedInsets,
  layout: DockLayout = LAYOUT,
): WorkArea {
  const stripBand = getDockHeight(layout) + layout.bottomOffset + IN_APP_BOTTOM_CLEARANCE
  return {
    x: contentBounds.x + insets.left,
    y: contentBounds.y + insets.top,
    width: Math.max(0, contentBounds.width - insets.left),
    height: Math.max(0, contentBounds.height - insets.top - stripBand),
  }
}

/** Keep an embedded session window inside the region after the host resizes. */
export function clampEmbeddedSessionFrame(
  frame: DockFrame,
  contentBounds: WorkArea,
  insets: EmbeddedInsets,
  layout: DockLayout = LAYOUT,
): DockFrame {
  const region = embeddedSessionRegion(contentBounds, insets, layout)
  const width = Math.min(frame.width, Math.max(SESSION_MIN_WIDTH, region.width))
  const height = Math.min(frame.height, Math.max(SESSION_MIN_HEIGHT, region.height))
  return {
    x: Math.round(Math.min(Math.max(frame.x, region.x), Math.max(region.x, region.x + region.width - width))),
    y: Math.round(Math.min(Math.max(frame.y, region.y), Math.max(region.y, region.y + region.height - height))),
    width,
    height,
  }
}

/** Cascaded opening frame for a session window embedded in the Workbench tab. */
export function computeEmbeddedSessionFrame(
  contentBounds: WorkArea,
  insets: EmbeddedInsets,
  cascade: number,
  layout: DockLayout = LAYOUT,
): DockFrame {
  const region = embeddedSessionRegion(contentBounds, insets, layout)
  const width = Math.max(SESSION_MIN_WIDTH, Math.min(760, region.width - 48))
  const height = Math.max(SESSION_MIN_HEIGHT, Math.min(680, region.height - 32))
  const offset = (cascade % 6) * 28
  return clampEmbeddedSessionFrame(
    {
      x: Math.round(region.x + (region.width - width) / 2) + offset,
      y: Math.round(region.y + 16) + offset,
      width,
      height,
    },
    contentBounds,
    insets,
    layout,
  )
}

/** Keep a user-positioned dock fully reachable inside a display's work area. */
export function clampDockFrame(
  workArea: WorkArea,
  position: DockPosition,
  slotCount: number,
  layout: DockLayout = LAYOUT,
): DockFrame {
  const width = Math.min(getDockWidth(slotCount, layout), workArea.width)
  const height = Math.min(getDockHeight(layout), workArea.height)
  const maxX = workArea.x + workArea.width - width
  const maxY = workArea.y + workArea.height - height

  return {
    x: Math.round(Math.min(Math.max(position.x, workArea.x), maxX)),
    y: Math.round(Math.min(Math.max(position.y, workArea.y), maxY)),
    width,
    height,
  }
}

/**
 * Where the full strip should open when the only saved placement is a compact
 * edge handle — i.e. a legacy compact-mode install upgrading to the always-open
 * dock. Centers the strip on the handle and aligns their bottom edges, clamped
 * into the work area, so the saved location (and monitor) survives the upgrade
 * instead of snapping to the primary display's default spot.
 */
export function expandedFrameForHandle(
  workArea: WorkArea,
  handle: DockPosition,
  slotCount: number,
  layout: DockLayout = LAYOUT,
): DockFrame {
  return clampDockFrame(
    workArea,
    {
      x: handle.x + layout.compactWidth / 2 - getDockWidth(slotCount, layout) / 2,
      y: handle.y + layout.compactHeight - getDockHeight(layout),
    },
    slotCount,
    layout,
  )
}

// The artifact pane opens at this width beside the chat column; never grow the
// window past the display's work area (with a small margin so it stays grabbable).
export const ARTIFACT_PANE_WIDTH = 480
export const ARTIFACT_PANE_MIN_WIDTH = 280
const ARTIFACT_CHAT_MIN_WIDTH = 280

export function expandedSessionWidth(chatWidth: number, workAreaWidth: number): number {
  return Math.min(chatWidth + ARTIFACT_PANE_WIDTH, workAreaWidth - 40)
}

/** Keep an in-window artifact resize usable without collapsing the chat. */
export function clampArtifactPaneWidth(width: number, sessionWidth: number): number {
  const max = Math.max(ARTIFACT_PANE_MIN_WIDTH, sessionWidth - ARTIFACT_CHAT_MIN_WIDTH)
  return Math.min(Math.max(width, ARTIFACT_PANE_MIN_WIDTH), max)
}

export const MAX_LABEL = 22

/** Truncate to `max` chars total, with an ellipsis occupying the last character. */
export function truncate(text: string, max: number = MAX_LABEL): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1).trimEnd()}…`
}

/** Last path segment without importing node:path (renderer-safe). */
function basename(folder: string): string {
  const trimmed = folder.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx === -1 ? trimmed : trimmed.slice(idx + 1)
}

export interface SlotLabelInput {
  customName?: string | null
  firstPrompt?: string | null
  folder?: string | null
  index: number
}

/**
 * Resolve the label shown on a dock slot.
 *
 * Priority: user rename > what they first asked for > folder name > "Slot 2".
 *
 * The last fallback names a Slot, so it says Slot: this is a Workbench
 * workspace bound to a folder, not a session (see the Slot entry in
 * apps/api/src/dock/CONTEXT.md — "session" there means three other things).
 */
export function slotLabel({ customName, firstPrompt, folder, index }: SlotLabelInput): string {
  if (customName) return truncate(customName)
  if (firstPrompt) return truncate(firstPrompt)
  if (folder) {
    const base = basename(folder)
    if (base) return truncate(base)
  }
  return `Slot ${index}`
}

/** "/Users/molinar/lore" -> "~/lore" */
export function prettyFolder(folder: string | null | undefined, home = ''): string {
  if (!folder) return ''
  if (home && folder.startsWith(home)) return `~${folder.slice(home.length)}`
  return folder
}

// ---------------------------------------------------------------------------
// Slot cards — host-fed items shown per slot in the strip's hover shelf.
// The dock renders them and reports moves; it never knows what they mean
// (a host might feed captures, files, bookmarks, …). Host-agnostic on purpose.
// ---------------------------------------------------------------------------

/** One card in a slot's shelf stack. All fields are display-ready strings. */
export interface SlotCardItem {
  /** Host-stable id; the move/activate callbacks echo it back. */
  id: string
  title: string
  subtitle: string
  /** Short time label, e.g. "17:03". */
  timeLabel: string
  /** Picks the card's glyph: a document or an image. */
  kindGlyph: 'doc' | 'img'
  /** Sync affordance: 'pending' renders muted with an ellipsis suffix. */
  state: 'synced' | 'pending'
}

/** Per-slot card lists, indexed like `DockSnapshot.slots`. */
export type SlotCardsSnapshot = SlotCardItem[][]

/** A drop target's bounds during a card drag (client coordinates). */
export interface TrapRect {
  index: number
  left: number
  top: number
  right: number
  bottom: number
}

function withinRect(point: { x: number; y: number }, rect: TrapRect, margin: number): boolean {
  return (
    point.x >= rect.left - margin &&
    point.x <= rect.right + margin &&
    point.y >= rect.top - margin &&
    point.y <= rect.bottom + margin
  )
}

/**
 * The trap state machine's core: which target (if any) holds the dragged
 * card. Entering a target's exact bounds captures it; once trapped, the card
 * stays trapped until the pointer leaves the bounds GROWN by `releaseMargin`
 * — the hysteresis that makes a snap feel like a trap instead of a jittery
 * magnet. A direct hit on a different target always steals the trap.
 */
export function resolveTrapTarget(
  point: { x: number; y: number },
  targets: TrapRect[],
  current: number | null,
  releaseMargin = 24,
): number | null {
  const directHit = targets.find((rect) => withinRect(point, rect, 0))
  if (directHit && directHit.index !== current) return directHit.index
  if (current !== null) {
    const trapped = targets.find((rect) => rect.index === current)
    if (trapped && withinRect(point, trapped, releaseMargin)) return current
    return directHit ? directHit.index : null
  }
  return directHit ? directHit.index : null
}

export type SlotStatus = 'empty' | 'idle' | 'working' | 'minimized' | 'active'

/** What the dock renderer needs to draw one slot. */
export interface SlotSnapshot {
  index: number
  label: string
  status: SlotStatus
  hasWindow: boolean
  hasNotification: boolean
  /** True when this slot's session window is the focused window — it wears
   * the traveling selection ring in the strip. */
  focused: boolean
  folder: string | null
}

export interface DockSnapshot {
  slots: SlotSnapshot[]
}

export interface DockInitPayload {
  /**
   * The strip's effective layout: `micButtonWidth` is already zeroed here
   * when the host did not opt into the mic control.
   */
  layout: DockLayout
  state: DockSnapshot
  /** Host-fed shelf cards per slot (empty lists when no host hook is wired). */
  cards: SlotCardsSnapshot
  /**
   * Hide the strip's Settings button. True when the host owns model access —
   * the settings window only manages the BYOK Anthropic key, which is
   * meaningless (and misleading) when turns run on the host's own billing.
   */
  settingsHidden: boolean
  /** The strip rests as an edge handle unless the user pins it open. */
  presentation: DockPresentation
  /** Whether this renderer is the in-app strip or optional global floater. */
  surface: DockSurface
}

/** One tool call rendered as an activity chip inside an assistant bubble. */
export interface TranscriptTool {
  id: string
  label: string
  input?: unknown
  output: string | null
  ok?: boolean
  evidenceBundleId?: string
}

/**
 * What a stopped turn leaves behind in the transcript. One string for both
 * turn paths (the server actor's `aborted` outcome and the local `Agent`'s
 * `done`/aborted), so a stop reads the same however the turn was running.
 */
export const STOPPED_TURN_NOTICE = 'Stopped before finishing.'

/**
 * One replayable transcript entry, mirrored to session windows on (re)open.
 *
 * The `outcome` entry stores the raw value and its reference rather than
 * rendered copy: a replay re-derives the presentation, so a turn settled by an
 * older build with different wording still reads correctly, and a value this
 * build cannot name still replays as a non-committal completion instead of a
 * stale claim.
 *
 * `detail` is the one exception, and deliberately so: it is the HOST's
 * sentence, computed from evidence this process never sees and therefore not
 * re-derivable here. It is stored so the second layer survives a window close
 * along with the headline above it — a replay that kept the headline and
 * dropped what was under it would quietly re-open the gap this entry closes.
 */
export type SessionEntry =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; tools: TranscriptTool[]; sources?: CitationSource[] }
  | { role: 'error'; text: string }
  // A statement about the turn itself rather than about the work — today only
  // "this turn was stopped". Distinct from `error` because a stop is the
  // user's own doing and must not be dressed up as a failure.
  | { role: 'notice'; text: string }
  | { role: 'outcome'; outcome: string; reference?: string; detail?: string }

/**
 * What is durably known about the TASK when a turn settles — as distinct from
 * why the harness stopped advancing, which says nothing about the task.
 * Ordered strongest claim first.
 *
 * **Declared here on purpose, and duplicated on purpose.** This file is
 * byte-synced to the open-source workbench repo, whose surface may import only
 * `electron`, `node:*`, `@anthropic-ai/sdk`, and relative paths (see
 * `apps/desktop/scripts/dock-oss-sync.mjs`). It therefore cannot reach the
 * host's `DOCK_OUTCOMES`, and a standalone build has no host to reach. Two
 * declarations of one closed set are exactly the shape that silently diverges,
 * so a drift test **outside** the synced surface
 * (`src/main/dockSessionBackend.test.ts`) fails the moment a value is added to
 * either side. Change this tuple only together with that one.
 */
export const SESSION_TURN_OUTCOMES = [
  'verified_success',
  'unverified_completion',
  'partial_success',
  'blocked',
  'exhausted',
  'cancelled',
  'failed',
  'unknown',
] as const

export type SessionTurnOutcome = (typeof SESSION_TURN_OUTCOMES)[number]

/** Transient executor compatibility for a remote session (never conversation history). */
export type SessionCompatibilityState =
  | { status: 'ready' }
  | {
      status: 'update_required'
      reason: 'version_metadata_missing' | 'version_no_overlap'
    }

/** How a settled turn presents in the transcript. */
export interface TurnOutcomePresentation {
  /** One line, sentence case. Never hedged, never stronger than the evidence. */
  headline: string
  /** The checkmark. Earned by `verified_success` alone. */
  verified: boolean
  /** Stable prompt association used by the host; never implies visible copy. */
  promptBlockId?: string
  /**
   * A stable reference for a person to quote when reconciling what happened.
   * Present only where the surface is asking someone to look — deliberately a
   * string to read, never a button to press.
   */
  reference?: string
  /**
   * One line about what happened to the person's files, as the host derived it.
   * The second layer, and only ever the second layer: the headline stays
   * exactly what it would have been without it.
   *
   * Absent for a turn that changed nothing — most turns — because a headline
   * with nothing under it is the honest rendering of a turn that was only
   * conversation. Absent too for an outcome this build cannot name: that
   * fallback headline is non-committal precisely because this build does not
   * know what the value means, and pairing it with host prose about that value
   * would let a future host's wording bypass this module's copy table while
   * re-merging the two cases the layer exists to separate.
   */
  detail?: string
}

/**
 * Neutral completion. The turn finished; whether the task landed was not
 * verified. Any hedging belongs one layer deeper, not in the headline — which
 * is also what makes it the safe reading of an outcome this build cannot name.
 */
const NEUTRAL_COMPLETION = 'Finished'

/**
 * The copy a turn shows when it failed and nothing more specific is known.
 *
 * Lives here, in the host-agnostic surface, because `failed` must render
 * something wherever this module is compiled. A host that can say more (the
 * Lore build publishes an error string) shows that instead and suppresses this
 * line; a host that cannot still never renders a failed turn as silence.
 */
export const TURN_FAILURE_TEXT = 'Something went wrong. Try again in a moment.'

/**
 * Every value renders something. There is no `null` here on purpose: a value
 * that renders nothing is a settled turn that ends in silence, and no rule in
 * this file may depend on some other module having spoken first — the modules
 * that could make that promise do not travel with this one.
 */
const OUTCOME_HEADLINES: Record<SessionTurnOutcome, string> = {
  verified_success: 'Done',
  unverified_completion: NEUTRAL_COMPLETION,
  partial_success: 'Partially done',
  blocked: 'Needs you',
  exhausted: 'Ran out of budget',
  cancelled: 'Stopped',
  failed: TURN_FAILURE_TEXT,
  unknown: 'Unconfirmed — needs review',
}

const isKnownOutcome = (value: string): value is SessionTurnOutcome =>
  (SESSION_TURN_OUTCOMES as readonly string[]).includes(value)

/**
 * Map a settled turn's outcome onto what the transcript shows. `null` means
 * add nothing, and is reached only when there is no outcome at all.
 *
 * Takes `string | undefined` rather than the union on purpose, and this is the
 * one seam where that matters. The forward-skew rule — an outcome this build
 * cannot name renders as a non-committal completion — requires an unrecognized
 * wire value to survive the whole path from the host mapper through the sink
 * and the `Done` push to here. A closed union at that seam would force the
 * mapper to either cast (a lie about a value that by construction is not in the
 * set) or drop the value, and dropping it deletes the rule. Exhaustiveness of
 * the copy table is recovered at compile time by `OUTCOME_HEADLINES`'s
 * `Record<SessionTurnOutcome, string>`, and agreement with the host's wire set
 * by the drift test outside the synced surface.
 */
export function describeTurnOutcome(
  outcome: string | undefined,
  reference?: string,
  detail?: string,
): TurnOutcomePresentation | null {
  if (!outcome) return null
  if (!isKnownOutcome(outcome)) return { headline: NEUTRAL_COMPLETION, verified: false }
  return {
    headline: OUTCOME_HEADLINES[outcome],
    verified: outcome === 'verified_success',
    ...(reference ? { promptBlockId: reference } : {}),
    ...(outcome === 'unknown' && reference ? { reference } : {}),
    // Carried through untouched for every nameable outcome — including
    // `verified_success`, whose second layer says what earned the checkmark.
    // An empty string is dropped rather than passed on: a blank second line
    // reads as something withheld, which is worse than no line at all.
    ...(detail ? { detail } : {}),
  }
}

/**
 * The turn ended. `outcome` is absent whenever the host derives none, which is
 * both the standalone/BYOK path and an API that predates outcomes; the payload
 * is then `{}` and the renderer behaves as it always has.
 */
export interface SessionDonePayload {
  /** A `SessionTurnOutcome`, typed as `string` because a newer host may send more. */
  outcome?: string
  /** Stable reference to the settled turn, for a person to quote. */
  reference?: string
  /**
   * The host's one line about what the turn changed, shown below the headline
   * and never in it. Optional in both directions: a host that derives none
   * sends none — including for a turn that changed nothing — and a host that
   * sends one is not thereby promised it will be rendered;
   * `describeTurnOutcome` still decides.
   */
  detail?: string
}

/** Outcome of publishing the shown artifact to Lore (URL already on the clipboard on ok). */
export type ShareArtifactResult = { ok: true; url: string } | { ok: false; message: string }

/** What the session renderer needs to show the artifact pane. */
export interface ArtifactPayload {
  url: string
  title: string
  /** Exact normalized path relative to the Session folder. */
  path: string
  /** Bumped when the agent edits the shown file, forcing an iframe reload. */
  version: number
}

export interface OutputsPayload {
  outputs: Array<{
    path: string
    title: string
    versionOrdinal: number
    demoted: boolean
    mirrored: boolean
    available: boolean
    shown: boolean
  }>
}

export type MirrorOutputHook = (args: {
  bytes: Uint8Array
  path: string
  title: string
  contentHash: string
  sessionId: string
  toolCallId?: string
}) => Promise<{ outputId: string; versionOrdinal: number; versionCreated: boolean }>

export type DockOutputMirrorErrorCode = 'permanent_session_missing' | 'retryable_output_missing'

/** Host-neutral mirror failure classification consumed by the Dock retry policy. */
export class DockOutputMirrorError extends Error {
  constructor(readonly code: DockOutputMirrorErrorCode, message: string) {
    super(message)
    this.name = 'DockOutputMirrorError'
  }
}

export type FetchMirroredOutputHook = (args: {
  path: string
  sessionId: string
}) => Promise<{ downloadUrl: string; fileName: string }>

export type SetOutputDemotedHook = (args: {
  path: string
  sessionId: string
  demoted: boolean
}) => Promise<void>

/** Viewer-authorized Ask evidence carried from an exploration snapshot. */
export interface CitationSource {
  threadId: string
  blockId: string | null
  title: string
  summary: string | null
  startedAt: string
  matchedBy: 'summary' | 'decision' | 'thread'
  decisionSummary: string | null
}

export interface SessionInitPayload {
  index: number
  folder: string | null
  busy: boolean
  /** Bounded Project projection. Collapse state is renderer-owned after init. */
  resume: ProjectResumeState
  /** Whether the host supports reference-document ingestion for this session. */
  canAddReferenceDocument?: boolean
  /** Whether the host supports confined reference-document previews. */
  canPreviewReferenceDocuments?: boolean
  /** Current source inventory, delivered atomically with the initial session state. */
  sources?: SourcesPayload
  /** Retained add failure, delivered atomically across renderer reloads. */
  sourceNotice?: SourceActionNotice
  transcript: SessionEntry[]
  /** Author-private and per-window only; never written to the session store. */
  reviews: TurnReviewPayload[]
  artifact: ArtifactPayload | null
  /** Latest known executor compatibility for this slot's remote session. */
  compatibility?: SessionCompatibilityState
  hasKey: boolean
  /** Host-supplied copy for the blocked banner when hasKey is false. */
  keyPrompt?: string
  /** Hide the "Open Settings" action when the host owns model access. */
  keyActionHidden?: boolean
}

export interface ToolStartPayload {
  id: string
  label: string
  /** Complete validated tool input. Renderers may abbreviate labels, never detail. */
  input: unknown
}

/** Replace the active assistant prose while retaining its tool activity. */
export interface TerminalPresentationPayload {
  text: string
  sources?: CitationSource[]
}

export interface ToolResultPayload {
  id: string
  ok: boolean
  output: string
  /**
   * Optional finished-state chip label. When set, the session renderer swaps
   * the running chip label for this on resolve. Absent for built-in tools.
   */
  label?: string
}

export interface KeyStatePayload {
  hasKey: boolean
  /** Host-supplied copy for the blocked banner when hasKey is false. */
  keyPrompt?: string
  /** Hide the "Open Settings" action when the host owns model access. */
  keyActionHidden?: boolean
}

export interface SettingsInitPayload {
  hasKey: boolean
}

export interface SaveKeyResult {
  ok: boolean
  hasKey?: boolean
  message?: string
}

/**
 * The three preload bridges. Defined here (renderer-safe) so the preloads can
 * `satisfies` them and the renderers can type `window.dock` etc. without
 * importing across tsconfig project boundaries.
 */
export interface DockBridge {
  init(): Promise<DockInitPayload>
  onState(cb: (state: DockSnapshot) => void): () => void
  activate(index: number): void
  activateIn(index: number): void
  close(index: number): void
  minimize(index: number): void
  rename(index: number, name: string): void
  setFocusable(focusable: boolean): void
  addSlot(): void
  minimizeAll(): void
  dismiss(): void
  openSettings(): void
  /** Emit intent to open the quests panel; the host owns what that does. */
  openQuests(): void
  /** Host-fed shelf cards pushed whenever the host's data changes. */
  onSlotCards(cb: (cards: SlotCardsSnapshot) => void): () => void
  /** Ask the host to move a card between slots. False → revert the UI. */
  moveSlotCard(itemId: string, fromIndex: number, toIndex: number): Promise<boolean>
  /** A card was clicked; the host owns what activation means. */
  activateSlotCard(itemId: string): void
  /** The shelf opened/closed — main resizes the strip window upward. */
  setShelfOpen(open: boolean): void
  /** Reveal or tuck the full strip. Pinned strips ignore tuck requests. */
  setExpanded(expanded: boolean): void
  /** Persist whether the full strip should remain visible. */
  setPinned(pinned: boolean): void
  /** Main may tuck the strip when it is hidden or its mode changes. */
  onPresentation(cb: (presentation: DockPresentation) => void): () => void
  /** Native movement state; suppress hover expansion until the handle settles. */
  onWindowMove(cb: (moving: boolean) => void): () => void
  /** Open the macOS Dock position picker window. */
  openMacDockPicker(): void
}

/** Bridge for the macOS Dock position picker window (`window.macDock`). */
export interface MacDockBridge {
  init(): Promise<{ orientation: MacDockOrientation }>
  set(orientation: MacDockOrientation): Promise<MoveMacDockResult>
  close(): void
}

export interface ApprovalPayload {
  effectId: string
  toolCallId: string
  turnId: string
  scope: string
  tier: string
  contentLength: number | null
  state: 'answerable' | 'granted' | 'declined' | 'unanswerable'
  summary?: string
  eligiblePrefix?: string | null
}

export type ApprovalDecision = 'grant_once' | 'grant_prefix' | 'deny'
export type EvidenceResult =
  | { status: 'success'; evidence: EvidenceDetail; shareOrganizationId: string | null }
  | { status: 'not_found' | 'unavailable' | 'failure'; message: string }

export function isTypeId(value: unknown, prefix: 'dfx' | 'evb' | 'org'): value is string {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[0-9A-Za-z]{22}$`).test(value)) return false
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  let decoded = 0n
  for (const character of value.slice(prefix.length + 1)) decoded = decoded * 62n + BigInt(alphabet.indexOf(character))
  return decoded <= (1n << 128n) - 1n
}

export interface SessionBridge {
  folder: string
  init(): Promise<SessionInitPayload | null>
  prompt(text: string): void
  stop(): void
  addReferenceDocument(): void
  addSource(): void
  refreshSources(): void
  retrySources(): void
  previewSource(relativePath: string): Promise<SourceDocumentPreviewResult>
  closeInspector(): void
  openSourceLink(url: string): void
  dismissSourceNotice(): void
  openSettings(): void
  revealFolder(): void
  openLoreSource(threadId: string, blockId: string | null): void
  closeArtifact(): void
  selectOutput(path: string): Promise<void>
  demoteOutput(path: string, demoted: boolean): Promise<void>
  saveOutputCopy(path: string): Promise<{ ok: boolean; message?: string }>
  shareArtifact(): Promise<ShareArtifactResult>
  decideApproval(effectId: string, decision: ApprovalDecision): Promise<{ ok: boolean; message?: string }>
  fetchEvidence(bundleId: string): Promise<EvidenceResult>
  shareEvidence(bundleId: string): Promise<EvidenceResult>
  onAssistantStart(cb: () => void): () => void
  onProgress(cb: (phase: 'connecting' | 'thinking' | 'responding') => void): () => void
  onText(cb: (delta: string) => void): () => void
  onTool(cb: (call: ToolStartPayload) => void): () => void
  onToolResult(cb: (r: ToolResultPayload) => void): () => void
  onTerminal(cb: (presentation: TerminalPresentationPayload) => void): () => void
  onEntry(cb: (entry: SessionEntry) => void): () => void
  onDone(cb: (done: SessionDonePayload) => void): () => void
  onArtifact(cb: (a: ArtifactPayload | null) => void): () => void
  onOutputs(cb: (payload: OutputsPayload) => void): () => void
  onSources(cb: (payload: SourcesPayload) => void): () => void
  onSourceNotice(cb: (notice: SourceActionNotice) => void): () => void
  onKeyState(cb: (s: KeyStatePayload) => void): () => void
  onCompatibility(cb: (s: SessionCompatibilityState) => void): () => void
  /** Ask the trusted host to run its update flow for this session window. */
  checkForUpdates(): void
  onApprovals(cb: (items: ApprovalPayload[]) => void): () => void
  onEvidenceAnnotations(cb: (items: Array<{ toolCallId: string; bundleId: string }>) => void): () => void
  onReviews(cb: (items: TurnReviewPayload[]) => void): () => void
  onResume(cb: (state: ProjectResumeState) => void): () => void
  refreshResume(): Promise<ProjectResumeState | null>
  updateObjective(revision: number, objective: string, acceptSuggestion: boolean): Promise<ProjectEditResult>
  updateNextStep(revision: number, nextStep: string | null): Promise<ProjectEditResult>
  previewResumeSource(sourceId: string): Promise<boolean>
  minimizeWindow(): void
  closeWindow(): void
  zoomWindow(): void
}

export interface SettingsBridge {
  init(): Promise<SettingsInitPayload>
  saveKey(key: string): Promise<SaveKeyResult>
  clearKey(): Promise<SaveKeyResult>
  openConsole(): void
  close(): void
}
