'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { computeDockFrame } = require('../shared/layout');

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload');

function dockFrameFor(slotCount) {
  // workArea already excludes the menu bar and the system Dock on whichever
  // edge it lives, so we never need to move the user's Dock out of the way.
  return computeDockFrame(screen.getPrimaryDisplay().workArea, slotCount);
}

function createDockWindow(slotCount) {
  const frame = dockFrameFor(slotCount);

  const win = new BrowserWindow({
    ...frame,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Non-activating: clicking the dock must not steal focus from the session
    // you are about to act on. Temporarily flipped true while renaming a slot.
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(PRELOAD, 'dock.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(RENDERER, 'dock', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());

  return win;
}

function repositionDock(win, slotCount) {
  if (!win || win.isDestroyed()) return;
  win.setBounds(dockFrameFor(slotCount));
}

let cascade = 0;

function createSessionWindow({ slotIndex, folder }) {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(760, workArea.width - 80);
  const height = Math.min(680, workArea.height - 140);

  // Stagger new windows so a fresh one never lands exactly on the last.
  const offset = (cascade++ % 6) * 28;

  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2) + offset,
    y: Math.round(workArea.y + 50) + offset,
    minWidth: 420,
    minHeight: 380,
    frame: false,
    roundedCorners: true,
    backgroundColor: '#1a1917',
    show: false,
    title: 'Lore',
    webPreferences: {
      preload: path.join(PRELOAD, 'session.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [
        `--cd-slot=${slotIndex}`,
        `--cd-folder=${encodeURIComponent(folder)}`,
      ],
    },
  });

  win.loadFile(path.join(RENDERER, 'session', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  return win;
}

function createSettingsWindow() {
  const win = new BrowserWindow({
    width: 440,
    height: 330,
    frame: false,
    roundedCorners: true,
    backgroundColor: '#1a1917',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    center: true,
    show: false,
    webPreferences: {
      preload: path.join(PRELOAD, 'settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'modal-panel');
  win.loadFile(path.join(RENDERER, 'settings', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  return win;
}

module.exports = {
  createDockWindow,
  createSessionWindow,
  createSettingsWindow,
  repositionDock,
  dockFrameFor,
};
