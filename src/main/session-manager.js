'use strict';

const path = require('path');
const { EventEmitter } = require('events');

const { Agent } = require('./harness/agent');
const { slotLabel } = require('../shared/title');

class SessionManager extends EventEmitter {
  constructor({ store, keyStore, createSessionWindow }) {
    super();
    this.store = store;
    this.keyStore = keyStore;
    this.createSessionWindow = createSessionWindow;

    const persisted = store.get();
    this.slots = [];
    for (let i = 0; i < persisted.slotCount; i++) {
      const saved = persisted.slots[i] || {};
      this.slots.push(this._blankSlot(saved.customName ?? null, saved.folder ?? null));
    }
  }

  _blankSlot(customName = null, folder = null) {
    return {
      customName,
      folder,
      firstPrompt: null,
      agent: null,
      win: null,
      // Everything the session window needs to re-render after a reload.
      transcript: [],
      busy: false,
      hasNotification: false,
    };
  }

  get slotCount() {
    return this.slots.length;
  }

  persist() {
    this.store.set({
      slotCount: this.slots.length,
      slots: this.slots.map((s) => ({ customName: s.customName, folder: s.folder })),
    });
  }

  // ---- derived view ------------------------------------------------------

  _liveWindow(slot) {
    return slot.win && !slot.win.isDestroyed() ? slot.win : null;
  }

  slotStatus(slot) {
    const win = this._liveWindow(slot);
    if (!win) return slot.folder ? 'idle' : 'empty';
    if (slot.busy) return 'working';
    return win.isMinimized() ? 'minimized' : 'active';
  }

  snapshot() {
    return {
      slots: this.slots.map((slot, i) => ({
        index: i,
        label: slotLabel({
          customName: slot.customName,
          firstPrompt: slot.firstPrompt,
          folder: slot.folder,
          index: i + 1,
        }),
        status: this.slotStatus(slot),
        hasWindow: Boolean(this._liveWindow(slot)),
        hasNotification: slot.hasNotification,
        folder: slot.folder,
      })),
    };
  }

  _changed() {
    this.emit('changed', this.snapshot());
  }

  _pushWindow(slot, channel, payload) {
    const win = this._liveWindow(slot);
    if (win) win.webContents.send(channel, payload);
  }

  // ---- slot lifecycle ----------------------------------------------------

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

  /** Focus an existing window, or open one for this slot. */
  activate(index, { folder } = {}) {
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

    if (folder) slot.folder = folder;
    if (!slot.folder) return; // caller must pick a folder first

    slot.win = this.createSessionWindow({ slotIndex: index, folder: slot.folder });
    this._wireWindow(index, slot);
    this.persist();
    this._changed();
  }

  _wireWindow(index, slot) {
    const win = slot.win;
    win.on('focus', () => {
      slot.hasNotification = false;
      this._changed();
    });
    win.on('minimize', () => this._changed());
    win.on('restore', () => this._changed());
    win.on('closed', () => {
      slot.win = null;
      if (slot.agent) slot.agent.abort();
      slot.busy = false;
      this._changed();
    });
  }

  /** Everything the session renderer needs on load, including past messages. */
  sessionState(index) {
    const slot = this.slots[index];
    if (!slot) return null;
    return {
      index,
      folder: slot.folder,
      busy: slot.busy,
      transcript: slot.transcript,
      hasKey: this.keyStore.has(),
    };
  }

  // ---- the agent ---------------------------------------------------------

  _ensureAgent(slot) {
    if (slot.agent) return slot.agent;

    const apiKey = this.keyStore.get();
    if (!apiKey) throw new Error('NO_API_KEY');

    slot.agent = new Agent({
      apiKey,
      root: slot.folder,
      folderName: path.basename(slot.folder),
    });
    return slot.agent;
  }

  async prompt(index, text) {
    const slot = this.slots[index];
    if (!slot || slot.busy || !text.trim()) return;

    let agent;
    try {
      agent = this._ensureAgent(slot);
    } catch (err) {
      const message =
        err.message === 'NO_API_KEY'
          ? 'Add your Anthropic API key in Settings to get started.'
          : err.message;
      this._appendTranscript(slot, { role: 'error', text: message });
      return;
    }

    if (!slot.firstPrompt) {
      slot.firstPrompt = text;
      this.persist();
    }

    slot.busy = true;
    this._appendTranscript(slot, { role: 'user', text });
    this._changed();

    // One assistant bubble per turn; deltas append into it.
    const bubble = { role: 'assistant', text: '', tools: [] };
    slot.transcript.push(bubble);
    this._pushWindow(slot, 'session:assistant-start', {});

    const onText = (delta) => {
      bubble.text += delta;
      this._pushWindow(slot, 'session:text', delta);
    };
    const onTool = (call) => {
      bubble.tools.push({ id: call.id, label: call.label, input: call.input, output: null });
      this._pushWindow(slot, 'session:tool', { id: call.id, label: call.label });
    };
    const onToolResult = ({ id, ok, output }) => {
      const entry = bubble.tools.find((t) => t.id === id);
      if (entry) {
        entry.output = output;
        entry.ok = ok;
      }
      this._pushWindow(slot, 'session:tool-result', { id, ok, output });
    };

    agent.on('text', onText);
    agent.on('tool', onTool);
    agent.on('tool_result', onToolResult);

    const finish = () => {
      agent.off('text', onText);
      agent.off('tool', onTool);
      agent.off('tool_result', onToolResult);
      slot.busy = false;
      this._notifyIfAway(slot);
      this._pushWindow(slot, 'session:done', {});
      this._changed();
    };

    agent.once('error', ({ message }) => {
      this._appendTranscript(slot, { role: 'error', text: message });
      finish();
    });
    agent.once('done', finish);

    await agent.send(text);
  }

  stop(index) {
    const slot = this.slots[index];
    if (slot && slot.agent) slot.agent.abort();
  }

  _appendTranscript(slot, entry) {
    slot.transcript.push(entry);
    this._pushWindow(slot, 'session:entry', entry);
  }

  /** The agent finished while the user was looking elsewhere: badge the slot. */
  _notifyIfAway(slot) {
    const win = this._liveWindow(slot);
    if (win && !win.isFocused()) slot.hasNotification = true;
  }

  // ---- bulk actions ------------------------------------------------------

  closeSlot(index) {
    const slot = this.slots[index];
    if (!slot) return false;
    const win = this._liveWindow(slot);
    if (slot.agent) slot.agent.abort();
    if (win) win.destroy();
    this.slots[index] = this._blankSlot();
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
      if (slot.agent) slot.agent.abort();
      const win = this._liveWindow(slot);
      if (win) win.destroy();
    }
  }
}

module.exports = { SessionManager };
