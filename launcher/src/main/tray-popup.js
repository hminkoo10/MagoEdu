'use strict';

const path = require('node:path');
const { trayMenuAction, trayMenuBounds } = require('./tray-menu-model');

// Electron 객체를 주입해서 실제 앱·사용자 데이터 없이 수명과 IPC를 시험한다.
function createTrayPopup({ BrowserWindow, ipcMain, screen, getItems, activate, fallback, getTrayBounds, log }) {
  let win = null;
  let opened = false;
  let ready = false;
  let anchor = null;
  let revision = 0;
  let modelKey = '';
  let timer = null;
  let trayBlurAt = 0;
  const listeners = [];

  function close() {
    opened = false;
    clearTimeout(timer);
    win?.hide();
  }

  function fail(error) {
    const wasOpen = opened;
    close();
    const failed = win;
    win = null;
    ready = false;
    failed?.destroy();
    log.warn('[트레이] 기본 메뉴로 전환', error?.message || error);
    if (wasOpen) fallback();
  }

  function refresh(force = false) {
    if (!opened || !ready) return;
    try {
      const items = getItems();
      const area = screen.getDisplayNearestPoint(anchor).workArea;
      const key = JSON.stringify([items, area]);
      if (!force && key === modelKey) return;
      modelKey = key;
      win.webContents.send('tray-menu:model', { items, revision: ++revision, resetSelection: force, maxWidth: area.width - 2, maxHeight: area.height - 2 });
    } catch (error) {
      fail(error);
    }
  }

  function on(channel, fn) {
    const listener = (event, ...args) => {
      // 다른 창·iframe에서 온 메시지는 고정 채널이어도 거절한다.
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return;
      try { fn(...args); } catch (error) { fail(error); }
    };
    ipcMain.on(channel, listener);
    listeners.push([channel, listener]);
  }

  on('tray-menu:ready', () => { ready = true; refresh(true); });
  on('tray-menu:close', close);
  on('tray-menu:measure', (value) => {
    if (!opened || !value || value.revision !== revision) return;
    if (![value.width, value.height].every((v) => Number.isFinite(v) && v > 0 && v <= 100000)) return;
    const area = screen.getDisplayNearestPoint(anchor).workArea;
    win.setBounds(trayMenuBounds(anchor, value, area));
    clearTimeout(timer);
    if (!win.isVisible()) { win.show(); win.focus(); }
  });
  on('tray-menu:activate', (id) => {
    if (!opened) return;
    const item = trayMenuAction(getItems(), id);
    if (!item) return;
    close();
    Promise.resolve().then(() => activate(item)).catch((error) => log.warn('[트레이] 실행 실패', error.message));
  });

  function toggle() {
    // Windows는 트레이를 누를 때 blur, 버튼을 놓을 때 right-click을 보낼 수 있다.
    const justBlurredOnTray = Date.now() - trayBlurAt < 1000;
    trayBlurAt = 0;
    if (opened || justBlurredOnTray) { close(); return; }
    opened = true;
    try {
      anchor = screen.getCursorScreenPoint();
      timer = setTimeout(() => fail(new Error('메뉴 응답 시간 초과')), 5000);
      if (!win) {
        win = new BrowserWindow({
          width: 200, height: 100, show: false, frame: false, transparent: true,
          resizable: false, movable: false, minimizable: false, maximizable: false,
          skipTaskbar: true, alwaysOnTop: true, hasShadow: false, roundedCorners: false,
          backgroundColor: '#00000000',
          webPreferences: {
            preload: path.join(__dirname, 'tray-preload.js'),
            contextIsolation: true, sandbox: true, nodeIntegration: false,
            spellcheck: false, devTools: false,
          },
        });
        const popup = win;
        popup.removeMenu();
        popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        popup.webContents.on('will-navigate', (event) => event.preventDefault());
        popup.webContents.on('render-process-gone', (_event, details) => {
          if (win === popup) fail(new Error(details.reason));
        });
        popup.on('blur', () => {
          // 숨김 직후 도착한 이전 blur가 새로 여는 요청을 닫지 않도록 한다.
          if (!opened || !popup.isVisible() || popup.isFocused()) return;
          const p = screen.getCursorScreenPoint();
          const b = getTrayBounds();
          if (b && p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) trayBlurAt = Date.now();
          close();
        });
        popup.on('closed', () => {
          if (win === popup) { win = null; ready = false; opened = false; clearTimeout(timer); }
        });
        popup.loadFile(path.join(__dirname, '..', 'renderer', 'tray-menu.html')).catch((error) => {
          if (win === popup) fail(error);
        });
      } else {
        refresh(true);
      }
    } catch (error) {
      fail(error);
    }
  }

  return {
    toggle, refresh,
    close() { trayBlurAt = 0; close(); },
    destroy() {
      close();
      for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener);
      win?.destroy();
      win = null;
    },
  };
}

module.exports = { createTrayPopup };
