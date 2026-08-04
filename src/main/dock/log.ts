/**
 * Dock logging seam. The dock subtree is host-agnostic (it OSS-syncs to
 * lore-workbench), so it cannot import the host's structured logger directly.
 * Instead the host injects one via `registerDockWidget({ logger })`; without
 * a host the sink stays on the console, which is what the standalone app
 * wants anyway.
 */

export interface DockLogger {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

function consoleLine(level: 'log' | 'warn' | 'error', event: string, fields?: Record<string, unknown>): void {
  const tail = fields
    ? ` ${Object.entries(fields)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('  ')}`
    : ''
  console[level](`[dock] ${event}${tail}`)
}

const consoleLogger: DockLogger = {
  info: (event, fields) => consoleLine('log', event, fields),
  warn: (event, fields) => consoleLine('warn', event, fields),
  error: (event, fields) => consoleLine('error', event, fields),
}

let sink: DockLogger = consoleLogger

export function setDockLogger(logger: DockLogger): void {
  sink = logger
}

/** Stable facade — call sites keep working when the host swaps the sink. */
export const dockLog: DockLogger = {
  info: (event, fields) => sink.info(event, fields),
  warn: (event, fields) => sink.warn(event, fields),
  error: (event, fields) => sink.error(event, fields),
}
