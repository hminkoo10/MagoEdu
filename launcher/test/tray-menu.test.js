'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { trayMenuItems, trayMenuAction, trayMenuBounds } = require('../src/main/tray-menu-model');
const { createTrayPopup } = require('../src/main/tray-popup');

const state = () => ({ phase: 'ready', apps: [
  { id: 'tajong', name: '마고 타종', installed: { version: '1' }, running: true },
  { id: 'note', name: '오답노트', installed: { version: '1' }, running: false },
  { id: 'other', name: '미설치', installed: null, running: false },
] });
const ids = (items) => items.filter((item) => item.id).map((item) => item.id);

test('트레이 모델: 설치 앱·실행 표시·끄기·숨기기·동기화·종료 순서', () => {
  const items = trayMenuItems(state(), true);
  assert.deepEqual(ids(items), ['open', 'hide', 'launch:tajong', 'stop:tajong', 'launch:note', 'sync', 'quit']);
  assert.equal(items.find((i) => i.id === 'launch:tajong').label, '마고 타종 (켜져 있음)');
  assert.equal(items.find((i) => i.id === 'stop:tajong').icon, 'stop');
  assert.equal(items.at(-1).danger, true);
  assert.equal(items.at(-1).icon, 'power');
  assert.equal(items.filter((i) => i.type === 'separator').length, 3);
  assert.ok(!ids(trayMenuItems(state(), false)).includes('hide'));
});

test('트레이 모델: 준비 전에는 앱·동기화 없음, 빈 목록에는 중복 구분선 없음', () => {
  for (const phase of ['boot', 'setup', 'login']) {
    assert.deepEqual(ids(trayMenuItems({ ...state(), phase }, false)), ['open', 'quit']);
    assert.deepEqual(ids(trayMenuItems({ ...state(), phase }, true)), ['open', 'hide', 'quit']);
  }
  const items = trayMenuItems({ phase: 'ready', apps: [] }, false);
  assert.deepEqual(ids(items), ['open', 'sync', 'quit']);
  assert.equal(items.filter((i) => i.type === 'separator').length, 2);
});

test('트레이 모델: state.icons와 snapshot 앱 아이콘 지원, 외부 경로 차단', () => {
  const s = state();
  const image = 'data:image/png;base64,aWNvbg==';
  s.icons = { tajong: image };
  s.apps[1].icon = image;
  assert.deepEqual(trayMenuItems(s, false).filter((i) => i.action === 'launch').map((i) => i.image), [image, image]);
  for (const unsafe of ['https://example.com/icon.png', 'file:///private.png', '<svg onload="alert(1)">']) {
    s.icons.tajong = unsafe;
    assert.equal(trayMenuItems(s, false).find((i) => i.id === 'launch:tajong').image, null);
  }
});

test('트레이 명령: 최신 모델의 문자열 id만 허용', () => {
  const items = trayMenuItems(state(), false);
  for (const id of [null, undefined, {}, ['quit'], 1, '__proto__', 'constructor', 'hide', 'stop:note', 'launch:other', 'launch:unknown', 'quit;anything']) {
    assert.equal(trayMenuAction(items, id), null);
  }
  for (const id of ids(items)) assert.equal(trayMenuAction(items, id).id, id);
  assert.equal(trayMenuAction(trayMenuItems({ ...state(), phase: 'login' }, false), 'sync'), null);
});

for (const [name, workArea, point, expected] of [
  ['하단', { x: 0, y: 0, width: 1920, height: 1040 }, { x: 1900, y: 1060 }, { x: 1679, y: 739 }],
  ['상단', { x: 0, y: 40, width: 1920, height: 1040 }, { x: 1900, y: 10 }, { x: 1679, y: 41 }],
  ['좌측', { x: 60, y: 0, width: 1860, height: 1080 }, { x: 20, y: 1070 }, { x: 61, y: 779 }],
  ['우측', { x: 0, y: 0, width: 1860, height: 1080 }, { x: 1900, y: 1070 }, { x: 1619, y: 779 }],
  ['왼쪽 모니터', { x: -1920, y: -200, width: 1920, height: 1040 }, { x: -10, y: 870 }, { x: -241, y: 539 }],
]) {
  test(`트레이 위치: ${name} 작업 영역 안에 유지`, () => {
    assert.deepEqual(trayMenuBounds(point, { width: 240, height: 300 }, workArea), { ...expected, width: 240, height: 300 });
  });
}

test('트레이 위치: 125·150·200% DPI 모니터의 DIP를 중복 확대하지 않음', () => {
  for (const scaleFactor of [1, 1.25, 1.5, 2]) {
    const display = { scaleFactor, workArea: { x: 1920, y: -120, width: 2560 / scaleFactor, height: 1400 / scaleFactor } };
    const area = display.workArea;
    const bounds = trayMenuBounds({ x: area.x + area.width, y: area.y + area.height + 20 }, { width: 240, height: 300 }, area);
    assert.equal(bounds.width, 240);
    assert.equal(bounds.height, 300);
    assert.equal(bounds.x + bounds.width + 1, Math.floor(area.x + area.width));
    assert.equal(bounds.y + bounds.height + 1, Math.floor(area.y + area.height));
  }
});

test('트레이 위치: 긴 메뉴는 작업 영역 크기로 제한, 소수 크기는 올림', () => {
  assert.deepEqual(trayMenuBounds({ x: 8, y: 20 }, { width: 800, height: 2000 }, { x: 0, y: 40, width: 320, height: 480 }), { x: 1, y: 41, width: 318, height: 478 });
  assert.deepEqual(trayMenuBounds({ x: 4.8, y: 9.2 }, { width: 201.2, height: 123.1 }, { x: 0, y: 0, width: 1000, height: 800 }), { x: 5, y: 9, width: 202, height: 124 });
});

