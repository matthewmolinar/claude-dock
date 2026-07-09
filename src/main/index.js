'use strict';

const path = require('path');
const os = require('os');
const { app, BrowserWindow, ipcMain, globalShortcut, screen, dialog, shell } = require('electron');

const { Store } = require('../shared/store');
const { LAYOUT } = require('../shared/layout');
const { KeyStore } = require('./keystore');
const { SessionManager } = require('./session-manager');
const {
  createDockWindow,
  createSessionWindow,
  createSettingsWindow,
  repositionDock,
} = require('./windows');

// A second instance would fight the first over global hotkeys and the dock.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

let dockWin = null;
let settingsWin = null;
let sessions = null;
let store = null;
let keyStore = null;

function pushState() {
  if (dockWin && !dockWin.isDestroyed()) {
    dockWin.webContents.send('state', sessions.snapshot());
  }
}

function syncDockSize() {
  repositionDock(dockWin, sessions.slotCount);
}

function toggleDock() {
  if (!dockWin || dockWin.isDestroyed()) return;
  if (dockWin.isVisible()) dockWin.hide();
  else dockWin.showInactive();
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = createSettingsWindow();
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

async function chooseFolder() {
  const res = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: os.homedir(),
    title: 'Choose a folder for this session',
    buttonLabel: 'Use this folder',
  });
  return res.canceled ? null : res.filePaths[0];
}

/**
 * Open a slot. A new session starts in the home folder — no picker. `reselect`
 * (shift-click, or the folder button) is the only path that asks.
 */
async function openSlot(index, { reselect = false } = {}) {
  if (!sessions.slots[index]) return;

  if (reselect) {
    const folder = await chooseFolder();
    if (!folder) return;
    sessions.activate(index, { folder });
    return;
  }
  sessions.activate(index);
}

// ---------------------------------------------------------------------------
// IPC — renderers are untrusted by construction (contextIsolation), so every
// handler validates its slot index before touching state.
// ---------------------------------------------------------------------------

function validIndex(i) {
  return Number.isInteger(i) && i >= 0 && i < sessions.slotCount;
}

function registerIpc() {
  // --- dock ---------------------------------------------------------------

  ipcMain.handle('dock:init', () => ({
    layout: LAYOUT,
    state: sessions.snapshot(),
  }));

  ipcMain.on('slot:activate', (_e, index) => {
    if (validIndex(index)) openSlot(index);
  });

  ipcMain.on('slot:activateIn', (_e, index) => {
    if (validIndex(index)) openSlot(index, { reselect: true });
  });

  ipcMain.on('slot:close', (_e, index) => {
    if (validIndex(index)) sessions.closeSlot(index);
  });

  ipcMain.on('slot:minimize', (_e, index) => {
    if (validIndex(index)) sessions.minimizeSlot(index);
  });

  ipcMain.on('slot:rename', (_e, index, name) => {
    if (validIndex(index) && (typeof name === 'string' || name === null)) {
      sessions.rename(index, name);
    }
  });

  // The dock is a non-activating window, so it cannot host a text caret.
  // Flip focusability for the duration of an inline rename, then flip back.
  ipcMain.on('dock:setFocusable', (_e, focusable) => {
    if (!dockWin || dockWin.isDestroyed()) return;
    dockWin.setFocusable(Boolean(focusable));
    if (focusable) dockWin.focus();
  });

  ipcMain.on('dock:addSlot', () => {
    const index = sessions.addSlot();
    if (index === null) return;
    syncDockSize();
    openSlot(index);
  });

  ipcMain.on('dock:minimizeAll', () => sessions.minimizeAll());
  ipcMain.on('dock:openSettings', openSettings);

  // --- session window -----------------------------------------------------

  ipcMain.handle('session:init', (_e, index) =>
    validIndex(index) ? sessions.sessionState(index) : null
  );

  ipcMain.on('session:prompt', (_e, index, text) => {
    if (validIndex(index) && typeof text === 'string') sessions.prompt(index, text);
  });

  ipcMain.on('session:stop', (_e, index) => {
    if (validIndex(index)) sessions.stop(index);
  });

  ipcMain.on('session:openSettings', openSettings);

  ipcMain.on('session:revealFolder', (_e, index) => {
    const slot = validIndex(index) && sessions.slots[index];
    if (slot && slot.folder) shell.openPath(slot.folder);
  });

  // --- settings -----------------------------------------------------------

  ipcMain.handle('settings:init', () => ({ hasKey: keyStore.has() }));

  ipcMain.handle('settings:saveKey', (_e, key) => {
    if (typeof key !== 'string') return { ok: false };
    try {
      keyStore.set(key);
    } catch (err) {
      return { ok: false, message: err.message };
    }
    // A new key must reach sessions that already failed without one.
    for (const slot of sessions.slots) slot.agent = null;
    return { ok: true, hasKey: keyStore.has() };
  });

  ipcMain.handle('settings:clearKey', () => {
    keyStore.clear();
    for (const slot of sessions.slots) slot.agent = null;
    return { ok: true, hasKey: false };
  });

  ipcMain.on('settings:openConsole', () =>
    shell.openExternal('https://console.anthropic.com/settings/keys')
  );

  // --- shared window chrome ----------------------------------------------

  const winFor = (event) => BrowserWindow.fromWebContents(event.sender);
  ipcMain.on('win:minimize', (e) => winFor(e)?.minimize());
  ipcMain.on('win:close', (e) => winFor(e)?.close());
  ipcMain.on('win:zoom', (e) => {
    const w = winFor(e);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
}

function registerHotkeys() {
  const bind = (accel, fn) => {
    if (!globalShortcut.register(accel, fn)) {
      console.warn(`[lore] hotkey already taken: ${accel}`);
    }
  };
  bind('Command+Alt+T', toggleDock);
  bind('Command+Alt+N', () => {
    const index = sessions.addSlot();
    if (index === null) return;
    syncDockSize();
    openSlot(index);
  });
  bind('Command+Alt+M', () => sessions.minimizeAll());
  bind('Command+Alt+R', () => {
    if (dockWin && !dockWin.isDestroyed()) dockWin.reload();
  });
}

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'state.json'));
  keyStore = new KeyStore();
  sessions = new SessionManager({ store, keyStore, createSessionWindow });
  sessions.on('changed', pushState);

  registerIpc();
  dockWin = createDockWindow(sessions.slotCount);
  dockWin.on('closed', () => {
    dockWin = null;
  });
  registerHotkeys();

  screen.on('display-metrics-changed', syncDockSize);
  screen.on('display-added', syncDockSize);
  screen.on('display-removed', syncDockSize);

  // First run with no key: show the user where to put it.
  if (!keyStore.has()) setTimeout(openSettings, 700);

  app.on('activate', () => {
    if (!dockWin || dockWin.isDestroyed()) {
      dockWin = createDockWindow(sessions.slotCount);
    } else {
      dockWin.showInactive();
    }
  });
});

app.on('second-instance', () => {
  if (dockWin && !dockWin.isDestroyed()) dockWin.showInactive();
});

// The dock is the app. Registering any listener here suppresses Electron's
// default quit-on-last-window, so closing every session leaves the dock alive.
app.on('window-all-closed', () => {});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (sessions) sessions.disposeAll();
  if (store) store.save();
});
