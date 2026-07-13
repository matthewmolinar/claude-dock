/**
 * Persisted dock-widget state (slot count, slot names/folders, visibility),
 * ported from claude-dock `src/shared/store.js`.
 *
 * Lives at `userData/dock-state.json` — namespaced so it can never collide
 * with Lore's own `session.bin` / `window-state.json`.
 */
import fs from 'node:fs'
import path from 'node:path'

import { LAYOUT } from '../../shared/dock'

export interface PersistedSlot {
  customName: string | null
  folder: string | null
}

export interface PersistedDockState {
  slotCount: number
  slots: PersistedSlot[]
  /** Whether the dock strip was visible when the app last ran. */
  dockVisible: boolean
}

export const DEFAULT_STATE: PersistedDockState = {
  slotCount: LAYOUT.initialSlots,
  slots: [],
  dockVisible: false,
}

export function sanitize(raw: unknown): PersistedDockState {
  const state: PersistedDockState = { ...DEFAULT_STATE, slots: [] }
  if (!raw || typeof raw !== 'object') return state
  const input = raw as Record<string, unknown>

  if (Number.isInteger(input.slotCount)) {
    state.slotCount = Math.min(Math.max(input.slotCount as number, 1), 12)
  }

  if (Array.isArray(input.slots)) {
    state.slots = input.slots.slice(0, state.slotCount).map((s: unknown) => {
      const slot = (s ?? {}) as Record<string, unknown>
      return {
        customName: typeof slot.customName === 'string' ? slot.customName : null,
        folder: typeof slot.folder === 'string' ? slot.folder : null,
      }
    })
  }

  if (typeof input.dockVisible === 'boolean') {
    state.dockVisible = input.dockVisible
  }
  return state
}

export class DockStore {
  private file: string
  private state: PersistedDockState
  private timer: NodeJS.Timeout | null = null

  constructor(file: string) {
    this.file = file
    this.state = sanitize(this.read())
  }

  private read(): unknown {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return null
    }
  }

  get(): PersistedDockState {
    return this.state
  }

  set(patch: Partial<PersistedDockState>): void {
    this.state = sanitize({ ...this.state, ...patch })
    this.scheduleSave()
  }

  /** Coalesce bursts of writes; slot renames fire on every keystroke. */
  scheduleSave(delay = 250): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.save(), delay)
    this.timer.unref?.()
  }

  save(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      // Write-then-rename so an interrupted save cannot truncate the real file.
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      fs.renameSync(tmp, this.file)
    } catch {
      // Persistence is a convenience; never let it take down the app.
    }
  }
}
