'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveInRoot,
  executeTool,
  describeToolCall,
  truncate,
  MAX_OUTPUT,
} = require('../src/main/harness/tools');

function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'molinar-')));
}

// ---- path confinement (security-critical) ----------------------------------

test('resolveInRoot resolves a plain relative path', () => {
  const root = tmpRoot();
  assert.strictEqual(resolveInRoot(root, 'a/b.txt'), path.join(root, 'a/b.txt'));
});

test('resolveInRoot rejects ..-traversal', () => {
  const root = tmpRoot();
  assert.throws(() => resolveInRoot(root, '../escape.txt'), /escapes the session folder/);
  assert.throws(() => resolveInRoot(root, 'a/../../escape.txt'), /escapes the session folder/);
});

test('resolveInRoot rejects an absolute path outside the root', () => {
  const root = tmpRoot();
  assert.throws(() => resolveInRoot(root, '/etc/passwd'), /escapes the session folder/);
});

test('resolveInRoot allows an absolute path inside the root', () => {
  const root = tmpRoot();
  const inside = path.join(root, 'ok.txt');
  assert.strictEqual(resolveInRoot(root, inside), inside);
});

test('resolveInRoot rejects a symlink that points outside the root', () => {
  const root = tmpRoot();
  const outside = tmpRoot();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => resolveInRoot(root, 'link/secret.txt'), /escapes the session folder/);
});

test('resolveInRoot rejects a not-yet-existing path under an escaping symlink', () => {
  const root = tmpRoot();
  const outside = tmpRoot();
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => resolveInRoot(root, 'link/new-file.txt'), /escapes the session folder/);
});

test('resolveInRoot rejects an empty or non-string path', () => {
  const root = tmpRoot();
  assert.throws(() => resolveInRoot(root, ''), /path is required/);
  assert.throws(() => resolveInRoot(root, null), /path is required/);
});

// ---- truncation -------------------------------------------------------------

test('truncate leaves short output alone', () => {
  assert.strictEqual(truncate('hi'), 'hi');
});

test('truncate caps long output and says how much was dropped', () => {
  const out = truncate('x'.repeat(MAX_OUTPUT + 500));
  assert.ok(out.length < MAX_OUTPUT + 200);
  assert.ok(out.includes('500 more characters omitted'));
});

// ---- tool execution ---------------------------------------------------------

test('write_file then read_file round-trips', async () => {
  const root = tmpRoot();
  const w = await executeTool(root, 'write_file', { path: 'notes.txt', content: 'hello' });
  assert.strictEqual(w.ok, true);
  const r = await executeTool(root, 'read_file', { path: 'notes.txt' });
  assert.deepStrictEqual(r, { ok: true, output: 'hello' });
});

test('list_files shows folders with a trailing slash', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'a.txt'), '');
  const r = await executeTool(root, 'list_files', {});
  assert.strictEqual(r.output, 'a.txt\nsrc/');
});

test('list_files reports an empty folder', async () => {
  const r = await executeTool(tmpRoot(), 'list_files', {});
  assert.strictEqual(r.output, '(empty folder)');
});

test('edit_file replaces a unique snippet', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'f.txt'), 'one two three');
  const r = await executeTool(root, 'edit_file', {
    path: 'f.txt',
    old_text: 'two',
    new_text: 'TWO',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'one TWO three');
});

test('edit_file refuses an ambiguous snippet', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'f.txt'), 'dup dup');
  const r = await executeTool(root, 'edit_file', { path: 'f.txt', old_text: 'dup', new_text: 'x' });
  assert.strictEqual(r.ok, false);
  assert.match(r.output, /more than once/);
});

test('edit_file reports a missing snippet rather than silently doing nothing', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'f.txt'), 'abc');
  const r = await executeTool(root, 'edit_file', { path: 'f.txt', old_text: 'zzz', new_text: 'x' });
  assert.strictEqual(r.ok, false);
  assert.match(r.output, /was not found/);
});

test('edit_file with empty old_text creates the file', async () => {
  const root = tmpRoot();
  const r = await executeTool(root, 'edit_file', {
    path: 'sub/new.txt',
    old_text: '',
    new_text: 'fresh',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.readFileSync(path.join(root, 'sub/new.txt'), 'utf8'), 'fresh');
});

test('a tool error comes back as ok:false, never as a throw', async () => {
  const root = tmpRoot();
  const r = await executeTool(root, 'read_file', { path: '../../etc/passwd' });
  assert.strictEqual(r.ok, false);
  assert.match(r.output, /escapes the session folder/);
});

test('an unknown tool name is reported, not thrown', async () => {
  const r = await executeTool(tmpRoot(), 'launch_missiles', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.output, /Unknown tool/);
});

test('run_command captures stdout and runs inside the root', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'marker.txt'), '');
  const r = await executeTool(root, 'run_command', { command: 'ls' });
  assert.strictEqual(r.ok, true);
  assert.match(r.output, /marker\.txt/);
});

test('run_command reports a failing command without throwing', async () => {
  const r = await executeTool(tmpRoot(), 'run_command', { command: 'exit 3' });
  assert.strictEqual(r.ok, false);
});

// ---- activity labels --------------------------------------------------------

test('describeToolCall produces human labels, never jargon', () => {
  assert.strictEqual(describeToolCall('read_file', { path: 'src/a.js' }), 'Read a.js');
  assert.strictEqual(describeToolCall('write_file', { path: 'x/b.txt' }), 'Wrote b.txt');
  assert.strictEqual(describeToolCall('edit_file', { path: 'c.js', old_text: 'a' }), 'Edited c.js');
  assert.strictEqual(describeToolCall('edit_file', { path: 'c.js', old_text: '' }), 'Created c.js');
  assert.strictEqual(describeToolCall('run_command', { command: 'ls' }), 'Ran a command');
  assert.strictEqual(describeToolCall('list_files', {}), 'Looked in the folder');
  assert.strictEqual(describeToolCall('list_files', { path: 'src' }), 'Looked in src');
});
