'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dock', {
  init: () => ipcRenderer.invoke('dock:init'),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),

  activate: (index) => ipcRenderer.send('slot:activate', index),
  activateIn: (index, cwd) => ipcRenderer.send('slot:activateIn', index, cwd),
  close: (index) => ipcRenderer.send('slot:close', index),
  minimize: (index) => ipcRenderer.send('slot:minimize', index),
  rename: (index, name) => ipcRenderer.send('slot:rename', index, name),

  setFocusable: (focusable) => ipcRenderer.send('dock:setFocusable', focusable),
  addSlot: () => ipcRenderer.send('dock:addSlot'),
  minimizeAll: () => ipcRenderer.send('dock:minimizeAll'),
  setAgent: (agentKey) => ipcRenderer.send('dock:setAgent', agentKey),
  toggleHelp: () => ipcRenderer.send('dock:toggleHelp'),
  chooseFolder: () => ipcRenderer.invoke('dock:chooseFolder'),
});
