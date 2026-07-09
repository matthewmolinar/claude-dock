'use strict';

const { contextBridge, ipcRenderer, clipboard, shell } = require('electron');

function arg(name, fallback = '') {
  const prefix = `--cd-${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const ptyId = Number(arg('pty-id', '0'));

contextBridge.exposeInMainWorld('term', {
  ptyId,
  slotIndex: Number(arg('slot', '0')),
  agentKey: arg('agent', 'claude'),
  cwd: decodeURIComponent(arg('cwd', '')),

  ready: () => ipcRenderer.send('term:ready', ptyId),
  input: (data) => ipcRenderer.send('term:input', ptyId, data),
  resize: (cols, rows) => ipcRenderer.send('term:resize', ptyId, cols, rows),
  ack: (bytes) => ipcRenderer.send('term:ack', ptyId, bytes),
  setTitle: (title) => ipcRenderer.send('term:title', ptyId, title),

  onData: (cb) => ipcRenderer.on('term:data', (_e, data) => cb(data)),

  minimizeWindow: () => ipcRenderer.send('win:minimize'),
  closeWindow: () => ipcRenderer.send('win:close'),
  zoomWindow: () => ipcRenderer.send('win:zoom'),

  copy: (text) => clipboard.writeText(text),
  paste: () => clipboard.readText(),
  // Only ever hand http(s) links to the OS browser.
  openExternal: (url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  },
});
