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
    // Non-activating: clicking the dock must not steal focus from the terminal
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

function createTerminalWindow({ ptyId, slotIndex, agentKey, cwd }) {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(900, workArea.width - 80);
  const height = Math.min(600, workArea.height - 160);

  // Stagger new windows so a fresh one never lands exactly on the last.
  const offset = (cascade++ % 6) * 28;

  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2) + offset,
    y: Math.round(workArea.y + 60) + offset,
    minWidth: 380,
    minHeight: 240,
    frame: false,
    roundedCorners: true,
    backgroundColor: '#0d0d0d',
    show: false,
    title: 'Claude Dock',
    webPreferences: {
      preload: path.join(PRELOAD, 'terminal.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [
        `--cd-pty-id=${ptyId}`,
        `--cd-slot=${slotIndex}`,
        `--cd-agent=${agentKey}`,
        `--cd-cwd=${encodeURIComponent(cwd)}`,
      ],
    },
  });

  win.loadFile(path.join(RENDERER, 'terminal', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  return win;
}

function createHelpWindow() {
  const win = new BrowserWindow({
    width: 300,
    height: 300,
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    center: true,
    show: false,
    webPreferences: {
      preload: path.join(PRELOAD, 'help.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'modal-panel');
  win.loadFile(path.join(RENDERER, 'help', 'index.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}

module.exports = {
  createDockWindow,
  createTerminalWindow,
  createHelpWindow,
  repositionDock,
  dockFrameFor,
};
