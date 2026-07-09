'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('help', {
  close: () => ipcRenderer.send('win:close'),
});
