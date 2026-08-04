import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { DockStore, sanitize } from './store'

const VALID_CONTENT_HASH = `sha256:${'a'.repeat(64)}`

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lore-dock-store-')), 'dock-state.json')
}

test('sanitize returns defaults for garbage input', () => {
  assert.equal(sanitize('nope').slotCount, 3)
  assert.deepEqual(sanitize(undefined).slots, [])
  assert.equal(sanitize(undefined).dockVisible, false)
  assert.equal(sanitize(undefined).dockPosition, null)
  assert.equal(sanitize(undefined).dockHandlePosition, null)
  assert.equal(sanitize(undefined).dockPinned, true, 'the dock ships open by default')
})

test('sanitize clamps slotCount to a sane range', () => {
  assert.equal(sanitize({ slotCount: 0 }).slotCount, 1)
  assert.equal(sanitize({ slotCount: 999 }).slotCount, 12)
  assert.equal(sanitize({ slotCount: 1.5 }).slotCount, 3, 'non-integers fall back')
})

test('sanitize strips unknown slot fields and keeps name/folder', () => {
  const s = sanitize({ slotCount: 2, slots: [{ customName: 'a', folder: '/tmp', evil: 1 }] })
  assert.deepEqual(s.slots, [
    {
      customName: 'a',
      folder: '/tmp',
      artifact: null,
      outputs: [],
      firstPrompt: null,
      transcript: [],
      agentMessages: [],
      mirrorSessionId: null,
      remoteThreadId: null,
      projectCreationKey: null,
      projectId: null,
      projectResumeCache: null,
      pendingSources: [],
    },
  ])
})

test('sanitize keeps session content: firstPrompt, transcript, agentMessages, mirrorSessionId', () => {
  const sources = [{
    threadId: 'th_source', blockId: 'tb_source', title: 'Source', summary: 'Excerpt',
    startedAt: '2026-07-30T12:00:00.000Z', matchedBy: 'decision', decisionSummary: 'Decision',
  }]
  const transcript = [
    { role: 'user', text: 'plan my trip' },
    { role: 'assistant', text: 'Sure.', tools: [], sources },
    { role: 'error', text: 'oops' },
  ]
  const agentMessages = [
    { role: 'user', content: 'plan my trip' },
    { role: 'assistant', content: [{ type: 'text', text: 'Sure.' }] },
  ]
  const s = sanitize({
    slotCount: 1,
    slots: [{ folder: '/tmp', firstPrompt: 'plan my trip', transcript, agentMessages, mirrorSessionId: 'abc-123', remoteThreadId: 'th_123' }],
  })
  assert.equal(s.slots[0].firstPrompt, 'plan my trip')
  assert.deepEqual(s.slots[0].transcript, transcript)
  assert.deepEqual(s.slots[0].agentMessages, agentMessages)
  assert.equal(s.slots[0].mirrorSessionId, 'abc-123')
  assert.equal(s.slots[0].remoteThreadId, 'th_123')
})

test('sanitize drops malformed citation sources without dropping the assistant answer', () => {
  const state = sanitize({
    slotCount: 1,
    slots: [{ transcript: [{
      role: 'assistant',
      text: 'Answer [S1]',
      tools: [],
      sources: [
        { threadId: 'th_bad', blockId: null, title: 42 },
        { threadId: 'th_bad', blockId: null, title: 'Bad match', summary: null, startedAt: 'today', matchedBy: 'other', decisionSummary: null },
      ],
    }] }],
  })
  assert.deepEqual(state.slots[0].transcript, [{ role: 'assistant', text: 'Answer [S1]', tools: [] }])
})

test('sanitize reads old slot state without a remote identity', () => {
  const slot = sanitize({ slotCount: 1, slots: [{ folder: '/tmp' }] }).slots[0]
  assert.equal(slot.remoteThreadId, null)
  assert.equal(slot.projectCreationKey, null)
  assert.equal(slot.projectId, null)
  assert.equal(slot.projectResumeCache, null)
})

test('sanitize drops a malformed Project cache without losing replay state', () => {
  const slot = sanitize({ slotCount: 1, slots: [{
    folder: '/tmp', remoteThreadId: 'th_1', projectCreationKey: 'key-1', projectId: 'dprj_1',
    transcript: TRANSCRIPT_FIXTURE, outputs: [{ path: 'out.html', title: 'Output' }],
    projectResumeCache: { cachedAt: 'not-a-date', resume: { project: { id: 7 } } },
  }] }).slots[0]
  assert.equal(slot.projectCreationKey, 'key-1')
  assert.equal(slot.projectId, 'dprj_1')
  assert.equal(slot.projectResumeCache, null)
  assert.deepEqual(slot.transcript, TRANSCRIPT_FIXTURE)
  assert.equal(slot.outputs.length, 1)
})

