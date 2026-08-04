import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dockLog, setDockLogger, type DockLogger } from './log'

test('dockLog routes through an injected host logger', () => {
  const seen: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = []
  const capture = (level: string): DockLogger[keyof DockLogger] =>
    (event, fields) => seen.push({ level, event, fields })
  setDockLogger({ info: capture('info'), warn: capture('warn'), error: capture('error') })

  dockLog.info('session_opened', { slot: 1 })
  dockLog.warn('hotkey_taken', { accelerator: 'Command+Alt+T' })
  dockLog.error('agent_error')

  assert.deepEqual(seen, [
    { level: 'info', event: 'session_opened', fields: { slot: 1 } },
    { level: 'warn', event: 'hotkey_taken', fields: { accelerator: 'Command+Alt+T' } },
    { level: 'error', event: 'agent_error', fields: undefined },
  ])
})
