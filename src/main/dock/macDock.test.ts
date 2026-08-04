import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readMacDockOrientation, setMacDockOrientation } from './macDock'

function recordingExec(orientation: string | Error) {
  const calls: Array<{ file: string; args: string[] }> = []
  const exec = async (file: string, args: string[]): Promise<{ stdout: string }> => {
    calls.push({ file, args })
    if (args[0] === 'read') {
      if (orientation instanceof Error) throw orientation
      return { stdout: `${orientation}\n` }
    }
    return { stdout: '' }
  }
  return { exec, calls }
}

test('read falls back to bottom when the defaults key is absent', async () => {
  const { exec } = recordingExec(new Error('does not exist'))
  assert.equal(await readMacDockOrientation(exec), 'bottom')
})

test('set writes the orientation and restarts the Dock', async () => {
  const { exec, calls } = recordingExec('bottom')
  const result = await setMacDockOrientation('left', exec, 'darwin')
  assert.deepEqual(result, { ok: true, orientation: 'left' })
  assert.deepEqual(calls, [
    { file: '/usr/bin/defaults', args: ['write', 'com.apple.dock', 'orientation', 'left'] },
    { file: '/usr/bin/killall', args: ['Dock'] },
  ])
})

test('read returns the current side', async () => {
  const { exec } = recordingExec('right')
  assert.equal(await readMacDockOrientation(exec), 'right')
})

test('surfaces a friendly failure when the write throws', async () => {
  const exec = async (_file: string, args: string[]): Promise<{ stdout: string }> => {
    if (args[0] === 'read') return { stdout: 'bottom' }
    throw new Error('nope')
  }
  const result = await setMacDockOrientation('right', exec, 'darwin')
  assert.deepEqual(result, { ok: false, message: 'Could not move the macOS Dock.' })
})

test('refuses on non-macOS platforms without touching defaults', async () => {
  const { exec, calls } = recordingExec('bottom')
  const result = await setMacDockOrientation('left', exec, 'linux')
  assert.deepEqual(result, { ok: false, message: 'Only available on macOS.' })
  assert.deepEqual(calls, [])
})
