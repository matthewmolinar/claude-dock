'use strict';

const slotsEl = document.getElementById('slots');
const tabsEl = document.getElementById('tabs');

const STATUS_TEXT = {
  empty: 'click to open',
  launching: 'launching',
  active: 'active',
  minimized: '(minimized)',
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
  root.setProperty('--tab-h', `${layout.tabHeight}px`);
  root.setProperty('--add-w', `${layout.addButtonWidth}px`);
}

function renderTabs(agents, selected) {
  tabsEl.replaceChildren();
  for (const agent of agents) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (agent.key === selected ? ' selected' : '');
    btn.style.setProperty('--tab-color', agent.color);
    btn.textContent = agent.name;
    btn.title = `Launch ${agent.name} in new slots`;
    btn.addEventListener('click', () => window.dock.setAgent(agent.key));
    tabsEl.append(btn);
  }
}

function buildSlot(index) {
  const slot = document.createElement('div');
  slot.className = 'slot';
  slot.dataset.index = String(index);

  const controls = document.createElement('div');
  controls.className = 'slot-controls';

  const close = document.createElement('button');
  close.className = 'ctl close';
  close.title = 'Close terminal';
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    window.dock.close(index);
  });

  const min = document.createElement('button');
  min.className = 'ctl min';
  min.title = 'Minimize terminal';
  min.addEventListener('click', (e) => {
    e.stopPropagation();
    window.dock.minimize(index);
  });

  controls.append(close, min);

  const badge = document.createElement('span');
  badge.className = 'badge';

  const title = document.createElement('div');
  title.className = 'slot-title';

  const status = document.createElement('div');
  status.className = 'slot-status';

  slot.append(controls, badge, title, status);

  slot.addEventListener('click', async (e) => {
    if (renamingIndex === index) return;
    if (e.altKey) {
      beginRename(index, title);
      return;
    }
    if (e.shiftKey) {
      const dir = await window.dock.chooseFolder();
      if (dir) window.dock.activateIn(index, dir);
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
  renderTabs(state.agents ?? cachedAgents, state.agent);
  ensureSlotCount(state.slots.length);

  const nodes = slotsEl.querySelectorAll('.slot');
  state.slots.forEach((slot, i) => {
    const node = nodes[i];
    node.dataset.status = slot.status;
    node.dataset.hasWindow = String(slot.hasWindow);
    node.dataset.notify = String(slot.hasNotification);

    const title = node.querySelector('.slot-title');
    if (renamingIndex !== i) title.textContent = slot.label;
    title.title = slot.cwd || slot.label;

    node.querySelector('.slot-status').textContent = STATUS_TEXT[slot.status] || '';
  });
}

let cachedAgents = [];

async function init() {
  const { layout, agents, state } = await window.dock.init();
  cachedAgents = agents;
  applyLayout(layout);

  addBtn = document.createElement('button');
  addBtn.id = 'addBtn';
  addBtn.textContent = '+';
  addBtn.title = '⌘⌥N — new terminal';
  addBtn.addEventListener('click', () => window.dock.addSlot());
  slotsEl.append(addBtn);

  document
    .getElementById('minAllBtn')
    .addEventListener('click', () => window.dock.minimizeAll());
  document
    .getElementById('helpBtn')
    .addEventListener('click', () => window.dock.toggleHelp());

  render({ ...state, agents });
  window.dock.onState((next) => render({ ...next, agents: cachedAgents }));
}

init();