test('sanitize rejects malformed nested Project DTOs and real collection caps without losing Slot state', () => {
  const base = {
    project: { id: 'dprj_1', primaryThreadId: 'th_1', updatedAt: '2026-08-02T12:00:00.000Z' },
    objective: { text: 'Goal', source: 'user', sourceTurnRef: null, revision: 1, updatedAt: '2026-08-02T12:00:00.000Z', updatedByUserId: 'user_1', suggestion: null },
    nextStepRevision: 0, repository: null,
    sources: { items: [], totalCount: 0 }, outputs: { items: [], totalCount: 0 }, workProgram: null,
    decisions: { items: [], totalCount: 0 }, currentWork: { kind: 'none' }, latestCompletedWork: null, nextAction: { kind: 'none' },
  }
  const malformed = [
    { ...base, objective: { ...base.objective, source: 'lore', sourceTurnRef: null, updatedByUserId: 'user_1' } },
    { ...base, objective: { ...base.objective, source: 'user', sourceTurnRef: 'turn_1', updatedByUserId: null } },
    { ...base, sources: { items: [{ id: 's', kind: 'document', title: 'x', relativePath: '../escape', boundAt: base.project.updatedAt, loreThreadId: null }], totalCount: 1 } },
    { ...base, nextAction: { kind: 'host_blocker', target: 'wrong', turnRef: 'turn', label: 'x' } },
    { ...base, currentWork: { kind: 'terminal', turnRef: 't' } },
    { ...base, decisions: { items: Array.from({ length: 11 }, (_, i) => ({ id: `d${i}`, kind: 'decided', summary: 'x', sourceBlockId: 'b', createdAt: base.project.updatedAt })), totalCount: 11 } },
  ]
  for (const resume of malformed) {
    const slot = sanitize({ slotCount: 1, slots: [{ transcript: TRANSCRIPT_FIXTURE, projectResumeCache: { cachedAt: base.project.updatedAt, resume } }] }).slots[0]
    assert.equal(slot.projectResumeCache, null)
    assert.deepEqual(slot.transcript, TRANSCRIPT_FIXTURE)
  }
})

test('sanitize rejects a persisted Project cache with a non-ISO parseable timestamp', () => {
  const resume = validProjectResume()
  const slot = sanitize({ slotCount: 1, slots: [{ projectResumeCache: { cachedAt: 'August 2, 2026', resume } }] }).slots[0]
  assert.equal(slot.projectResumeCache, null)
})

test('sanitize rejects a persisted Project cache with a non-URL Lore thread source', () => {
  const resume = validProjectResume()
  resume.sources = { items: [{ id: 'source-1', kind: 'lore_thread', title: 'Prior work', relativePath: 'threads/prior.md', boundAt: resume.project.updatedAt, loreThreadId: 'th_2', loreThreadUrl: 'not-a-url' }], totalCount: 1 }
  const slot = sanitize({ slotCount: 1, slots: [{ projectResumeCache: { cachedAt: resume.project.updatedAt, resume } }] }).slots[0]
  assert.equal(slot.projectResumeCache, null)
})

test('sanitize rejects a persisted Project cache with an oversized selected item label', () => {
  const resume = validProjectResume()
  resume.workProgram = { outputId: 'output-1', title: 'Plan', selectedItemLabel: 'x'.repeat(4_001) }
  const slot = sanitize({ slotCount: 1, slots: [{ projectResumeCache: { cachedAt: resume.project.updatedAt, resume } }] }).slots[0]
  assert.equal(slot.projectResumeCache, null)
})

function validProjectResume() {
  return {
    project: { id: 'dprj_1', primaryThreadId: 'th_1', updatedAt: '2026-08-02T12:00:00.000Z' },
    objective: { text: 'Goal', source: 'user', sourceTurnRef: null, revision: 1, updatedAt: '2026-08-02T12:00:00.000Z', updatedByUserId: 'user_1', suggestion: null },
    nextStepRevision: 0, repository: null,
    sources: { items: [] as Array<Record<string, unknown>>, totalCount: 0 }, outputs: { items: [], totalCount: 0 }, workProgram: null as Record<string, unknown> | null,
    decisions: { items: [], totalCount: 0 }, currentWork: { kind: 'none' }, latestCompletedWork: null, nextAction: { kind: 'none' },
  }
}

