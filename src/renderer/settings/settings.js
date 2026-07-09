'use strict';

const api = window.settings;

const keyInput = document.getElementById('key');
const saveBtn = document.getElementById('save');
const clearBtn = document.getElementById('clear');
const statusEl = document.getElementById('status');

function setStatus(text, tone = '') {
  statusEl.textContent = text;
  if (tone) statusEl.dataset.tone = tone;
  else delete statusEl.dataset.tone;
}

function syncSave() {
  saveBtn.disabled = keyInput.value.trim().length === 0;
}

keyInput.addEventListener('input', () => {
  syncSave();
  setStatus('');
});

keyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !saveBtn.disabled) save();
});

async function save() {
  const key = keyInput.value.trim();
  saveBtn.disabled = true;
  const res = await api.saveKey(key);
  if (!res.ok) {
    setStatus(res.message || 'Could not save the key.', 'bad');
    syncSave();
    return;
  }
  keyInput.value = '';
  clearBtn.hidden = false;
  setStatus('Key saved. You can start a session.', 'ok');
  syncSave();
}

saveBtn.addEventListener('click', save);

clearBtn.addEventListener('click', async () => {
  await api.clearKey();
  clearBtn.hidden = true;
  setStatus('Key removed.', '');
  syncSave();
});

document.getElementById('getKey').addEventListener('click', () => api.openConsole());
document.getElementById('close').addEventListener('click', () => api.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.close();
});

async function init() {
  const { hasKey } = await api.init();
  clearBtn.hidden = !hasKey;

  if (hasKey) {
    keyInput.placeholder = 'A key is saved — paste a new one to replace it';
    setStatus('A key is saved on this Mac.', 'ok');
  }
  keyInput.focus();
  syncSave();
}

init();
