import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { DockStore, sanitize } from './store'

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lore-dock-store-')), 'dock-state.json')
}

test('sanitize returns defaults for garbage input', () => {
  assert.equal(sanitize('nope').slotCount, 3)
  assert.deepEqual(sanitize(undefined).slots, [])
  assert.equal(sanitize(undefined).dockVisible, false)
})

test('sanitize clamps slotCount to a sane range', () => {
  assert.equal(sanitize({ slotCount: 0 }).slotCount, 1)
  assert.equal(sanitize({ slotCount: 999 }).slotCount, 12)
  assert.equal(sanitize({ slotCount: 1.5 }).slotCount, 3, 'non-integers fall back')
})

test('sanitize strips unknown slot fields and keeps name/folder', () => {
  const s = sanitize({ slotCount: 2, slots: [{ customName: 'a', folder: '/tmp', evil: 1 }] })
  assert.deepEqual(s.slots, [{ customName: 'a', folder: '/tmp' }])
})

test('sanitize never keeps more slots than slotCount', () => {
  const s = sanitize({ slotCount: 1, slots: [{ customName: 'a' }, { customName: 'b' }] })
  assert.equal(s.slots.length, 1)
})

test('sanitize keeps a persisted dockVisible flag', () => {
  assert.equal(sanitize({ dockVisible: true }).dockVisible, true)
  assert.equal(sanitize({ dockVisible: 'yes' }).dockVisible, false, 'non-booleans fall back')
})

test('DockStore round-trips state through disk', () => {
  const file = tmpFile()
  const a = new DockStore(file)
  a.set({ slotCount: 4, slots: [{ customName: 'lore', folder: '/x' }], dockVisible: true })
  a.save()

  const b = new DockStore(file)
  assert.equal(b.get().slotCount, 4)
  assert.equal(b.get().slots[0].customName, 'lore')
  assert.equal(b.get().dockVisible, true)
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
