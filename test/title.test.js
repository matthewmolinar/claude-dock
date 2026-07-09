'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { truncate, slotLabel, prettyFolder } = require('../src/shared/title');

test('truncate leaves short strings alone', () => {
  assert.strictEqual(truncate('short'), 'short');
});

test('truncate caps at 22 chars including the ellipsis', () => {
  const out = truncate('This is a very long thing the user asked for');
  assert.strictEqual(out.length, 22);
  assert.ok(out.endsWith('…'));
});

test('truncate collapses newlines and runs of whitespace', () => {
  assert.strictEqual(truncate('fix\n\n  the   bug'), 'fix the bug');
});

test('slotLabel prefers the user rename above everything', () => {
  const label = slotLabel({ customName: 'Taxes', firstPrompt: 'do my taxes', folder: '/x', index: 1 });
  assert.strictEqual(label, 'Taxes');
});

test('slotLabel falls back to what they first asked for', () => {
  assert.strictEqual(slotLabel({ firstPrompt: 'fix the login bug', index: 1 }), 'fix the login bug');
});

test('slotLabel truncates a long first prompt', () => {
  const label = slotLabel({ firstPrompt: 'please rewrite the entire onboarding flow', index: 1 });
  assert.strictEqual(label.length, 22);
  assert.ok(label.endsWith('…'));
});

test('slotLabel falls back to the folder name', () => {
  assert.strictEqual(slotLabel({ folder: '/Users/me/lore', index: 1 }), 'lore');
});

test('slotLabel falls back to "Session N"', () => {
  assert.strictEqual(slotLabel({ index: 2 }), 'Session 2');
});

test('prettyFolder abbreviates the home directory', () => {
  assert.strictEqual(prettyFolder('/Users/molinar/lore', '/Users/molinar'), '~/lore');
  assert.strictEqual(prettyFolder('/opt/thing', '/Users/molinar'), '/opt/thing');
  assert.strictEqual(prettyFolder('', '/Users/molinar'), '');
});
