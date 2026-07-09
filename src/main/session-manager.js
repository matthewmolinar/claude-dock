'use strict';

const os = require('os');
const { EventEmitter } = require('events');
const pty = require('@lydell/node-pty');

const { getAgent } = require('../shared/agents');
const { generateSlotName } = require('../shared/title');
const { getRecentSessionSummary } = require('../shared/sessions');

// Pause the PTY when this much data is in flight to the renderer. xterm.js
// parses on the main thread, so an unthrottled `yes` would pin the UI.
const HIGH_WATER_MARK = 256 * 1024;
const LOW_WATER_MARK = 64 * 1024;

let nextPtyId = 1;

class SessionManager extends EventEmitter {
  constructor({ store, createTerminalWindow }) {
    super();
    this.store = store;
    this.createTerminalWindow = createTerminalWindow;

    const persisted = store.get();
    this.agentKey = persisted.agent;
    this.slots = [];
    for (let i = 0; i < persisted.slotCount; i++) {
      const saved = persisted.slots[i] || {};
      this.slots.push(this._blankSlot(saved.customName ?? null, saved.cwd ?? null));
    }
    this._summaryCache = new Map();
  }

  _blankSlot(customName = null, cwd = null) {
    return {
      customName,
      cwd,
      title: null,
      pty: null,
      ptyId: null,
      win: null,
      hasNotification: false,
      launching: false,
      ready: false,
      pending: [],
      inFlight: 0,
      paused: false,
    };
  }

  get slotCount() {
    return this.slots.length;
  }

  // ---- persistence -------------------------------------------------------

  persist() {
    this.store.set({
      agent: this.agentKey,
      slotCount: this.slots.length,
      slots: this.slots.map((s) => ({ customName: s.customName, cwd: s.cwd })),
    });
  }

  // ---- derived view ------------------------------------------------------

  _liveWindow(slot) {
    return slot.win && !slot.win.isDestroyed() ? slot.win : null;
  }

  _sessionSummary(slot) {
    if (!slot.cwd) return null;
    const key = `${this.agentKey}:${slot.cwd}`;
    const hit = this._summaryCache.get(key);
    if (hit && Date.now() - hit.at < 5000) return hit.value;
    let value = null;
    try {
      value = getRecentSessionSummary(slot.cwd, this.agentKey);
    } catch {
      value = null;
    }
    this._summaryCache.set(key, { at: Date.now(), value });
    return value;
  }

  slotStatus(slot) {
    const win = this._liveWindow(slot);
    if (win) return win.isMinimized() ? 'minimized' : 'active';
    if (slot.launching) return 'launching';
    return 'empty';
  }

  slotLabel(slot, index) {
    const status = this.slotStatus(slot);
    if (status === 'empty') return slot.customName || 'Empty';
    if (status === 'launching') return slot.customName || 'Opening...';
    return generateSlotName({
      customName: slot.customName,
      title: slot.title,
      cwd: slot.cwd,
      sessionSummary: this._sessionSummary(slot),
      agentKey: this.agentKey,
      index: index + 1,
    });
  }

  snapshot() {
    return {
      agent: this.agentKey,
      slots: this.slots.map((slot, i) => {
        const status = this.slotStatus(slot);
        return {
          index: i,
          label: this.slotLabel(slot, i),
          status,
          hasWindow: Boolean(this._liveWindow(slot)),
          hasNotification: slot.hasNotification,
          cwd: slot.cwd,
        };
      }),
    };
  }

  _changed() {
    this.emit('changed', this.snapshot());
  }

  // ---- slot lifecycle ----------------------------------------------------

  setAgent(agentKey) {
    if (this.agentKey === agentKey) return;
    this.agentKey = getAgent(agentKey).key;
    this.persist();
    this._changed();
  }

  addSlot() {
    if (this.slots.length >= 12) return null;
    this.slots.push(this._blankSlot());
    this.persist();
    this._changed();
    return this.slots.length - 1;
  }

  rename(index, name) {
    const slot = this.slots[index];
    if (!slot) return;
    slot.customName = name && name.trim() ? name.trim() : null;
    this.persist();
    this._changed();
  }

  /** Click on a slot: focus an existing terminal, or launch a new one. */
  activate(index, { cwd } = {}) {
    const slot = this.slots[index];
    if (!slot) return;

    slot.hasNotification = false;

    const win = this._liveWindow(slot);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      this._changed();
      return;
    }

