/**
 * Dock telemetry seam. Like ./log, the dock subtree is host-agnostic (it
 * OSS-syncs to lore-workbench), so it cannot import a host's product-analytics
 * module directly. The host injects a sink via
 * `registerDockWidget({ telemetry })`; without one every emit is a no-op,
 * which is what the standalone app wants — it has no analytics at all.
 *
 * Event names are host-agnostic verbs; the host maps them onto its own
 * taxonomy. Props must never carry folder paths, prompt text, or anything
 * user-identifying — counts, lengths, durations, booleans, and enum-ish
 * strings only.
 */

export type DockTelemetryEvent =
  | 'opened'
  | 'dismissed'
  | 'session_started'
  | 'session_opened'
  | 'session_closed'
  | 'prompt_sent'
  | 'turn_completed'
  | 'turn_failed'
  | 'generation_stopped'
  | 'artifact_shown'
  | 'artifact_shared'

export type DockTelemetryProps = Record<string, string | number | boolean>

export type DockTelemetry = (event: DockTelemetryEvent, props?: DockTelemetryProps) => void

let sink: DockTelemetry | null = null

export function setDockTelemetry(telemetry: DockTelemetry | null): void {
  sink = telemetry
}

/** Stable facade — a throwing host sink must never break the dock. */
export const dockTrack: DockTelemetry = (event, props) => {
  try {
    sink?.(event, props)
  } catch {
    // Telemetry is strictly fire-and-forget.
  }
}
