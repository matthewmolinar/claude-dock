'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settings', {
  init: () => ipcRenderer.invoke('settings:init'),
  saveKey: (key) => ipcRenderer.invoke('settings:saveKey', key),
  clearKey: () => ipcRenderer.invoke('settings:clearKey'),
  openConsole: () => ipcRenderer.send('settings:openConsole'),
  close: () => ipcRenderer.send('win:close'),
});
