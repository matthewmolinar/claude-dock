'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_AGENT, AGENTS } = require('./agents');
const { LAYOUT } = require('./layout');

const DEFAULT_STATE = {
  agent: DEFAULT_AGENT,
  slotCount: LAYOUT.initialSlots,
  slots: [],
};

function sanitize(raw) {
  const state = { ...DEFAULT_STATE };
  if (!raw || typeof raw !== 'object') return state;

  if (typeof raw.agent === 'string' && AGENTS[raw.agent]) state.agent = raw.agent;

  if (Number.isInteger(raw.slotCount)) {
    state.slotCount = Math.min(Math.max(raw.slotCount, 1), 12);
  }

  if (Array.isArray(raw.slots)) {
    state.slots = raw.slots.slice(0, state.slotCount).map((s) => ({
      customName: typeof s?.customName === 'string' ? s.customName : null,
      cwd: typeof s?.cwd === 'string' ? s.cwd : null,
    }));
  }
  return state;
}

class Store {
  constructor(file) {
    this.file = file;
    this.state = sanitize(this._read());
    this._timer = null;
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  get() {
    return this.state;
  }

  set(patch) {
    this.state = sanitize({ ...this.state, ...patch });
    this.scheduleSave();
  }

  /** Coalesce bursts of writes; slot renames fire on every keystroke. */
  scheduleSave(delay = 250) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.save(), delay);
    if (this._timer.unref) this._timer.unref();
  }

  save() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Write-then-rename so an interrupted save cannot truncate the real file.
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.file);
    } catch {
      // Persistence is a convenience; never let it take down the app.
    }
  }
}

module.exports = { Store, sanitize, DEFAULT_STATE };
