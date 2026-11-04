'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 트레이 전용: 일반 창의 API나 임의 IPC 채널을 노출하지 않는다.
contextBridge.exposeInMainWorld('trayMenu', {
  ready: () => ipcRenderer.send('tray-menu:ready'),
  measure: (revision, width, height) => ipcRenderer.send('tray-menu:measure', { revision, width, height }),
  activate: (id) => ipcRenderer.send('tray-menu:activate', id),
  close: () => ipcRenderer.send('tray-menu:close'),
  onModel: (fn) => ipcRenderer.on('tray-menu:model', (_event, model) => fn(model)),
});
