'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r && r.ok) return r.data;
  const e = new Error(r?.error?.message || '문제가 생겼어요.');
  e.code = r?.error?.code || null;
  e.status = r?.error?.status || null;
  e.extra = r?.error?.extra || null;
  throw e;
}

function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('cloud', {
  getState: () => call('state:get'),
  getReleaseNotes: () => call('releaseNotes:get'),
  onState: (cb) => on('state', cb),
  onToast: (cb) => on('toast', cb),
  onNavigate: (cb) => on('navigate', cb),

  setServer: (url) => call('server:set', url),
  login: (u, p) => call('auth:login', u, p),
  checkCode: (code) => call('auth:checkCode', code),
  signup: (fields) => call('auth:signup', fields),
  logout: () => call('auth:logout'),

  refreshMe: () => call('me:refresh'),
  changePassword: (cur, next, others) => call('me:password', cur, next, others),
  changeUsername: (u, p) => call('me:username', u, p),
  changeName: (n) => call('me:name', n),
  api: (method, path, body) => call('api', method, path, body),

  refreshApps: () => call('apps:refresh'),
  install: (id) => call('apps:install', id),
  uninstall: (id, opts) => call('apps:uninstall', id, opts),
  launch: (id, opts) => call('apps:launch', id, opts),
  stop: (id) => call('apps:stop', id),
  sync: (id) => call('apps:sync', id),
  syncAll: () => call('apps:syncAll'),
  setAutoLaunch: (id, on) => call('apps:autoLaunch', id, on),
  setDesktopShortcut: (id, on) => call('apps:desktopShortcut', id, on),
  legacyDetect: (id) => call('apps:legacyDetect', id),
  legacyImport: (id, lid) => call('apps:legacyImport', id, lid),
  legacyDismiss: (id, lid) => call('apps:legacyDismiss', id, lid),
  dataInfo: (id) => call('apps:dataInfo', id),
  openData: (id, which) => call('apps:openData', id, which),

  refreshNotices: () => call('notices:refresh'),
  noticesSeen: () => call('notices:seen'),
  refreshStorage: () => call('storage:refresh'),
  setConfig: (patch) => call('config:set', patch),
  checkUpdate: () => call('update:check'),
  installUpdate: () => call('update:install'),
  openExternal: (url) => call('shell:openExternal', url),
  copy: (text) => call('clipboard:write', text),
  quit: () => call('app:quit'),
});
