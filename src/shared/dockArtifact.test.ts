import assert from 'node:assert/strict'
import { test } from 'node:test'

import { artifactAction, artifactHost, artifactUrl } from './dockArtifact'

test('successful show_artifact yields a show action with normalized path', () => {
  const a = artifactAction(null, 'show_artifact', { path: './dash.html', title: 'Dash' }, true)
  assert.deepEqual(a, { type: 'show', path: 'dash.html', title: 'Dash' })
})

test('failed show_artifact yields nothing', () => {
  assert.equal(artifactAction(null, 'show_artifact', { path: 'x.html', title: 'X' }, false), null)
})

test('editing the shown file yields a reload', () => {
  const current = { path: 'dash.html', title: 'Dash' }
  assert.deepEqual(artifactAction(current, 'edit_file', { path: './dash.html' }, true), { type: 'reload' })
  assert.deepEqual(artifactAction(current, 'write_file', { path: 'dash.html' }, true), { type: 'reload' })
})

test('editing another file, failing, or having no artifact yields nothing', () => {
  const current = { path: 'dash.html', title: 'Dash' }
  assert.equal(artifactAction(current, 'edit_file', { path: 'other.html' }, true), null)
  assert.equal(artifactAction(current, 'write_file', { path: 'dash.html' }, false), null)
  assert.equal(artifactAction(null, 'edit_file', { path: 'dash.html' }, true), null)
  assert.equal(artifactAction(current, 'read_file', { path: 'dash.html' }, true), null)
})

test('artifactHost and artifactUrl agree per slot', () => {
  assert.equal(artifactHost(3), 'slot-3')
  assert.equal(artifactUrl(3), 'artifact://slot-3/')
  assert.ok(artifactUrl(0).startsWith(`artifact://${artifactHost(0)}`))
})
