'use strict';

const path = require('path');
const os = require('os');
const { app, BrowserWindow, ipcMain, globalShortcut, screen, dialog } = require('electron');

const { Store } = require('../shared/store');
const { LAYOUT } = require('../shared/layout');
const { AGENT_ORDER, AGENTS } = require('../shared/agents');
const { SessionManager } = require('./session-manager');
const {
  createDockWindow,
  createTerminalWindow,
  createHelpWindow,
  repositionDock,
} = require('./windows');

// A second instance would fight the first over global hotkeys and the dock.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

let dockWin = null;
let helpWin = null;
let sessions = null;
let store = null;

function toggleHelp() {
  if (helpWin && !helpWin.isDestroyed()) {
    helpWin.close();
    return;
  }
  helpWin = createHelpWindow();
  helpWin.on('closed', () => {
    helpWin = null;
  });
}

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

// ---------------------------------------------------------------------------
// IPC — the dock renderer is untrusted-by-construction (contextIsolation), so
// every handler validates its slot index before touching state.
// ---------------------------------------------------------------------------

function validIndex(i) {
  return Number.isInteger(i) && i >= 0 && i < sessions.slotCount;
}

function registerIpc() {
  ipcMain.handle('dock:init', () => ({
    layout: LAYOUT,
    agents: AGENT_ORDER.map((k) => AGENTS[k]),
    state: sessions.snapshot(),
  }));

  ipcMain.on('slot:activate', (_e, index) => {
    if (validIndex(index)) sessions.activate(index);
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
    sessions.activate(index);
  });

  ipcMain.on('dock:minimizeAll', () => sessions.minimizeAll());

  ipcMain.on('dock:toggleHelp', toggleHelp);

  ipcMain.on('dock:setAgent', (_e, agentKey) => {
    if (typeof agentKey === 'string' && AGENTS[agentKey]) sessions.setAgent(agentKey);
  });

  ipcMain.handle('dock:chooseFolder', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: os.homedir(),
      title: 'Open agent session in folder',
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.on('slot:activateIn', (_e, index, cwd) => {
    if (validIndex(index) && typeof cwd === 'string') sessions.activate(index, { cwd });
  });

  // --- terminal renderer ---------------------------------------------------

  ipcMain.on('term:ready', (_e, ptyId) => sessions.markReady(ptyId));
  ipcMain.on('term:input', (_e, ptyId, data) => sessions.write(ptyId, data));
  ipcMain.on('term:resize', (_e, ptyId, cols, rows) => sessions.resize(ptyId, cols, rows));
  ipcMain.on('term:ack', (_e, ptyId, bytes) => sessions.ack(ptyId, bytes));
  ipcMain.on('term:title', (_e, ptyId, title) => {
    if (typeof title === 'string') sessions.setTitle(ptyId, title.slice(0, 200));
  });

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
      console.warn(`[claude-dock] hotkey already taken: ${accel}`);
    }
  };
  bind('Command+Alt+T', toggleDock);
  bind('Command+Alt+N', () => {
    const index = sessions.addSlot();
    if (index === null) return;
    syncDockSize();
    sessions.activate(index);
  });
  bind('Command+Alt+M', () => sessions.minimizeAll());
  bind('Command+Alt+R', () => {
    if (dockWin && !dockWin.isDestroyed()) dockWin.reload();
  });
}

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'state.json'));
  sessions = new SessionManager({ store, createTerminalWindow });
  sessions.on('changed', pushState);
  sessions.on('error', (err) => {
    dialog.showErrorBox('Claude Dock', `Failed to start a terminal:\n\n${err.message}`);
  });

  registerIpc();
  dockWin = createDockWindow(sessions.slotCount);
  dockWin.on('closed', () => {
    dockWin = null;
  });
  registerHotkeys();

  screen.on('display-metrics-changed', syncDockSize);
  screen.on('display-added', syncDockSize);
  screen.on('display-removed', syncDockSize);

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
// default quit-on-last-window, so closing every terminal leaves the dock alive.
app.on('window-all-closed', () => {});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (sessions) sessions.disposeAll();
  if (store) store.save();
});
