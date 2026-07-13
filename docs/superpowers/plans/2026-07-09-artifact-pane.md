# Artifact Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sixth harness tool, `show_artifact`, plus a split pane in the session window that renders the HTML/image file the agent built — conversation left, artifact right.

**Architecture:** The tool validates and announces; the SessionManager (which already sees every tool event) owns artifact state, persistence, live-reload, and window resizing; the renderer shows a sandboxed `<iframe>` in an `<aside>` next to the chat column. All decision logic lives in pure `src/shared/` functions so it is unit-testable without Electron.

**Tech Stack:** Electron (plain JS, no bundler), `node:test`, existing hermetic SSE mock for agent tests.

**Spec:** `docs/superpowers/specs/2026-07-09-artifact-pane-design.md`

## Global Constraints

- Work on branch `feat/artifact-pane`; conventional commits (`feat:`/`test:`/`docs:`); commit locally, do NOT push or open a PR until Matt has tested (his standing rule).
- UI copy: plain language, no jargon, no em-dashes, terse.
- Renderers have no Node access; everything crosses the preload contextBridge.
- All tests hermetic: no API key, no network. Run with `npm test`.
- Accepted artifact extensions (exact list): `.html .htm .png .jpg .jpeg .svg .gif`.
- One artifact per session; a new `show_artifact` replaces the old. Chat-first: no empty pane.
- Do not touch `safeStorage`, the `[hidden]` CSS override may not be weakened (extend the CSP, keep `default-src 'none'`).

---

### Task 1: `show_artifact` tool

**Files:**
- Modify: `src/main/harness/tools.js`
- Test: `test/tools.test.js`

**Interfaces:**
- Produces: `showArtifact(root, relative, title) -> string` (throws on invalid input); `executeTool` case `'show_artifact'`; `TOOL_DEFINITIONS` entry named `show_artifact` with `input_schema.properties = { path, title }`, both required; `describeToolCall('show_artifact', {title}) -> 'Showed <title>'`; exported `ARTIFACT_EXTENSIONS` (a `Set` of the extensions above). Later tasks import `ARTIFACT_EXTENSIONS` and rely on these exact names.

- [ ] **Step 1: Write the failing tests** — append to `test/tools.test.js`:

```js
// ---- show_artifact -----------------------------------------------------------

test('show_artifact accepts an existing html file', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'dash.html'), '<h1>hi</h1>');
  const r = await executeTool(root, 'show_artifact', { path: 'dash.html', title: 'Team dashboard' });
  assert.strictEqual(r.ok, true);
  assert.match(r.output, /Team dashboard/);
});

test('show_artifact rejects a disallowed extension', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
  const r = await executeTool(root, 'show_artifact', { path: 'notes.txt', title: 'Notes' });
  assert.strictEqual(r.ok, false);
  assert.match(r.output, /HTML or image/);
});

test('show_artifact rejects a missing file', async () => {
  const root = tmpRoot();
  const r = await executeTool(root, 'show_artifact', { path: 'ghost.html', title: 'Ghost' });
  assert.strictEqual(r.ok, false);
  assert.match(r.output, /not found/i);
});

test('show_artifact rejects a path outside the root', async () => {
  const root = tmpRoot();
  const r = await executeTool(root, 'show_artifact', { path: '../escape.html', title: 'Nope' });
  assert.strictEqual(r.ok, false);
  assert.match(r.output, /escapes the session folder/);
});

test('show_artifact requires a title', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'a.html'), 'x');
  const r = await executeTool(root, 'show_artifact', { path: 'a.html', title: '  ' });
  assert.strictEqual(r.ok, false);
  assert.match(r.output, /title/i);
});

test('describeToolCall labels show_artifact with its title', () => {
  assert.strictEqual(
    describeToolCall('show_artifact', { path: 'dash.html', title: 'Team dashboard' }),
    'Showed Team dashboard'
  );
});
```

- [ ] **Step 2: Run to verify failure** — `npm test`. Expected: the six new tests FAIL (`Unknown tool: show_artifact` / label mismatch); all existing tests still pass.

- [ ] **Step 3: Implement** in `src/main/harness/tools.js`:

After the `runCommand` function add:

