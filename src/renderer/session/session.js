'use strict';

const api = window.session;

const thread = document.getElementById('thread');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const folderBtn = document.getElementById('folder');
const titlebar = document.getElementById('titlebar');
const needsKey = document.getElementById('needsKey');

let busy = false;
let bubble = null; // the assistant text node currently being streamed into
let pending = null; // the "Working…" indicator
const chips = new Map(); // tool id -> chip element

// ---- rendering -------------------------------------------------------------

function row(child) {
  const r = document.createElement('div');
  r.className = 'row';
  r.append(child);
  thread.append(r);
  document.body.classList.add('has-messages');
  return r;
}

function atBottom() {
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
}

function scroll(force = false) {
  if (force || atBottom()) thread.scrollTop = thread.scrollHeight;
}

function addMessage(role, text) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  row(el);
  scroll(role === 'user');
  return el;
}

function showPending() {
  if (pending) return;
  pending = document.createElement('div');
  pending.id = 'pending';
  pending.innerHTML = '<span class="spinner"></span>';
  pending.append(document.createTextNode('Working…'));
  row(pending);
  scroll();
}

function clearPending() {
  if (pending && pending.parentElement) pending.parentElement.remove();
  pending = null;
}

function addChip({ id, label }) {
  clearPending();

  const wrap = document.createElement('div');
  wrap.className = 'activity';
  wrap.dataset.open = 'false';

  const chip = document.createElement('button');
  chip.className = 'chip';
  chip.dataset.state = 'running';
  chip.innerHTML = '<span class="spinner"></span>';
  chip.append(document.createTextNode(label));

  const detail = document.createElement('div');
  detail.className = 'chip-detail';
  detail.textContent = '';

  chip.addEventListener('click', () => {
    wrap.dataset.open = wrap.dataset.open === 'true' ? 'false' : 'true';
    scroll();
  });

  wrap.append(chip, detail);
  row(wrap);
  chips.set(id, { wrap, chip, detail });
  scroll();
  // The next assistant text after a tool call belongs in a fresh bubble.
  bubble = null;
}

function resolveChip({ id, ok, output }) {
  const entry = chips.get(id);
  if (!entry) return;
  entry.chip.dataset.state = ok ? 'done' : 'failed';
  entry.detail.textContent = output || '(no output)';
  if (!ok) entry.wrap.dataset.open = 'true';
  scroll();
}

function appendText(delta) {
  clearPending();
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.className = 'msg assistant';
    row(bubble);
  }
  bubble.textContent += delta;
  scroll();
}

// ---- state -----------------------------------------------------------------

function setBusy(next) {
  busy = next;
  input.disabled = next;
  sendBtn.hidden = next;
  stopBtn.hidden = !next;
  if (!next) {
    clearPending();
    bubble = null;
    input.focus();
    syncSend();
  }
}

function syncSend() {
  sendBtn.disabled = busy || input.value.trim().length === 0;
}

function submit() {
  const text = input.value.trim();
  if (!text || busy) return;
  addMessage('user', text);
  input.value = '';
  autosize();
  syncSend();
  setBusy(true);
  showPending();
  api.prompt(text);
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

// ---- wiring ----------------------------------------------------------------

input.addEventListener('input', () => {
  autosize();
  syncSend();
});

input.addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter makes a new line. That is what a chat app does.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});

sendBtn.addEventListener('click', submit);
stopBtn.addEventListener('click', () => api.stop());

document.getElementById('close').addEventListener('click', () => api.closeWindow());
document.getElementById('min').addEventListener('click', () => api.minimizeWindow());
document.getElementById('zoom').addEventListener('click', () => api.zoomWindow());
document.getElementById('openSettings').addEventListener('click', () => api.openSettings());
folderBtn.addEventListener('click', () => api.revealFolder());

thread.addEventListener('scroll', () => {
  titlebar.classList.toggle('scrolled', thread.scrollTop > 4);
});

window.addEventListener('focus', () => {
  document.body.classList.remove('blurred');
  if (!busy) input.focus();
});
window.addEventListener('blur', () => document.body.classList.add('blurred'));
if (!document.hasFocus()) document.body.classList.add('blurred');

api.onAssistantStart(() => {
  bubble = null;
});
api.onText(appendText);
api.onTool(addChip);
api.onToolResult(resolveChip);
api.onEntry((entry) => {
  clearPending();
  if (entry.role === 'user') return; // already rendered optimistically
  addMessage(entry.role, entry.text);
});
api.onDone(() => setBusy(false));
api.onKeyState(({ hasKey }) => {
  needsKey.hidden = hasKey;
});

// ---- boot ------------------------------------------------------------------

function prettyFolder(folder) {
  return folder.replace(/^\/Users\/[^/]+/, '~');
}

async function init() {
  const state = await api.init();
  const folder = (state && state.folder) || api.folder;
  const pretty = prettyFolder(folder);
  folderBtn.textContent = pretty;
  folderBtn.title = `${folder} — click to open in Finder`;
  document.title = `Lore — ${pretty}`;

  // Replay anything that happened before this window was opened or reloaded.
  for (const entry of (state && state.transcript) || []) {
    if (entry.role === 'assistant') {
      for (const tool of entry.tools || []) {
        addChip({ id: tool.id, label: tool.label });
        if (tool.output !== null) resolveChip({ id: tool.id, ok: tool.ok, output: tool.output });
      }
      if (entry.text) {
        bubble = null;
        appendText(entry.text);
      }
    } else {
      addMessage(entry.role, entry.text);
    }
  }
  bubble = null;

  needsKey.hidden = Boolean(state && state.hasKey);
  setBusy(Boolean(state && state.busy));
  if (state && state.busy) showPending();
  scroll(true);
  syncSend();
}

init();