    if (slot.launching) return;
    this.launch(index, cwd || slot.cwd || os.homedir());
  }

  launch(index, cwd) {
    const slot = this.slots[index];
    if (!slot || slot.launching || this._liveWindow(slot)) return;

    const agent = getAgent(this.agentKey);
    slot.launching = true;
    slot.cwd = cwd;
    slot.title = null;
    slot.ready = false;
    slot.pending = [];
    slot.inFlight = 0;
    slot.paused = false;
    this._changed();

    const ptyId = nextPtyId++;
    slot.ptyId = ptyId;

    const shell = process.env.SHELL || '/bin/zsh';
    const env = { ...process.env };
    // Electron injects these; a child shell must not inherit them.
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.TERM_PROGRAM = 'claude-dock';

    let child;
    try {
      // A *login* shell is what puts `claude`/`amp`/`codex` on PATH: an app
      // bundle launched from Finder inherits only a stub PATH, so we let the
      // user's own zprofile/zshrc populate the environment, then type the
      // command in. It also leaves a usable shell behind when the agent exits.
      child = pty.spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env,
      });
    } catch (err) {
      slot.launching = false;
      slot.ptyId = null;
      this.emit('error', err);
      this._changed();
      return;
    }

    slot.pty = child;

    let typedCommand = false;
    child.onData((data) => {
      // Type the agent command once the login shell has drawn its first prompt.
      if (!typedCommand) {
        typedCommand = true;
        setTimeout(() => {
          try {
            child.write(`${agent.command}\r`);
          } catch {
            /* pty already gone */
          }
        }, 60);
      }
      this._onPtyData(slot, data);
    });

    child.onExit(() => {
      slot.pty = null;
      const win = this._liveWindow(slot);
      if (win) win.destroy();
      this._resetSlotRuntime(slot);
      this._changed();
    });

    const win = this.createTerminalWindow({
      ptyId,
      slotIndex: index,
      agentKey: this.agentKey,
      cwd,
    });
    slot.win = win;

    win.on('focus', () => {
      slot.hasNotification = false;
      this._changed();
    });
    win.on('minimize', () => this._changed());
    win.on('restore', () => this._changed());
    win.on('closed', () => {
      slot.win = null;
      this._killPty(slot);
      this._resetSlotRuntime(slot);
      this._changed();
    });

    slot.launching = false;
    this._changed();
  }

  _resetSlotRuntime(slot) {
    slot.pty = null;
    slot.ptyId = null;
    slot.title = null;
    slot.launching = false;
    slot.ready = false;
    slot.pending = [];
    slot.inFlight = 0;
    slot.paused = false;
    slot.hasNotification = false;
  }

  _killPty(slot) {
    if (!slot.pty) return;
    try {
      slot.pty.kill();
    } catch {
      /* already exited */
    }
    slot.pty = null;
  }

  // ---- PTY <-> renderer plumbing -----------------------------------------

  _onPtyData(slot, data) {
    const win = this._liveWindow(slot);

    // Output while the window is not focused means the agent did something
    // while the user was elsewhere. That is exactly the badge condition.
    if (win && !win.isFocused() && !slot.hasNotification) {
      slot.hasNotification = true;
      this._changed();
    }

    if (!slot.ready) {
      slot.pending.push(data);
      return;
    }

    slot.inFlight += data.length;
    if (!slot.paused && slot.inFlight > HIGH_WATER_MARK) {
      slot.paused = true;
      try {
        slot.pty.pause();
      } catch {
        /* noop */
      }
    }
    if (win) win.webContents.send('term:data', data);
  }

  /** Renderer finished writing `bytes` into xterm; release backpressure. */
  ack(ptyId, bytes) {
    const slot = this.slots.find((s) => s.ptyId === ptyId);
    if (!slot) return;
    slot.inFlight = Math.max(0, slot.inFlight - bytes);
    if (slot.paused && slot.inFlight < LOW_WATER_MARK) {
      slot.paused = false;
      try {
        slot.pty.resume();
      } catch {
        /* noop */
      }
    }
  }

  markReady(ptyId) {
    const slot = this.slots.find((s) => s.ptyId === ptyId);
    if (!slot) return;
    slot.ready = true;
    const win = this._liveWindow(slot);
    if (win && slot.pending.length) {
      for (const chunk of slot.pending) win.webContents.send('term:data', chunk);
    }
    slot.pending = [];
  }

  write(ptyId, data) {
    const slot = this.slots.find((s) => s.ptyId === ptyId);
    if (slot && slot.pty) {
      try {
        slot.pty.write(data);
      } catch {
        /* pty gone */
      }
    }
  }

  resize(ptyId, cols, rows) {
    const slot = this.slots.find((s) => s.ptyId === ptyId);
    if (slot && slot.pty && cols > 0 && rows > 0) {
      try {
        slot.pty.resize(cols, rows);
      } catch {
        /* pty gone */
      }
    }
  }

  setTitle(ptyId, title) {
    const slot = this.slots.find((s) => s.ptyId === ptyId);
    if (!slot || slot.title === title) return;
    slot.title = title;
    this._changed();
  }

  slotByPtyId(ptyId) {
    return this.slots.find((s) => s.ptyId === ptyId) || null;
  }

  // ---- bulk actions ------------------------------------------------------

  closeSlot(index) {
    const slot = this.slots[index];
    if (!slot) return false;
    const win = this._liveWindow(slot);
    this._killPty(slot);
    if (win) win.destroy();
    slot.win = null;
    slot.customName = null;
    this._resetSlotRuntime(slot);
    this.persist();
    this._changed();
    return true;
  }

  minimizeSlot(index) {
    const slot = this.slots[index];
    const win = slot && this._liveWindow(slot);
    if (!win || win.isMinimized()) return false;
    win.minimize();
    this._changed();
    return true;
  }

  minimizeAll() {
    let count = 0;
    for (const slot of this.slots) {
      const win = this._liveWindow(slot);
      if (win && !win.isMinimized()) {
        win.minimize();
        count++;
      }
    }
    this._changed();
    return count;
  }

  disposeAll() {
    for (const slot of this.slots) {
      this._killPty(slot);
      const win = this._liveWindow(slot);
      if (win) win.destroy();
    }
  }
}

module.exports = { SessionManager, HIGH_WATER_MARK, LOW_WATER_MARK };