```js
const ARTIFACT_EXTENSIONS = new Set(['.html', '.htm', '.png', '.jpg', '.jpeg', '.svg', '.gif']);

function showArtifact(root, relative, title) {
  const file = resolveInRoot(root, relative);
  if (typeof title !== 'string' || !title.trim()) {
    throw new Error('A short title for the artifact is required.');
  }
  const ext = path.extname(file).toLowerCase();
  if (!ARTIFACT_EXTENSIONS.has(ext)) {
    throw new Error(
      `show_artifact only accepts HTML or image files (.html, .htm, .png, .jpg, .jpeg, .svg, .gif); got "${relative}".`
    );
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`File not found: ${relative}. Write the file first, then show it.`);
  }
  return `"${title.trim()}" is now visible to the user in the Artifact pane beside the conversation.`;
}
```

Append to `TOOL_DEFINITIONS`:

```js
  {
    name: 'show_artifact',
    description:
      'Show a finished visual result to the user in the Artifact pane beside the conversation. Call this after writing a self-contained HTML file (or an image) the user asked to see, such as a dashboard, chart, or poster. Call it again after editing the file if the change is worth pointing out; the pane also refreshes automatically when you edit the shown file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path (relative to the session folder) of the HTML or image file to display.' },
        title: { type: 'string', description: 'A short human title for the artifact, e.g. "Team dashboard".' },
      },
      required: ['path', 'title'],
    },
  },
```

In `describeToolCall` add before `default:`:

```js
    case 'show_artifact':
      return `Showed ${input.title || path.basename(input.path || '')}`;
```

In `executeTool` add before `default:`:

```js
      case 'show_artifact':
        return { ok: true, output: showArtifact(root, input.path, input.title) };
```

Add `ARTIFACT_EXTENSIONS` to `module.exports`.

- [ ] **Step 4: Run to verify pass** — `npm test`. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/harness/tools.js test/tools.test.js
git commit -m "feat: add show_artifact harness tool"
```

---

### Task 2: pure artifact-action helper

**Files:**
- Create: `src/shared/artifact.js`
- Test: `test/artifact.test.js`

**Interfaces:**
- Produces: `artifactAction(current, toolName, input, ok) -> {type:'show', path, title} | {type:'reload'} | null`, where `current` is `{path}` or `null` and `path` values are session-relative. Task 5's SessionManager calls exactly this.

- [ ] **Step 1: Write the failing tests** — create `test/artifact.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { artifactAction } = require('../src/shared/artifact');

test('successful show_artifact yields a show action with normalized path', () => {
  const a = artifactAction(null, 'show_artifact', { path: './dash.html', title: 'Dash' }, true);
  assert.deepStrictEqual(a, { type: 'show', path: 'dash.html', title: 'Dash' });
});

test('failed show_artifact yields nothing', () => {
  assert.strictEqual(artifactAction(null, 'show_artifact', { path: 'x.html', title: 'X' }, false), null);
});

test('editing the shown file yields a reload', () => {
  const current = { path: 'dash.html' };
  assert.deepStrictEqual(artifactAction(current, 'edit_file', { path: './dash.html' }, true), { type: 'reload' });
  assert.deepStrictEqual(artifactAction(current, 'write_file', { path: 'dash.html' }, true), { type: 'reload' });
});

test('editing another file, failing, or having no artifact yields nothing', () => {
  const current = { path: 'dash.html' };
  assert.strictEqual(artifactAction(current, 'edit_file', { path: 'other.html' }, true), null);
  assert.strictEqual(artifactAction(current, 'write_file', { path: 'dash.html' }, false), null);
  assert.strictEqual(artifactAction(null, 'edit_file', { path: 'dash.html' }, true), null);
  assert.strictEqual(artifactAction(current, 'read_file', { path: 'dash.html' }, true), null);
});
```

- [ ] **Step 2: Run to verify failure** — `npm test`. Expected: FAIL, cannot find module `../src/shared/artifact`.

- [ ] **Step 3: Implement** — create `src/shared/artifact.js`:

```js
'use strict';

const path = require('path');

/**
 * Decide what a completed tool call means for the session's artifact.
 * Pure: the SessionManager applies the returned action (state, IPC, resize).
 */
function artifactAction(current, toolName, input, ok) {
  if (!ok || !input || typeof input.path !== 'string') return null;
  const p = path.normalize(input.path);

  if (toolName === 'show_artifact') return { type: 'show', path: p, title: input.title };

  if ((toolName === 'write_file' || toolName === 'edit_file') && current && path.normalize(current.path) === p) {
    return { type: 'reload' };
  }
  return null;
}

