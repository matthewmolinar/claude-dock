'use strict';

const slotsEl = document.getElementById('slots');

const STATUS_TEXT = {
  empty: 'Choose a folder',
  idle: 'Ready',
  active: 'Open',
  working: 'Working…',
  minimized: 'Hidden',
};

// Index of the slot currently being renamed, or null. Renders skip its label so
// we never yank text out from under the caret.
let renamingIndex = null;
let addBtn = null;

function applyLayout(layout) {
  const root = document.documentElement.style;
  root.setProperty('--slot-w', `${layout.slotWidth}px`);
  root.setProperty('--slot-h', `${layout.slotHeight}px`);
  root.setProperty('--gap', `${layout.gap}px`);
  root.setProperty('--margin', `${layout.margin}px`);
  root.setProperty('--header-h', `${layout.headerHeight}px`);
  root.setProperty('--add-w', `${layout.addButtonWidth}px`);
}

function buildSlot(index) {
  const slot = document.createElement('div');
  slot.className = 'slot';
  slot.dataset.index = String(index);

  const controls = document.createElement('div');
  controls.className = 'slot-controls';

  const min = document.createElement('button');
  min.className = 'ctl';
  min.textContent = '–';
  min.title = 'Hide this session';
  min.addEventListener('click', (e) => {
    e.stopPropagation();
    window.dock.minimize(index);
  });

  const close = document.createElement('button');
  close.className = 'ctl';
  close.textContent = '×';
  close.title = 'End this session';
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    window.dock.close(index);
  });

  controls.append(min, close);

  const badge = document.createElement('span');
  badge.className = 'badge';

  const title = document.createElement('div');
  title.className = 'slot-title';

  const sub = document.createElement('div');
  sub.className = 'slot-sub';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const subText = document.createElement('span');
  subText.className = 'sub-text';
  sub.append(dot, subText);

  slot.append(controls, badge, title, sub);

  slot.addEventListener('click', (e) => {
    if (renamingIndex === index) return;
    if (e.altKey) {
      beginRename(index, title);
      return;
    }
    // Shift-click re-picks the folder for an existing session.
    if (e.shiftKey) {
      window.dock.activateIn(index);
      return;
    }
    window.dock.activate(index);
  });

  return slot;
}

function beginRename(index, titleEl) {
  renamingIndex = index;
  const original = titleEl.textContent;

  window.dock.setFocusable(true);
  titleEl.contentEditable = 'plaintext-only';
  titleEl.focus();

  const range = document.createRange();
  range.selectNodeContents(titleEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = (commit) => {
    if (renamingIndex !== index) return;
    renamingIndex = null;
    titleEl.contentEditable = 'false';
    titleEl.removeEventListener('keydown', onKey);
    titleEl.removeEventListener('blur', onBlur);
    window.getSelection().removeAllRanges();
    // Hand focus back to whatever the user was working in.
    window.dock.setFocusable(false);

    const next = titleEl.textContent.trim();
    if (commit && next !== original) window.dock.rename(index, next || null);
    else titleEl.textContent = original;
  };

  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };
  const onBlur = () => finish(true);

  titleEl.addEventListener('keydown', onKey);
  titleEl.addEventListener('blur', onBlur);
}

function ensureSlotCount(n) {
  while (slotsEl.querySelectorAll('.slot').length < n) {
    const index = slotsEl.querySelectorAll('.slot').length;
    slotsEl.insertBefore(buildSlot(index), addBtn);
  }
  const slots = slotsEl.querySelectorAll('.slot');
  for (let i = slots.length - 1; i >= n; i--) slots[i].remove();
}

function render(state) {
  ensureSlotCount(state.slots.length);

  const nodes = slotsEl.querySelectorAll('.slot');
  state.slots.forEach((slot, i) => {
    const node = nodes[i];
    node.dataset.status = slot.status;
    node.dataset.hasWindow = String(slot.hasWindow);
    node.dataset.notify = String(slot.hasNotification);

    const title = node.querySelector('.slot-title');
    if (renamingIndex !== i) {
      title.textContent = slot.status === 'empty' ? 'New session' : slot.label;
    }
    node.title = slot.folder || 'Click to choose a folder';

    node.querySelector('.sub-text').textContent = STATUS_TEXT[slot.status] || '';
  });
}

async function init() {
  const { layout, state } = await window.dock.init();
  applyLayout(layout);

  addBtn = document.createElement('button');
  addBtn.id = 'addBtn';
  addBtn.textContent = '+';
  addBtn.title = '⌘⌥N — new session';
  addBtn.addEventListener('click', () => window.dock.addSlot());
  slotsEl.append(addBtn);

  document.getElementById('minAllBtn').addEventListener('click', () => window.dock.minimizeAll());
  document.getElementById('settingsBtn').addEventListener('click', () => window.dock.openSettings());

  render(state);
  window.dock.onState(render);
}

init();