const TRANSCRIPT_FIXTURE = [{ role: 'user' as const, text: 'keep me' }]

test('sanitize reads old slot state with no pendingSources field, defaulting to empty', () => {
  const slot = sanitize({ slotCount: 1, slots: [{ folder: '/tmp' }] }).slots[0]
  assert.deepEqual(slot.pendingSources, [])
})

test('sanitize keeps well-formed pendingSources and drops malformed entries', () => {
  const s = sanitize({
    slotCount: 1,
    slots: [{
      folder: '/tmp',
      pendingSources: [
        { relativePath: '.lore/sources/docs/arch.md', title: 'arch.md' },
        { relativePath: 42, title: 'bad.md' },
        { relativePath: '.lore/sources/docs/notes.md' },
        'junk',
        null,
      ],
    }],
  })
  assert.deepEqual(s.slots[0].pendingSources, [
    { relativePath: '.lore/sources/docs/arch.md', title: 'arch.md' },
  ])
})

test('sanitize preserves failed pending registration state without accepting unrelated fields', () => {
  const slot = sanitize({
    slotCount: 1,
    slots: [{ pendingSources: [{
      relativePath: '.lore/sources/docs/arch.md',
      title: 'arch.md',
      registrationFailed: true,
      content: 'must not persist',
      absolutePath: '/private/arch.md',
    }] }],
  }).slots[0]

  assert.deepEqual(slot.pendingSources, [{
    relativePath: '.lore/sources/docs/arch.md',
    title: 'arch.md',
    registrationFailed: true,
  }])
})

test('sanitize reads legacy pending sources without registrationFailed', () => {
  const [source] = sanitize({
    slotCount: 1,
    slots: [{ pendingSources: [{ relativePath: '.lore/sources/docs/legacy.md', title: 'legacy.md' }] }],
  }).slots[0].pendingSources

  assert.deepEqual(source, { relativePath: '.lore/sources/docs/legacy.md', title: 'legacy.md' })
})

test('sanitize falls back to empty pendingSources for a non-array value', () => {
  const s = sanitize({ slotCount: 1, slots: [{ folder: '/tmp', pendingSources: 'nope' }] })
  assert.deepEqual(s.slots[0].pendingSources, [])
})

test('sanitize persists only a string remote identity, never backend connection details', () => {
  const slot = sanitize({
    slotCount: 1,
    slots: [{ folder: '/tmp', remoteThreadId: 'th_safe', token: 'secret', socket: { ready: true }, executor: 'private' }],
  }).slots[0] as unknown as Record<string, unknown>
  assert.equal(slot.remoteThreadId, 'th_safe')
  assert.equal('token' in slot, false)
  assert.equal('socket' in slot, false)
  assert.equal('executor' in slot, false)
})

test('sanitize drops malformed transcript entries and non-array agentMessages', () => {
  const s = sanitize({
    slotCount: 1,
    slots: [
      {
        folder: '/tmp',
        firstPrompt: 42,
        transcript: [{ role: 'user' }, { role: 'alien', text: 'hi' }, 'junk', { role: 'user', text: 'ok' }],
        agentMessages: 'not-an-array',
        mirrorSessionId: 7,
      },
    ],
  })
  assert.equal(s.slots[0].firstPrompt, null)
  assert.deepEqual(s.slots[0].transcript, [{ role: 'user', text: 'ok' }])
  assert.deepEqual(s.slots[0].agentMessages, [])
  assert.equal(s.slots[0].mirrorSessionId, null)
})

test('sanitize keeps a settled outcome entry and drops one with nothing to render', () => {
  const s = sanitize({
    slotCount: 1,
    slots: [
      {
        folder: '/tmp',
        transcript: [
          { role: 'outcome', outcome: 'verified_success' },
          { role: 'outcome', outcome: 'unknown', reference: 'tb_prompt' },
          // A value this build cannot name is still kept: the renderer decides
          // what to make of it, and dropping it would lose a real settlement.
          { role: 'outcome', outcome: 'reconciled_later' },
          { role: 'outcome' },
          { role: 'outcome', outcome: '' },
          { role: 'outcome', outcome: 7 },
          { role: 'outcome', outcome: 'unknown', reference: 42 },
          // The second layer survives a restart with the headline above it: a
          // replay that kept one and dropped the other would re-open the gap
          // the two of them together close.
          { role: 'outcome', outcome: 'unverified_completion', detail: 'Made and checked 1 change.' },
          { role: 'outcome', outcome: 'partial_success', detail: 42 },
          { role: 'outcome', outcome: 'partial_success', detail: '' },
        ],
      },
    ],
  })
  assert.deepEqual(s.slots[0].transcript, [
    { role: 'outcome', outcome: 'verified_success' },
    { role: 'outcome', outcome: 'unknown', reference: 'tb_prompt' },
    { role: 'outcome', outcome: 'reconciled_later' },
    { role: 'outcome', outcome: 'unknown' },
    { role: 'outcome', outcome: 'unverified_completion', detail: 'Made and checked 1 change.' },
    { role: 'outcome', outcome: 'partial_success' },
    { role: 'outcome', outcome: 'partial_success' },
  ])
})

