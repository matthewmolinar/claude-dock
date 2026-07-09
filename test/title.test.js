'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { truncate, parseAgentInfo, generateSlotName } = require('../src/shared/title');

test('truncate leaves short strings alone', () => {
  assert.strictEqual(truncate('short'), 'short');
});

test('truncate caps at 20 chars including ellipsis', () => {
  const out = truncate('This is a very long chat name that should be cut');
  assert.strictEqual(out.length, 20);
  assert.ok(out.endsWith('...'));
});

test('parseAgentInfo returns null for non-string', () => {
  assert.strictEqual(parseAgentInfo(null), null);
  assert.strictEqual(parseAgentInfo(undefined), null);
});

test('parseAgentInfo extracts chatName and project from "path -- chat"', () => {
  const info = parseAgentInfo('/Users/test/project -- Fix auth bug');
  assert.strictEqual(info.chatName, 'Fix auth bug');
  assert.strictEqual(info.project, 'project');
});

test('parseAgentInfo extracts chatName without a leading path', () => {
  const info = parseAgentInfo('mydir -- Some task name');
  assert.strictEqual(info.chatName, 'Some task name');
  assert.strictEqual(info.project, null);
});

test('parseAgentInfo handles a title with no separator', () => {
  const info = parseAgentInfo('/Users/test/myproject');
  assert.strictEqual(info.chatName, null);
  assert.strictEqual(info.project, 'myproject');
});

test('parseAgentInfo handles em dash and en dash separators', () => {
  assert.strictEqual(parseAgentInfo('/p — Em dashed').chatName, 'Em dashed');
  assert.strictEqual(parseAgentInfo('/p – En dashed').chatName, 'En dashed');
});

test('parseAgentInfo truncates long chat names', () => {
  const info = parseAgentInfo('/path -- This is a very long chat name that should be truncated');
  assert.ok(info.chatName.length <= 20);
  assert.ok(info.chatName.endsWith('...'));
});

test('parseAgentInfo detects the agent from the title', () => {
  assert.strictEqual(parseAgentInfo('Claude Code').agent, 'claude');
  assert.strictEqual(parseAgentInfo('amp session').agent, 'amp');
  assert.strictEqual(parseAgentInfo('codex run').agent, 'codex');
  assert.strictEqual(parseAgentInfo('/plain/path').agent, null);
});

test('a single-dash path is not mistaken for a separator', () => {
  const info = parseAgentInfo('/Users/me/claude-dock');
  assert.strictEqual(info.chatName, null);
  assert.strictEqual(info.project, 'claude-dock');
});

test('generateSlotName prefers the user rename above everything', () => {
  const name = generateSlotName({
    customName: 'My Slot',
    title: '/Users/test/project -- Chat',
    cwd: '/tmp/x',
    index: 1,
  });
  assert.strictEqual(name, 'My Slot');
});

test('generateSlotName prioritizes chatName', () => {
  const name = generateSlotName({ title: '/Users/test/project -- My Chat Name', index: 1 });
  assert.strictEqual(name, 'My Chat Name');
});

test('generateSlotName falls back to the session summary', () => {
  const name = generateSlotName({
    title: '/Users/test/project',
    sessionSummary: 'Port games page to feed',
    index: 1,
  });
  assert.strictEqual(name, 'Port games page to feed'.slice(0, 17) + '...');
});

test('generateSlotName falls back to the project from the title', () => {
  const name = generateSlotName({ title: '/Users/test/myproject', index: 1 });
  assert.strictEqual(name, 'myproject');
});

test('generateSlotName falls back to the cwd basename', () => {
  const name = generateSlotName({ cwd: '/Users/test/lore', index: 1 });
  assert.strictEqual(name, 'lore');
});

test('generateSlotName falls back to "<Agent> <index>"', () => {
  assert.strictEqual(generateSlotName({ agentKey: 'claude', index: 2 }), 'Claude 2');
  assert.strictEqual(generateSlotName({ agentKey: 'codex', index: 3 }), 'Codex 3');
  // Unknown agent keys degrade to Claude, matching getAgent().
  assert.strictEqual(generateSlotName({ agentKey: 'nope', index: 1 }), 'Claude 1');
});
