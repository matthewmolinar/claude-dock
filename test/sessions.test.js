'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getRecentSessionSummary, claudeIndexPath, newestEntry } = require('../src/shared/sessions');

test('claudeIndexPath escapes slashes to dashes', () => {
  const p = claudeIndexPath('/Users/me/home-page-web', '/HOME');
  assert.strictEqual(
    p,
    '/HOME/.claude/projects/-Users-me-home-page-web/sessions-index.json'
  );
});

test('newestEntry picks the highest fileMtime', () => {
  const e = newestEntry({ entries: [
    { summary: 'old', fileMtime: 1 },
    { summary: 'new', fileMtime: 99 },
    { summary: 'mid', fileMtime: 50 },
  ]});
  assert.strictEqual(e.summary, 'new');
});

test('newestEntry returns null for an empty or malformed index', () => {
  assert.strictEqual(newestEntry(null), null);
  assert.strictEqual(newestEntry({}), null);
  assert.strictEqual(newestEntry({ entries: [] }), null);
});

test('getRecentSessionSummary returns null for a missing cwd', () => {
  assert.strictEqual(getRecentSessionSummary(null, 'claude'), null);
  assert.strictEqual(getRecentSessionSummary('', 'claude'), null);
});

test('getRecentSessionSummary returns null for a nonexistent project', () => {
  assert.strictEqual(getRecentSessionSummary('/nonexistent/path/12345', 'claude'), null);
});

test('getRecentSessionSummary prefers summary over firstPrompt', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-sess-'));
  const dir = path.join(home, '.claude', 'projects', '-proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions-index.json'), JSON.stringify({
    entries: [
      { firstPrompt: 'old prompt', summary: 'Old summary', fileMtime: 1 },
      { firstPrompt: 'a very long first prompt here', summary: 'Fix auth', fileMtime: 2 },
    ],
  }));
  assert.strictEqual(getRecentSessionSummary('/proj', 'claude', home), 'Fix auth');
});

test('getRecentSessionSummary falls back to firstPrompt when summary is absent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-sess-'));
  const dir = path.join(home, '.claude', 'projects', '-proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions-index.json'), JSON.stringify({
    entries: [{ firstPrompt: 'just a prompt', fileMtime: 1 }],
  }));
  assert.strictEqual(getRecentSessionSummary('/proj', 'claude', home), 'just a prompt');
});

test('getRecentSessionSummary survives a corrupt index', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-sess-'));
  const dir = path.join(home, '.claude', 'projects', '-proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions-index.json'), 'not json at all');
  assert.strictEqual(getRecentSessionSummary('/proj', 'claude', home), null);
});

test('getRecentSessionSummary returns null for agents with no index', () => {
  assert.strictEqual(getRecentSessionSummary('/proj', 'amp'), null);
});

test('codex reader skips environment_context and finds the first user message', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-codex-'));
  const dir = path.join(home, '.codex', 'sessions', '2026', '07', '08');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's.jsonl'), [
    JSON.stringify({ type: 'user_message', message: '<environment_context>skip me' }),
    JSON.stringify({ type: 'user_message', message: 'real first prompt' }),
  ].join('\n'));
  assert.strictEqual(getRecentSessionSummary('/anything', 'codex', home), 'real first prompt');
});
