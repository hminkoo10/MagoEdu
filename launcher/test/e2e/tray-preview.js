'use strict';

// node_modules/electron/dist/electron.exe test/e2e/tray-preview.js
// 실제 main.js·서버·설치 앱은 부르지 않는다. Chromium 프로필도 매번 임시 폴더만 사용한다.
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { trayMenuItems } = require('../../src/main/tray-menu-model');
const { createTrayPopup } = require('../../src/main/tray-popup');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-tray-preview-'));
app.setName('MagoEduTrayPreview');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const out = path.join(__dirname, '..', 'out', 'tray-preview');
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await fn()) return; await wait(30); }
  throw new Error('메뉴 검증 시간 초과');
}

app.whenReady().then(async () => {
  const actions = [];
  const warnings = [];
  const errors = [];
  let popup;
  try {
    const area = screen.getPrimaryDisplay().workArea;
    const point = { x: area.x + area.width - 20, y: area.y + area.height - 20 };
    let state = {
      phase: 'ready',
      icons: { tajong: `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '../../build/icon.png')).toString('base64')}` },
      apps: [
        { id: 'tajong', name: '마고 타종', installed: true, running: true },
        { id: 'note', name: '오답노트', installed: true, running: false },
      ],
    };
    let visible = true;
    popup = createTrayPopup({
      BrowserWindow, ipcMain,
      screen: { getCursorScreenPoint: () => point, getDisplayNearestPoint: (p) => screen.getDisplayNearestPoint(p) },
      getTrayBounds: () => null,
      getItems: () => trayMenuItems(state, visible),
      activate: (item) => actions.push(item.id),
      fallback: () => errors.push('예상하지 않은 네이티브 폴백'),
      log: { warn: (...args) => warnings.push(args.join(' ')) },
    });
    popup.toggle();
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.on('console-message', (_event, details) => {
      if (details.level === 'error') errors.push(details.message);
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const key = async (value) => {
      const keyCode = { ArrowDown: 'Down', ArrowUp: 'Up' }[value] || value;
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      await wait(50);
    };
    const show = async () => { popup.toggle(); await until(() => win.isVisible()); };
    await until(() => win.isVisible());
    await wait(150);
    assert.equal(await js('typeof require'), 'undefined');
    assert.equal(await js('typeof window.cloud'), 'undefined');
    assert.equal(await js('document.fonts.check("14px Pretendard")'), true);
    const style = await js(`(() => {
      const menu = getComputedStyle(document.getElementById('menu'));
      const item = getComputedStyle(document.querySelector('button'));
      return { border: menu.borderTopWidth, radius: menu.borderRadius, padding: menu.padding, itemPadding: item.padding, itemRadius: item.borderRadius, font: item.fontFamily };
    })()`);
    assert.equal(style.radius, '14px');
    assert.equal(style.padding, '6px');
    assert.equal(style.itemPadding, '9px 12px');
    assert.equal(style.itemRadius, '8px');
    assert.equal(await js('getComputedStyle(document.querySelector(".danger .ic")).color'), 'rgb(240, 68, 82)');
    assert.equal(await js('document.querySelectorAll("img").length'), 1);
    assert.equal(await js('document.querySelector("img").naturalWidth > 0'), true);
    const bounds = win.getBounds();
    fs.writeFileSync(path.join(out, 'geometry.json'), JSON.stringify({ bounds, contentBounds: win.getContentBounds(), area, point, displays: screen.getAllDisplays(), rect: await js('JSON.stringify(document.getElementById("menu").getBoundingClientRect())') }, null, 2));
    assert.ok(bounds.x >= area.x && bounds.y >= area.y);
    assert.ok(bounds.x + bounds.width <= area.x + area.width);
    assert.ok(bounds.y + bounds.height <= area.y + area.height);
    fs.writeFileSync(path.join(out, 'cloud-tray.png'), (await win.webContents.capturePage()).toPNG());
    await key('ArrowDown');
    assert.equal(await js('document.activeElement.dataset.id'), 'open');
    await key('ArrowUp');
    assert.equal(await js('document.activeElement.dataset.id'), 'quit');
    await key('ArrowUp');
    assert.equal(await js('document.activeElement.dataset.id'), 'sync');
    fs.writeFileSync(path.join(out, 'cloud-tray-selected.png'), (await win.webContents.capturePage()).toPNG());
    await key('Enter');
    await until(() => actions.includes('sync') && !win.isVisible());
    await show();
    await js('window.trayMenu.activate("stop:note")');
    assert.equal(win.isVisible(), true);
    state.apps[0].running = false;
    popup.refresh();
    await until(async () => !(await js(`!!document.querySelector('[data-id="stop:tajong"]')`)));
    assert.equal(await js(`document.querySelector('[data-id="launch:tajong"]').textContent`), '마고 타종');
    visible = false; popup.refresh();
    await until(async () => !(await js('!!document.querySelector("[data-id=hide]")')));
    await key('Escape'); assert.equal(win.isVisible(), false);
    await show(); popup.toggle(); assert.equal(win.isVisible(), false);
    await show();
    await js(`document.querySelector('[data-id="launch:tajong"]').click()`);
    await until(() => actions.includes('launch:tajong') && !win.isVisible());
    state = { phase: 'login', apps: [] };
    await show();
    assert.equal(await js('document.querySelectorAll("button").length'), 2);
    assert.ok(win.getBounds().width < bounds.width);
    fs.writeFileSync(path.join(out, 'cloud-tray-login.png'), (await win.webContents.capturePage()).toPNG());
    popup.close();
    // 작은 화면·긴 이름·많은 항목에서도 모든 명령을 스크롤로 접근할 수 있어야 한다.
    state = { phase: 'ready', apps: Array.from({ length: 40 }, (_, i) => ({ id: `app${i}`, name: '긴 프로그램 이름 '.repeat(30), installed: true, running: true })) };
    await show();
    assert.ok(win.getBounds().height <= area.height);
    assert.ok(win.getBounds().width <= area.width);
    await key('End');
    assert.equal(await js('document.activeElement.dataset.id'), 'quit');
    assert.ok(await js('document.getElementById("menu").scrollTop > 0'));
    // 실제 다른 Electron 창으로 포커스를 옮겨 blur 닫힘을 확인한다.
    const other = new BrowserWindow({ width: 100, height: 100, show: false });
    other.show(); other.focus();
    await until(() => !win.isVisible());
    other.destroy();
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true, profile, electron: process.versions.electron, bounds, scaleFactor: screen.getPrimaryDisplay().scaleFactor, style, actions, errors, warnings }, null, 2));
    popup.destroy();
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: false, profile, error: error.stack, errors, warnings }, null, 2));
    popup?.destroy();
    app.exit(1);
  }
});