test('sanitize keeps a valid artifact and drops a malformed one', () => {
  const state = sanitize({
    slotCount: 2,
    slots: [
      { folder: '/tmp/a', artifact: { path: 'dash.html', title: 'Dash' } },
      { folder: '/tmp/b', artifact: { path: 42 } },
    ],
  })
  assert.deepEqual(state.slots[0].artifact, { path: 'dash.html', title: 'Dash' })
  assert.equal(state.slots[1].artifact, null)
})

test('sanitize migrates a legacy artifact into the outputs list', () => {
  const slots = sanitize({
    slotCount: 2,
    slots: [
      { artifact: { path: 'dash.html', title: 'Dash' } },
      { artifact: null },
    ],
  }).slots
  assert.deepEqual(slots[0].outputs, [{
    path: 'dash.html',
    title: 'Dash',
    contentHash: null,
    versionOrdinal: 1,
    demoted: false,
    demotionPending: false,
    updatedAtMs: 0,
    mirrored: false,
  }])
  assert.deepEqual(slots[1].outputs, [])
})

test('sanitize keeps valid outputs, strips unknown keys, and drops malformed siblings', () => {
  const outputs = sanitize({
    slotCount: 1,
    slots: [{
      artifact: null,
      outputs: [
        {
          path: 'new.html', title: 'New', contentHash: VALID_CONTENT_HASH, versionOrdinal: 2,
          demoted: true, updatedAtMs: 20, mirrored: true, evil: 'drop me',
        },
        null,
        { title: 'Missing path' },
        { path: 42, title: 'Bad path' },
        {
          path: 'old.html', title: 42, contentHash: 7, versionOrdinal: Number.POSITIVE_INFINITY,
          demoted: 'yes', updatedAtMs: Number.NaN, mirrored: 'yes',
        },
      ],
    }],
  }).slots[0].outputs
  assert.deepEqual(outputs, [
    {
      path: 'new.html', title: 'New', contentHash: VALID_CONTENT_HASH, versionOrdinal: 2,
      demoted: true, demotionPending: false, updatedAtMs: 20, mirrored: true,
    },
    {
      path: 'old.html', title: 'old.html', contentHash: null, versionOrdinal: 1,
      demoted: false, demotionPending: false, updatedAtMs: 0, mirrored: false,
    },
  ])
})

test('sanitize defaults invalid content hashes to null', () => {
  const invalidHashes = [
    'a'.repeat(64),
    `sha256:${'A'.repeat(64)}`,
    'sha256:abc',
    `sha-256:${'a'.repeat(64)}`,
  ]
  const outputs = invalidHashes.map((contentHash, index) => ({
    path: `${index}.html`,
    title: `${index}`,
    contentHash,
  }))

  const sanitized = sanitize({ slotCount: 1, slots: [{ outputs }] }).slots[0].outputs

  assert.deepEqual(sanitized.map(({ contentHash }) => contentHash), [null, null, null, null])
})

test('sanitize defaults a malformed outputs value instead of migrating the artifact', () => {
  const slot = sanitize({
    slotCount: 1,
    slots: [{ artifact: { path: 'dash.html', title: 'Dash' }, outputs: 'nope' }],
  }).slots[0]
  assert.deepEqual(slot.outputs, [])
})

test('sanitize caps outputs by keeping the newest entries', () => {
  const outputs = Array.from({ length: 201 }, (_, index) => ({
    path: `${index}.html`, title: `${index}`, contentHash: null, versionOrdinal: 1,
    demoted: false, updatedAtMs: index, mirrored: false,
  }))
  const sanitized = sanitize({ slotCount: 1, slots: [{ outputs }] }).slots[0].outputs
  assert.equal(sanitized.length, 200)
  assert.equal(sanitized.some((output) => output.path === '0.html'), false)
  assert.equal(sanitized.some((output) => output.path === '200.html'), true)
})

