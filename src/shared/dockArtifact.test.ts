import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_SLOT_OUTPUTS,
  artifactAction,
  artifactHost,
  artifactUrl,
  markOutputMirrored,
  promotedOutputs,
  recordOutput,
  setOutputDemoted,
  type SlotOutput,
} from './dockArtifact'

function output(overrides: Partial<SlotOutput> = {}): SlotOutput {
  return {
    path: 'guide.md',
    title: 'Guide',
    contentHash: `sha256:${'a'.repeat(64)}`,
    versionOrdinal: 1,
    demoted: false,
    demotionPending: false,
    updatedAtMs: 10,
    mirrored: false,
    ...overrides,
  }
}

test('successful show_artifact yields a show action with normalized path', () => {
  const a = artifactAction(null, 'show_artifact', { path: './dash.html', title: 'Dash' }, true, 'toolu_show')
  assert.deepEqual(a, { type: 'show', path: 'dash.html', title: 'Dash', toolCallId: 'toolu_show' })
})

test('legacy show_artifact omits missing call identity', () => {
  assert.deepEqual(
    artifactAction(null, 'show_artifact', { path: 'dash.html', title: 'Dash' }, true),
    { type: 'show', path: 'dash.html', title: 'Dash' },
  )
})

test('failed show_artifact yields nothing', () => {
  assert.equal(artifactAction(null, 'show_artifact', { path: 'x.html', title: 'X' }, false), null)
})

test('a failed re-show cannot replace the prior successful identity', () => {
  const before = [output({ toolCallId: 'show-success', mirrored: true })]
  const action = artifactAction({ path: 'guide.md', title: 'Guide' }, 'show_artifact', {
    path: 'guide.md', title: 'Guide',
  }, false, 'show-failed')

  assert.equal(action, null)
  assert.deepEqual(before, [output({ toolCallId: 'show-success', mirrored: true })])
})

test('recordOutput replaces show identity even when bytes and title are unchanged', () => {
  const result = recordOutput([output({ toolCallId: 'show-old', mirrored: true })], {
    path: 'guide.md', title: 'Guide', contentHash: `sha256:${'a'.repeat(64)}`,
    atMs: 20, toolCallId: 'show-new',
  })

  assert.equal(result.changed, 'unchanged')
  assert.equal(result.outputs[0]?.toolCallId, 'show-new')
  assert.equal(result.outputs[0]?.mirrored, false)
})

test('editing the shown file yields a reload', () => {
  const current = { path: 'dash.html', title: 'Dash' }
  assert.deepEqual(artifactAction(current, 'edit_file', { path: './dash.html' }, true), { type: 'reload' })
  assert.deepEqual(artifactAction(current, 'write_file', { path: 'dash.html' }, true), { type: 'reload' })
})