module.exports = { artifactAction };
```

- [ ] **Step 4: Run to verify pass** — `npm test`. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/artifact.js test/artifact.test.js
git commit -m "feat: add pure artifact-action helper"
```

---

### Task 3: persistence + window-width math

**Files:**
- Modify: `src/shared/store.js` (sanitize the new per-slot `artifact` field)
- Modify: `src/shared/layout.js` (pure width math)
- Test: `test/store.test.js`, `test/layout.test.js`

**Interfaces:**
- Produces: sanitized slots become `{ customName, folder, artifact }` where `artifact` is `{path, title}` or `null`; `expandedSessionWidth(chatWidth, workAreaWidth) -> number` in `layout.js` (chat width + 480, clamped to `workAreaWidth - 40`). Tasks 5–6 rely on both.

- [ ] **Step 1: Write the failing tests.** Append to `test/store.test.js`:

```js
test('sanitize keeps a valid artifact and drops a malformed one', () => {
  const state = sanitize({
    slotCount: 2,
    slots: [
      { folder: '/tmp/a', artifact: { path: 'dash.html', title: 'Dash' } },
      { folder: '/tmp/b', artifact: { path: 42 } },
    ],
  });
  assert.deepStrictEqual(state.slots[0].artifact, { path: 'dash.html', title: 'Dash' });
  assert.strictEqual(state.slots[1].artifact, null);
});
```

Append to `test/layout.test.js`:

```js
const { expandedSessionWidth } = require('../src/shared/layout');

test('expandedSessionWidth adds the pane width', () => {
  assert.strictEqual(expandedSessionWidth(760, 2000), 1240);
});

test('expandedSessionWidth clamps to the work area', () => {
  assert.strictEqual(expandedSessionWidth(760, 1100), 1060);
});
```

(Match each test file's existing import style at its top.)

- [ ] **Step 2: Run to verify failure** — `npm test`. Expected: both new tests FAIL.

- [ ] **Step 3: Implement.** In `src/shared/store.js`, inside `sanitize`'s slot map, extend the returned object:

```js
    state.slots = raw.slots.slice(0, state.slotCount).map((s) => ({
      customName: typeof s?.customName === 'string' ? s.customName : null,
      folder: typeof s?.folder === 'string' ? s.folder : null,
      artifact:
        s?.artifact && typeof s.artifact.path === 'string' && typeof s.artifact.title === 'string'
          ? { path: s.artifact.path, title: s.artifact.title }
          : null,
    }));
```

In `src/shared/layout.js` add and export:

```js
// The artifact pane adds a fixed panel beside the chat column; never grow past
// the display's work area (with a small margin so the window stays grabbable).
const ARTIFACT_PANE_WIDTH = 480;

function expandedSessionWidth(chatWidth, workAreaWidth) {
  return Math.min(chatWidth + ARTIFACT_PANE_WIDTH, workAreaWidth - 40);
}
```

Add `expandedSessionWidth` to the exports.

- [ ] **Step 4: Run to verify pass** — `npm test`. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/store.js src/shared/layout.js test/store.test.js test/layout.test.js
git commit -m "feat: persist per-slot artifact and add pane width math"
```

---

### Task 4: system prompt + agent-loop test

**Files:**
- Modify: `src/main/harness/agent.js:27` (system prompt)
- Test: `test/agent.test.js`

**Interfaces:**
- Consumes: Task 1's `show_artifact` tool. No new exports.

- [ ] **Step 1: Write the failing test.** In `test/agent.test.js`, add a server factory and test (reuses the file's existing `sse`, `messageStart`, `withAgent` helpers):

```js
/** Turn 1: call show_artifact on an existing file. Turn 2: end. */
function showArtifactThenEnd(calls) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push(JSON.parse(body));
      if (calls.length === 1) {
        sse(res, [
          ['message_start', messageStart],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'show_artifact', input: {} } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"dash.html","title":"Team dashboard"}' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }],
          ['message_stop', { type: 'message_stop' }],
        ]);
        return;
      }
      sse(res, [
        ['message_start', messageStart],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here is your dashboard.' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }],
        ['message_stop', { type: 'message_stop' }],
      ]);
    });
  });
}