test('sanitize never keeps more slots than slotCount', () => {
  const s = sanitize({ slotCount: 1, slots: [{ customName: 'a' }, { customName: 'b' }] })
  assert.equal(s.slots.length, 1)
})

test('sanitize keeps a persisted dockVisible flag', () => {
  assert.equal(sanitize({ dockVisible: true }).dockVisible, true)
  assert.equal(sanitize({ dockVisible: 'yes' }).dockVisible, false, 'non-booleans fall back')
})

test('sanitize keeps compact dock presentation preferences', () => {
  const state = sanitize({ dockPinned: true, dockHandlePosition: { x: 712.4, y: 900.6 } })
  assert.equal(state.dockPinned, true)
  assert.deepEqual(state.dockHandlePosition, { x: 712, y: 901 })
  assert.equal(sanitize({ dockPinned: 'yes' }).dockPinned, true, 'non-booleans fall back to the default')
  assert.equal(sanitize({ dockHandlePosition: { x: '712', y: 901 } }).dockHandlePosition, null)
})

test('sanitize keeps finite dock coordinates and rounds subpixels', () => {
  assert.deepEqual(sanitize({ dockPosition: { x: -120.4, y: 640.7 } }).dockPosition, {
    x: -120,
    y: 641,
  })
})

test('sanitize drops malformed dock coordinates', () => {
  assert.equal(sanitize({ dockPosition: { x: Number.POSITIVE_INFINITY, y: 10 } }).dockPosition, null)
  assert.equal(sanitize({ dockPosition: { x: 1e308, y: 10 } }).dockPosition, null)
  assert.equal(sanitize({ dockPosition: { x: -1e308, y: 10 } }).dockPosition, null)
  assert.equal(sanitize({ dockPosition: { x: '10', y: 10 } }).dockPosition, null)
})

test('DockStore round-trips state through disk', () => {
  const file = tmpFile()
  const a = new DockStore(file)
  a.set({
    slotCount: 4,
    slots: [
      {
        customName: 'lore',
        folder: '/x',
        artifact: null,
        outputs: [
          { path: 'one.html', title: 'One', contentHash: VALID_CONTENT_HASH, versionOrdinal: 1, demoted: false, demotionPending: false, updatedAtMs: 10, mirrored: true },
          { path: 'two.html', title: 'Two', contentHash: null, versionOrdinal: 3, demoted: true, demotionPending: true, updatedAtMs: 20, mirrored: false },
        ],
        firstPrompt: null,
        transcript: [{
          role: 'assistant', text: 'Answer [S1]', tools: [], sources: [{
            threadId: 'th_source', blockId: 'tb_source', title: 'Source', summary: 'Excerpt',
            startedAt: '2026-07-30T12:00:00.000Z', matchedBy: 'thread', decisionSummary: null,
          }],
        }],
        agentMessages: [],
        mirrorSessionId: null,
        remoteThreadId: 'th_round_trip',
        pendingSources: [{ relativePath: '.lore/sources/docs/arch.md', title: 'arch.md' }],
      },
    ],
    dockVisible: true,
    dockPosition: { x: 240, y: 360 },
    dockHandlePosition: { x: 710, y: 900 },
    dockPinned: true,
  })
  a.save()

  const b = new DockStore(file)
  assert.equal(b.get().slotCount, 4)
  assert.equal(b.get().slots[0].customName, 'lore')
  assert.equal(b.get().slots[0].remoteThreadId, 'th_round_trip')
  assert.deepEqual(b.get().slots[0].outputs, a.get().slots[0].outputs)
  assert.deepEqual(b.get().slots[0].pendingSources, [{ relativePath: '.lore/sources/docs/arch.md', title: 'arch.md' }])
  assert.deepEqual(b.get().slots[0].transcript[0], a.get().slots[0].transcript[0])
  assert.equal(b.get().dockVisible, true)
  assert.deepEqual(b.get().dockPosition, { x: 240, y: 360 })
  assert.deepEqual(b.get().dockHandlePosition, { x: 710, y: 900 })
  assert.equal(b.get().dockPinned, true)
})

test('DockStore falls back to defaults on a corrupt file', () => {
  const file = tmpFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{ this is not json')
  const s = new DockStore(file)
  assert.equal(s.get().slotCount, 3)
})

test('DockStore.save leaves no .tmp file behind', () => {
  const file = tmpFile()
  const s = new DockStore(file)
  s.set({ slotCount: 5 })
  s.save()
  const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})