test('recording an edit reload retains the prior successful show identity', () => {
  const result = recordOutput([output({ toolCallId: 'show-success', mirrored: true })], {
    path: 'guide.md', title: 'Guide', contentHash: `sha256:${'b'.repeat(64)}`, atMs: 20,
  })

  assert.equal(result.changed, 'revised')
  assert.equal(result.outputs[0]?.toolCallId, 'show-success')
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

test('recordOutput creates a normalized output without mutating its input', () => {
  const before: SlotOutput[] = []
  const result = recordOutput(before, {
    path: './guide.md',
    title: 'Guide',
    contentHash: `sha256:${'a'.repeat(64)}`,
    atMs: 10,
  })

  assert.equal(result.changed, 'created')
  assert.deepEqual(result.outputs, [output()])
  assert.deepEqual(before, [])
})

test('recordOutput revises changed and unknown hashes and re-promotes the output', () => {
  const before = [output({ demoted: true, mirrored: true })]
  const revised = recordOutput(before, {
    path: './guide.md',
    title: 'Guide',
    contentHash: `sha256:${'b'.repeat(64)}`,
    atMs: 20,
  })
  const unknown = recordOutput(revised.outputs, {
    path: 'guide.md',
    title: 'Guide',
    contentHash: null,
    atMs: 30,
  })

  assert.equal(revised.changed, 'revised')
  assert.deepEqual(revised.outputs, [
    output({
      contentHash: `sha256:${'b'.repeat(64)}`,
      versionOrdinal: 2,
      demoted: false,
      demotionPending: true,
      updatedAtMs: 20,
    }),
  ])
  assert.equal(unknown.changed, 'revised')
  assert.equal(unknown.outputs[0]?.versionOrdinal, 3)
  assert.equal(unknown.outputs[0]?.contentHash, null)
  assert.deepEqual(before, [output({ demoted: true, mirrored: true })])
})

test('recordOutput distinguishes unchanged output from a rename', () => {
  const before = [output({ mirrored: true })]
  const unchanged = recordOutput(before, {
    path: './guide.md',
    title: 'Guide',
    contentHash: `sha256:${'a'.repeat(64)}`,
    atMs: 20,
  })
  const renamed = recordOutput(before, {
    path: 'guide.md',
    title: 'New guide',
    contentHash: `sha256:${'a'.repeat(64)}`,
    atMs: 20,
  })

  assert.equal(unchanged.changed, 'unchanged')
  assert.deepEqual(unchanged.outputs, before)
  assert.equal(renamed.changed, 'renamed')
  assert.deepEqual(renamed.outputs, [output({ title: 'New guide', mirrored: true, updatedAtMs: 20 })])
  assert.deepEqual(before, [output({ mirrored: true })])
})

test('recordOutput re-promotes an identical demoted output with pending reconciliation', () => {
  const result = recordOutput([output({ demoted: true, demotionPending: false, mirrored: true })], {
    path: './guide.md', title: 'Guide', contentHash: `sha256:${'a'.repeat(64)}`, atMs: 20,
  })

  assert.equal(result.changed, 'unchanged')
  assert.deepEqual(result.outputs, [output({ demoted: false, demotionPending: true, mirrored: true, updatedAtMs: 20 })])
})

test('demotion and mirror decisions match normalized path and version without mutation', () => {
  const before = [output()]
  const demoted = setOutputDemoted(before, './guide.md', true)
  const mirrored = markOutputMirrored(before, './guide.md', 1)

  assert.deepEqual(demoted, [output({ demoted: true, demotionPending: true })])
  assert.deepEqual(mirrored, [output({ mirrored: true })])
  assert.strictEqual(setOutputDemoted(before, 'missing.md', true), before)
  assert.strictEqual(markOutputMirrored(before, 'guide.md', 2), before)
  assert.deepEqual(before, [output()])
})

test('promotedOutputs excludes demoted outputs and stably orders newest first', () => {
  const first = output({ path: 'first.md', updatedAtMs: 10 })
  const second = output({ path: 'second.md', updatedAtMs: 20 })
  const equal = output({ path: 'equal.md', updatedAtMs: 20 })
  const hidden = output({ path: 'hidden.md', updatedAtMs: 30, demoted: true })
  const before = [first, second, equal, hidden]

  assert.deepEqual(promotedOutputs(before), [second, equal, first])
  assert.deepEqual(before, [first, second, equal, hidden])
})

test('recordOutput caps outputs by age without dropping the newly recorded output', () => {
  const before = Array.from({ length: MAX_SLOT_OUTPUTS }, (_, index) =>
    output({ path: `${index}.md`, updatedAtMs: index + 1 }),
  )
  const result = recordOutput(before, {
    path: 'new.md',
    title: 'New',
    contentHash: `sha256:${'c'.repeat(64)}`,
    atMs: 0,
  })

  assert.equal(result.outputs.length, MAX_SLOT_OUTPUTS)
  assert.ok(result.outputs.some(({ path }) => path === 'new.md'))
  assert.ok(!result.outputs.some(({ path }) => path === '0.md'))
  assert.deepEqual(before.length, MAX_SLOT_OUTPUTS)
})

test('recordOutput caps an already oversized list when creating a new output', () => {
  const before = Array.from({ length: MAX_SLOT_OUTPUTS + 5 }, (_, index) =>
    output({ path: `${index}.md`, updatedAtMs: index + 1 }),
  )
  const result = recordOutput(before, {
    path: 'new.md',
    title: 'New',
    contentHash: `sha256:${'c'.repeat(64)}`,
    atMs: 0,
  })

  assert.equal(result.outputs.length, MAX_SLOT_OUTPUTS)
  assert.ok(result.outputs.some(({ path }) => path === 'new.md'))
  assert.ok(result.outputs.some(({ path }) => path === `${MAX_SLOT_OUTPUTS + 4}.md`))
  assert.ok(!result.outputs.some(({ path }) => path === '5.md'))
  assert.equal(before.length, MAX_SLOT_OUTPUTS + 5)
})

test('recordOutput caps an already oversized list when updating an output', () => {
  const before = Array.from({ length: MAX_SLOT_OUTPUTS + 5 }, (_, index) =>
    output({ path: `${index}.md`, updatedAtMs: index + 1 }),
  )
  const result = recordOutput(before, {
    path: '0.md',
    title: 'Revised',
    contentHash: `sha256:${'d'.repeat(64)}`,
    atMs: 0,
  })

  assert.equal(result.outputs.length, MAX_SLOT_OUTPUTS)
  assert.deepEqual(
    result.outputs.find(({ path }) => path === '0.md'),
    output({
      path: '0.md',
      title: 'Revised',
      contentHash: `sha256:${'d'.repeat(64)}`,
      versionOrdinal: 2,
      updatedAtMs: 0,
    }),
  )
  assert.ok(result.outputs.some(({ path }) => path === `${MAX_SLOT_OUTPUTS + 4}.md`))
  assert.ok(!result.outputs.some(({ path }) => path === '5.md'))
  assert.equal(before[0]?.title, 'Guide')
  assert.equal(before.length, MAX_SLOT_OUTPUTS + 5)
})
