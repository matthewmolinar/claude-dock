'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, sanitize } = require('../src/shared/store');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-store-')), 'state.json');
}

test('sanitize returns defaults for garbage input', () => {
  assert.strictEqual(sanitize(null).agent, 'claude');
  assert.strictEqual(sanitize('nope').slotCount, 3);
  assert.deepStrictEqual(sanitize(undefined).slots, []);
});

test('sanitize rejects an unknown agent', () => {
  assert.strictEqual(sanitize({ agent: 'skynet' }).agent, 'claude');
  assert.strictEqual(sanitize({ agent: 'codex' }).agent, 'codex');
});

test('sanitize clamps slotCount to a sane range', () => {
  assert.strictEqual(sanitize({ slotCount: 0 }).slotCount, 1);
  assert.strictEqual(sanitize({ slotCount: 999 }).slotCount, 12);
  assert.strictEqual(sanitize({ slotCount: 1.5 }).slotCount, 3, 'non-integers fall back');
});

test('sanitize strips unknown slot fields and keeps name/cwd', () => {
  const s = sanitize({ slotCount: 2, slots: [{ customName: 'a', cwd: '/tmp', evil: 1 }] });
  assert.deepStrictEqual(s.slots, [{ customName: 'a', cwd: '/tmp' }]);
});

test('sanitize never keeps more slots than slotCount', () => {
  const s = sanitize({ slotCount: 1, slots: [{ customName: 'a' }, { customName: 'b' }] });
  assert.strictEqual(s.slots.length, 1);
});

test('Store round-trips state through disk', () => {
  const file = tmpFile();
  const a = new Store(file);
  a.set({ agent: 'amp', slotCount: 4, slots: [{ customName: 'lore', cwd: '/x' }] });
  a.save();

  const b = new Store(file);
  assert.strictEqual(b.get().agent, 'amp');
  assert.strictEqual(b.get().slotCount, 4);
  assert.strictEqual(b.get().slots[0].customName, 'lore');
});

test('Store falls back to defaults on a corrupt file', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  const s = new Store(file);
  assert.strictEqual(s.get().agent, 'claude');
  assert.strictEqual(s.get().slotCount, 3);
});

test('Store.save leaves no .tmp file behind', () => {
  const file = tmpFile();
  const s = new Store(file);
  s.set({ agent: 'codex' });
  s.save();
  const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, []);
});