test('show_artifact round-trips through the tool loop', async () => {
  await withAgent(showArtifactThenEnd, async ({ agent, root, calls }) => {
    fs.writeFileSync(path.join(root, 'dash.html'), '<h1>dash</h1>');

    const tools = [];
    const results = [];
    agent.on('tool', (t) => tools.push(t));
    agent.on('tool_result', (r) => results.push(r));
    await new Promise((resolve, reject) => {
      agent.once('done', resolve);
      agent.once('error', (e) => reject(new Error(e.message)));
      agent.send('show me the dashboard');
    });

    assert.strictEqual(tools[0].label, 'Showed Team dashboard');
    assert.strictEqual(results[0].ok, true);
    assert.match(results[0].output, /Artifact pane/);
    // The second request must carry the tool_result back.
    const toolResult = calls[1].messages.at(-1).content[0];
    assert.strictEqual(toolResult.type, 'tool_result');
    assert.strictEqual(toolResult.is_error, false);
    // The tool is offered to the model.
    assert.ok(calls[0].tools.some((t) => t.name === 'show_artifact'));
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test`. Expected: this test FAILS only if Task 1 is absent; with Task 1 merged it PASSES immediately — that's acceptable, it locks the loop behavior. If it passes, continue.

- [ ] **Step 3: Extend the system prompt.** In `src/main/harness/agent.js`, in `systemPrompt`, insert before the final paragraph ("You have tools…"):

```
When the user asks for something visual — a dashboard, a chart, a poster, a page — build it as a single self-contained HTML file in the folder (all styles and scripts inline, no external links or network requests), then call show_artifact so they can see it beside the conversation. Keep improving the same file when they ask for changes; the pane refreshes automatically.
```

(Plain template-string text, same voice as the surrounding prompt.)

- [ ] **Step 4: Run to verify pass** — `npm test`. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/harness/agent.js test/agent.test.js
git commit -m "feat: teach the agent to build and show artifacts"
```

---

### Task 5: main-process wiring (SessionManager, windows, IPC, preload)

**Files:**
- Modify: `src/main/session-manager.js`
- Modify: `src/main/windows.js`
- Modify: `src/main/index.js` (IPC, ~line 154 area)
- Modify: `src/preload/session.js`

**Interfaces:**
- Consumes: `artifactAction` (Task 2), `resolveInRoot` (tools.js), `expandedSessionWidth` (Task 3), sanitized `artifact` slot field (Task 3).
- Produces IPC: main→renderer `'session:artifact'` with `{ url, title, version }` or `null`; renderer→main `'session:closeArtifact'` `(index)`; `sessionState(index)` gains `artifact: { url, title, version } | null`. Preload exposes `onArtifact(cb)` and `closeArtifact()`. Task 6 consumes exactly these.

No unit test exists for this Electron-bound layer (established pattern); it is covered by `npm start` verification in Task 7. Keep every decision in the pure helpers, which are tested.

- [ ] **Step 1: Window resize helper.** In `src/main/windows.js` import `expandedSessionWidth` from `../shared/layout` and add + export:

```js
/**
 * Widen a session window for the artifact pane, or give the space back.
 * Remembers the chat-only width on the window itself so close restores it.
 */
function resizeForArtifact(win, open) {
  if (!win || win.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const bounds = win.getBounds();

  if (open) {
    if (win.__chatWidth == null) win.__chatWidth = bounds.width;
    const width = expandedSessionWidth(win.__chatWidth, workArea.width);
    win.setBounds({ ...bounds, x: Math.max(workArea.x, bounds.x - (width - bounds.width)), width });
  } else if (win.__chatWidth != null) {
    win.setBounds({ ...bounds, width: win.__chatWidth });
    win.__chatWidth = null;
  }
}
```

- [ ] **Step 2: SessionManager.** In `src/main/session-manager.js`:

Imports:

```js
const { pathToFileURL } = require('url');
const { resolveInRoot } = require('./harness/tools');
const { artifactAction } = require('../shared/artifact');
```

Constructor: accept and store a new `resizeForArtifact` dependency (`this.resizeForArtifact = resizeForArtifact;`). `_blankSlot` gains `artifact: null` and a third parameter so persisted artifacts restore:

```js
  _blankSlot(customName = null, folder = null, artifact = null) {
    return { customName, folder, artifact, firstPrompt: null, agent: null, win: null, transcript: [], busy: false, hasNotification: false };
  }
```

In the constructor loop pass `saved.artifact ?? null`. In `persist()` include `artifact: s.artifact` in the mapped slot. In `activate()`, the re-point-folder branch (`win && folder && folder !== slot.folder`) also does `slot.artifact = null;`.

Add the payload builder and actions:

```js
  /** null when there is no artifact or its file has gone missing. */
  _artifactPayload(slot) {
    if (!slot.artifact) return null;
    try {
      const file = resolveInRoot(slot.folder, slot.artifact.path);
      if (!require('fs').existsSync(file)) return null;
      return { url: pathToFileURL(file).href, title: slot.artifact.title, version: slot.artifact.version || 0 };
    } catch {
      return null;
    }
  }

  closeArtifact(index) {
    const slot = this.slots[index];
    if (!slot || !slot.artifact) return;
    slot.artifact = null;
    this.persist();
    this._pushWindow(slot, 'session:artifact', null);
    const win = this._liveWindow(slot);
    if (win) this.resizeForArtifact(win, false);
  }
```

(`require('fs')` at top of file with the other imports, not inline — shown inline here only for brevity; add `const fs = require('fs');` to the imports.)

In `prompt()`, extend `onToolResult` — after updating the chip entry, apply the artifact decision:

```js
    const onToolResult = ({ id, ok, output }) => {
      const entry = bubble.tools.find((t) => t.id === id);
      if (entry) {
        entry.output = output;
        entry.ok = ok;
      }
      this._pushWindow(slot, 'session:tool-result', { id, ok, output });

      const call = liveCalls.get(id);
      if (call) this._applyArtifactAction(slot, call, ok);
    };
```

with `const liveCalls = new Map();` declared beside `bubble`, populated in `onTool` (`liveCalls.set(call.id, { name: call.name, input: call.input });`), and:

```js
  _applyArtifactAction(slot, call, ok) {
    const action = artifactAction(slot.artifact, call.name, call.input || {}, ok);
    if (!action) return;

    if (action.type === 'show') {
      const opening = !slot.artifact;
      slot.artifact = { path: action.path, title: action.title, version: 1 };
      this.persist();
      const win = this._liveWindow(slot);
      if (win && opening) this.resizeForArtifact(win, true);
    } else {
      slot.artifact.version = (slot.artifact.version || 0) + 1;
    }
    this._pushWindow(slot, 'session:artifact', this._artifactPayload(slot));
  }
```

(`version` is transient reload state; `persist()`/`sanitize` deliberately drop it.)

In `sessionState()` add `artifact: this._artifactPayload(slot),`.

- [ ] **Step 3: IPC + preload.** In `src/main/index.js`: pass `resizeForArtifact` into the `SessionManager` constructor options (import it from `./windows`), and next to the other `session:` handlers add:

```js
  ipcMain.on('session:closeArtifact', (_e, index) => sessions.closeArtifact(index));
```

In `src/preload/session.js` add inside the exposed object:

```js
  closeArtifact: () => ipcRenderer.send('session:closeArtifact', slotIndex),
  onArtifact: (cb) => ipcRenderer.on('session:artifact', (_e, a) => cb(a)),
```

- [ ] **Step 4: Run the suite and a load check** — `npm test` (all PASS), then `node -e "require('./src/main/session-manager')"` — must exit 0. session-manager imports no Electron modules itself, so this catches broken imports/syntax that the unit suite would not.

- [ ] **Step 5: Commit**

```bash
git add src/main/session-manager.js src/main/windows.js src/main/index.js src/preload/session.js
git commit -m "feat: wire artifact state, IPC, and window resize through the main process"
```

---

### Task 6: renderer split pane

**Files:**
- Modify: `src/renderer/session/index.html`
- Modify: `src/renderer/session/session.css`
- Modify: `src/renderer/session/session.js`

**Interfaces:**
- Consumes: `api.onArtifact(cb)` payload `{url, title, version} | null`; `api.closeArtifact()`; `state.artifact` from `api.init()`.

- [ ] **Step 1: Restructure `index.html`.** Update the CSP meta to `content="default-src 'none'; style-src 'self'; script-src 'self'; frame-src file:;"`. Wrap the existing `#titlebar`, `#thread`, `#needsKey`, `#composer` in `<div id="chat">…</div>` (children unchanged), and add as its sibling before the `<script>` tag:

```html
    <aside id="artifactPane" hidden>
      <header id="artifactBar">
        <span id="artifactTitle"></span>
        <button id="artifactClose" aria-label="Close artifact">✕</button>
      </header>
      <iframe
        id="artifactFrame"
        sandbox="allow-scripts"
        title="Artifact preview"
      ></iframe>
      <div id="artifactError" hidden>Couldn't display this file.</div>
    </aside>
```

- [ ] **Step 2: CSS.** In `session.css`, change the `body` rule's `flex-direction: column` to `row`, and move the column behavior onto a new `#chat` rule directly below it:

```css
#chat {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
}
```

Append the pane styles:

```css
/* ---- artifact pane ---- */

#artifactPane {
  flex: 0 1 480px;
  min-width: 280px;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--line);
  background: var(--panel);
}

#artifactBar {
  height: var(--titlebar-h);
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  -webkit-app-region: drag;
  border-bottom: 1px solid var(--line);
  color: var(--ink-soft);
  font-size: 13px;
  user-select: none;
}

#artifactClose {
  -webkit-app-region: no-drag;
  border: 0;
  background: none;
  color: var(--ink-faint);
  font-size: 13px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
}

#artifactClose:hover {
  background: var(--panel-hover);
  color: var(--ink);
}

#artifactFrame {
  flex: 1;
  border: 0;
  background: #fff;
}

#artifactError {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-soft);
}
```

- [ ] **Step 3: Renderer logic.** In `session.js` add element refs and the artifact renderer, and hook init:

```js
const artifactPane = document.getElementById('artifactPane');
const artifactTitle = document.getElementById('artifactTitle');
const artifactFrame = document.getElementById('artifactFrame');
const artifactError = document.getElementById('artifactError');

function renderArtifact(artifact) {
  if (!artifact) {
    artifactPane.hidden = true;
    artifactFrame.removeAttribute('src');
    return;
  }
  artifactPane.hidden = false;
  artifactError.hidden = true;
  artifactFrame.hidden = false;
  artifactTitle.textContent = artifact.title;
  // The version query forces a reload when the agent edits the shown file.
  artifactFrame.src = `${artifact.url}?v=${artifact.version}`;
}

artifactFrame.addEventListener('error', () => {
  artifactFrame.hidden = true;
  artifactError.hidden = false;
});

document.getElementById('artifactClose').addEventListener('click', () => api.closeArtifact());
api.onArtifact(renderArtifact);
```

In `init()`, after the key/busy lines, add `renderArtifact((state && state.artifact) || null);`.

- [ ] **Step 4: Run the suite** — `npm test`. Expected: all PASS (renderer is not unit-covered; real verification is Task 7).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/session/index.html src/renderer/session/session.css src/renderer/session/session.js
git commit -m "feat: render the artifact pane in the session window"
```

---

### Task 7: end-to-end drive + docs

**Files:**
- Modify: `README.md` (tools list + a short Artifacts paragraph in Features/harness sections)
- Modify: `CLAUDE.md` (layout note: shared/artifact.js; gotcha: frame-src CSP + sandboxed iframe)

- [ ] **Step 1: Drive the real UI against the mock server.** Start the app with the SDK pointed at a local mock (same technique as `test/agent.test.js`): script a turn where the model writes `dash.html` then calls `show_artifact`. Verify with your own eyes (or screenshot via the browse tooling): pane opens, window widens without escaping the screen, title reads "Team dashboard", the HTML renders, a later `edit_file` turn reloads it, the ✕ collapses the window, relaunching the app restores the pane, and a session with no artifact shows no pane. If the sandboxed iframe refuses to load `file:` URLs (a known Chromium behavior risk flagged in the spec), fall back to registering a custom privileged protocol in the main process scoped to the session folder — stop and surface this to Matt before building it.

- [ ] **Step 2: Update docs.** README: add `show_artifact` to the harness tools line and one Features bullet: `**Artifacts** — when it builds something visual, it shows the result beside the conversation`. CLAUDE.md: add `src/shared/artifact.js` to Layout and a Gotchas bullet: sandboxed iframe (`allow-scripts`, no `allow-same-origin`) + `frame-src file:` in the session CSP; the `?v=` query is the reload mechanism.

- [ ] **Step 3: Full suite** — `npm test`. Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document the artifact pane"
```

- [ ] **Step 5: Hold for Matt.** Do NOT push or open a PR. Report what was verified and wait for Matt's in-app test (his standing commit-local/push-after-verify rule).