function fixture(t, failure) {
  const ipcMain = new EventEmitter();
  const windows = [];
  const actions = [];
  let fallbackCount = 0;
  let current = state();
  let point = { x: 900, y: 700 };
  class Window extends EventEmitter {
    constructor(options) {
      super();
      if (failure === 'create') throw new Error('만들기 실패');
      this.options = options;
      this.visible = false;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = {};
      this.webContents.send = (_channel, model) => { this.model = model; };
      this.webContents.setWindowOpenHandler = (fn) => { this.openHandler = fn; };
      windows.push(this);
    }
    removeMenu() {}
    loadFile() { return failure === 'load' ? Promise.reject(new Error('읽기 실패')) : Promise.resolve(); }
    setBounds(bounds) { this.bounds = bounds; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    isVisible() { return this.visible; }
    isFocused() { return false; }
    focus() {}
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const popup = createTrayPopup({
    BrowserWindow: Window, ipcMain,
    screen: { getCursorScreenPoint: () => point, getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 760 } }) },
    getTrayBounds: () => ({ x: 900, y: 760, width: 30, height: 40 }),
    getItems: () => trayMenuItems(current, true),
    activate: (item) => actions.push(item.id), fallback: () => fallbackCount++, log: { warn() {} },
  });
  t.after(() => popup.destroy());
  const emit = (channel, value, event) => {
    const w = windows.at(-1);
    ipcMain.emit(`tray-menu:${channel}`, event || { sender: w.webContents, senderFrame: w.webContents.mainFrame }, value);
  };
  const measure = () => emit('measure', { revision: windows.at(-1).model.revision, width: 240, height: 300 });
  const open = () => { popup.toggle(); emit('ready'); measure(); return windows.at(-1); };
  return { popup, windows, actions, ipcMain, emit, measure, open, fallbackCount: () => fallbackCount, state: (s) => { current = s; }, point: (p) => { point = p; } };
}

test('트레이 IPC: 다른 창·iframe·알 수 없는/오래된 id 거절, 정상 항목은 한 번만 실행', async (t) => {
  const f = fixture(t);
  const w = f.open();
  f.emit('activate', 'quit', { sender: {}, senderFrame: w.webContents.mainFrame });
  f.emit('activate', 'quit', { sender: w.webContents, senderFrame: {} });
  for (const id of ['unknown', 'stop:note', null, {}, 'launch:other']) f.emit('activate', id);
  f.state({ ...state(), phase: 'login' });
  f.emit('activate', 'sync');
  assert.equal(w.visible, true);
  assert.deepEqual(f.actions, []);
  f.emit('activate', 'open');
  f.emit('activate', 'quit');
  await Promise.resolve();
  assert.deepEqual(f.actions, ['open']);
  assert.equal(w.visible, false);
});

test('트레이 팝업: 보안 설정·새 상태 반영·오래된/잘못된 측정 거절·닫힌 뒤 측정 무시', (t) => {
  const f = fixture(t);
  const w = f.open();
  assert.equal(w.options.frame, false);
  for (const flag of ['transparent', 'skipTaskbar', 'alwaysOnTop']) assert.equal(w.options[flag], true);
  assert.equal(w.options.resizable, false);
  assert.equal(w.options.webPreferences.sandbox, true);
  assert.equal(w.options.webPreferences.contextIsolation, true);
  assert.equal(w.options.webPreferences.nodeIntegration, false);
  assert.deepEqual(w.openHandler(), { action: 'deny' });
  const old = w.model.revision;
  const next = state(); next.apps[0].running = false;
  f.state(next); f.popup.refresh();
  assert.ok(!ids(w.model.items).includes('stop:tajong'));
  f.emit('measure', { revision: old, width: 1, height: 1 });
  for (const width of [NaN, Infinity, -1, '100', 100001]) f.emit('measure', { revision: w.model.revision, width, height: 100 });
  assert.equal(w.bounds.width, 240);
  f.popup.close(); f.measure();
  assert.equal(w.visible, false);
  f.state({ ...next, phase: 'login' }); f.popup.toggle(); f.measure();
  assert.deepEqual(ids(w.model.items), ['open', 'hide', 'quit']);
});

test('트레이 팝업: 두 번째 우클릭·ESC 채널·blur 닫기, 트레이 blur 뒤 우클릭은 다시 열지 않음', (t) => {
  const f = fixture(t);
  const w = f.open();
  f.popup.toggle(); assert.equal(w.visible, false);
  f.open(); f.emit('close'); assert.equal(w.visible, false);
  f.open(); w.emit('blur'); assert.equal(w.visible, false);
  f.open(); f.point({ x: 910, y: 780 }); w.emit('blur');
  f.popup.toggle(); assert.equal(w.visible, false);
  f.popup.toggle(); f.measure(); assert.equal(w.visible, true);
  f.popup.destroy();
  assert.equal(f.ipcMain.listenerCount('tray-menu:activate'), 0);
});

test('트레이 팝업: 숨긴 창의 늦은 blur가 재열기를 취소하지 않음', (t) => {
  const f = fixture(t);
  const w = f.open();
  f.popup.close();
  f.popup.toggle();
  w.emit('blur');
  f.measure();
  assert.equal(w.visible, true);
});

for (const failure of ['create', 'load', 'crash']) {
  test(`트레이 팝업: ${failure} 실패하면 네이티브 메뉴로 폴백`, async (t) => {
    const f = fixture(t, failure);
    if (failure === 'crash') {
      const w = f.open();
      w.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    } else f.popup.toggle();
    await Promise.resolve();
    assert.equal(f.fallbackCount(), 1);
    if (f.windows.length) assert.equal(f.windows[0].destroyed, true);
  });
}
