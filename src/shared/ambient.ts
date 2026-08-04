/**
 * Shared contract for the ambient background agent: the chip the dock strip
 * renders while the agent works, and the IPC channel it rides. Mirrors the
 * shape of `shared/audio.ts` (the audio loop's contract).
 * Design doc: docs/plans/2026-07-14-background-agent-loop-prd.html
 */

export enum AmbientIpcChannel {
  /**
   * Main → mic oval: chip push (null clears immediately). Rendered as the
   * oval's glow — gold while `working`, white otherwise.
   */
  Chip = 'ambient:chip',
  /** Dock strip → main: open the agent's dev panel window. */
  OpenPanel = 'ambient:open-panel',
}

export enum AmbientPanelIpcChannel {
  /** Panel → main (invoke): state + recent runs on mount/refresh. */
  Init = 'ambient:panel:init',
  /**
   * Panel → main: reveal the agent's files in Finder — a specific capture
   * (path relative to the quests dir) or, with no argument, the quests dir
   * itself.
   */
  OpenFiles = 'ambient:panel:open-files',
  /**
   * Panel → main: open the raw transcript the audio loop writes — the most
   * recent `transcript-YYYY-MM-DD.txt`, or the transcripts folder if none
   * exist yet.
   */
  OpenTranscript = 'ambient:panel:open-transcript',
}

/**
 * Chip lifecycle: `working` while a model turn is in flight, then exactly one
 * terminal state (which clears to null after a beat).
 */
export type AmbientChipState = 'working' | 'saved' | 'no-match' | 'error'

/** Background-agent activity pushed to the mic oval (glow + tooltip). */
export interface AmbientChip {
  state: AmbientChipState
  /** Full activity text, e.g. `background agent · saved to "find good wine"`. */
  label: string
}

/** Exposed as `window.dockAmbient` in the dock strip renderer. */
export interface DockAmbientBridge {
  /** Open the agent's dev panel (the bot button). */
  openPanel: () => void
}

/**
 * Every way one agent tick can end once the user actually spoke. Idle ticks
 * (no fresh transcript lines) are not run-log-worthy — they happen 6×/minute.
 */
export type AmbientRunOutcome =
  | 'saved'
  | 'irrelevant'
  | 'no_quests'
  | 'unknown_quest'
  /**
   * Historical only — the hard per-quest cooldown was replaced by semantic
   * dedup (per-line "↳ handled" transcript annotations). Kept so run-log
   * lines written before the change still parse and render.
   */
  | 'cooldown'
  | 'unparseable'
  | 'error'

/** One line of the agent's persisted run log (`quests/agent-runs.jsonl`). */
export interface AmbientRunEntry {
  at: string // ISO 8601
  outcome: AmbientRunOutcome
  /** Quest name, when the run got as far as resolving one. */
  quest: string | null
  /** The model's why-it-matters note, or an error message for `error` runs. */
  note: string | null
  /** Capture path relative to the quests dir (`saved` runs only). */
  file: string | null
}

/** What the dev panel gets on mount/refresh. */
export interface AmbientPanelInitPayload {
  /** Whether the ambient mic is actively capturing right now. */
  captureActive: boolean
  /** Absolute path of the quests dir the agent writes into. */
  questsDir: string
  /** Recent runs, newest first. */
  runs: AmbientRunEntry[]
}

/** Exposed as `window.ambientPanel` in the dev panel renderer. */
export interface AmbientPanelBridge {
  init: () => Promise<AmbientPanelInitPayload>
  openFiles: (file?: string) => void
  /** Open the most recent raw transcript file (or the transcripts folder). */
  openTranscript: () => void
  close: () => void
}
