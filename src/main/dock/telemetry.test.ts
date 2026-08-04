import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dockTrack, setDockTelemetry, type DockTelemetryEvent, type DockTelemetryProps } from './telemetry'

test('dockTrack is a no-op without an injected sink', () => {
  setDockTelemetry(null)
  assert.doesNotThrow(() => dockTrack('opened', { trigger: 'hotkey' }))
})

test('dockTrack routes through an injected host sink', () => {
  const seen: Array<{ event: DockTelemetryEvent; props?: DockTelemetryProps }> = []
  setDockTelemetry((event, props) => seen.push({ event, props }))
  try {
    dockTrack('session_started', { slot_count: 2 })
    dockTrack('dismissed')
  } finally {
    setDockTelemetry(null)
  }

  assert.deepEqual(seen, [
    { event: 'session_started', props: { slot_count: 2 } },
    { event: 'dismissed', props: undefined },
  ])
})

test('a throwing host sink never propagates into the dock', () => {
  setDockTelemetry(() => {
    throw new Error('host analytics exploded')
  })
  try {
    assert.doesNotThrow(() => dockTrack('prompt_sent', { prompt_length: 5 }))
  } finally {
    setDockTelemetry(null)
  }
})
