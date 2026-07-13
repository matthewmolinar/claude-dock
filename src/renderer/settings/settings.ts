/**
 * Dock settings renderer (Anthropic API key entry), ported from claude-dock
 * `renderer/settings/settings.js`.
 */
import type { SettingsBridge } from '../../shared/dock'

declare global {
  interface Window {
    settings: SettingsBridge
  }
}

const api = window.settings

const keyInput = document.getElementById('key') as HTMLInputElement
const saveBtn = document.getElementById('save') as HTMLButtonElement
const clearBtn = document.getElementById('clear') as HTMLButtonElement
const statusEl = document.getElementById('status') as HTMLElement

function setStatus(text: string, tone = ''): void {
  statusEl.textContent = text
  if (tone) statusEl.dataset.tone = tone
  else delete statusEl.dataset.tone
}

function syncSave(): void {
  saveBtn.disabled = keyInput.value.trim().length === 0
}

keyInput.addEventListener('input', () => {
  syncSave()
  setStatus('')
})

keyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !saveBtn.disabled) void save()
})

async function save(): Promise<void> {
  const key = keyInput.value.trim()
  saveBtn.disabled = true
  const res = await api.saveKey(key)
  if (!res.ok) {
    setStatus(res.message || 'Could not save the key.', 'bad')
    syncSave()
    return
  }
  keyInput.value = ''
  clearBtn.hidden = false
  setStatus('Key saved. You can start a session.', 'ok')
  syncSave()
}

saveBtn.addEventListener('click', () => void save())

clearBtn.addEventListener('click', async () => {
  await api.clearKey()
  clearBtn.hidden = true
  setStatus('Key removed.', '')
  syncSave()
})

document.getElementById('getKey')?.addEventListener('click', () => api.openConsole())
document.getElementById('close')?.addEventListener('click', () => api.close())
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.close()
})

async function init(): Promise<void> {
  const { hasKey } = await api.init()
  clearBtn.hidden = !hasKey

  if (hasKey) {
    keyInput.placeholder = 'A key is saved — paste a new one to replace it'
    setStatus('A key is saved on this Mac.', 'ok')
  }
  keyInput.focus()
  syncSave()
}

void init()
