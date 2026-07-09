'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function arg(name, fallback = '') {
  const prefix = `--cd-${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const slotIndex = Number(arg('slot', '0'));

contextBridge.exposeInMainWorld('session', {
  slotIndex,
  folder: decodeURIComponent(arg('folder', '')),

  init: () => ipcRenderer.invoke('session:init', slotIndex),
  prompt: (text) => ipcRenderer.send('session:prompt', slotIndex, text),
  stop: () => ipcRenderer.send('session:stop', slotIndex),
  openSettings: () => ipcRenderer.send('session:openSettings'),
  revealFolder: () => ipcRenderer.send('session:revealFolder', slotIndex),

  onAssistantStart: (cb) => ipcRenderer.on('session:assistant-start', () => cb()),
  onText: (cb) => ipcRenderer.on('session:text', (_e, delta) => cb(delta)),
  onTool: (cb) => ipcRenderer.on('session:tool', (_e, call) => cb(call)),
  onToolResult: (cb) => ipcRenderer.on('session:tool-result', (_e, r) => cb(r)),
  onEntry: (cb) => ipcRenderer.on('session:entry', (_e, entry) => cb(entry)),
  onDone: (cb) => ipcRenderer.on('session:done', () => cb()),

  minimizeWindow: () => ipcRenderer.send('win:minimize'),
  closeWindow: () => ipcRenderer.send('win:close'),
  zoomWindow: () => ipcRenderer.send('win:zoom'),
});
