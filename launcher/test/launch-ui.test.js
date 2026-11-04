'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

test('앱 카드: 실행 중이면 업데이트보다 창 열기가 우선, 꺼져 있으면 설치·업데이트', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'views'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  for (const file of ['ui.js', 'icons.js', 'views/home.js']) {
    fs.copyFileSync(path.join(__dirname, '../src/renderer/js', file), path.join(root, file));
  }
  const { HomeView } = await import(pathToFileURL(path.join(root, 'views/home.js')).href);
  const calls = [];
  const view = Object.create(HomeView.prototype);
  view.web = false;
  view.cloud = {
    launch: async (id) => { calls.push(`open:${id}`); return { already: true, focused: true }; },
    install: async (id) => calls.push(`install:${id}`),
  };
  await view.primary({ id: 'notes', installed: {}, running: true, updateAvailable: true });
  await view.primary({ id: 'notes', installed: {}, running: true });
  await view.primary({ id: 'notes', installed: {}, running: false, updateAvailable: true });
  await view.primary({ id: 'new', running: false });
  assert.deepEqual(calls, ['open:notes', 'open:notes', 'install:notes', 'install:new']);
});

function mainFixture() {
  const calls = [];
  class Window extends EventEmitter {
    constructor() {
      super();
      this.visible = false;
      this.webContents = { on() {}, setWindowOpenHandler() {}, send: (...args) => calls.push(['send', ...args]) };
    }
    removeMenu() {}
    loadFile() {}
    isMinimized() { return false; }
    isDestroyed() { return false; }
    isVisible() { return this.visible; }
    show() { this.visible = true; calls.push(['show']); this.emit('show'); }
    hide() { this.visible = false; calls.push(['hide']); this.emit('hide'); }
    focus() { this.emit('focus'); }
  }
  const electron = {
    app: { setName() {}, on() {}, getVersion: () => '1', whenReady: () => new Promise(() => {}), isPackaged: false },
    BrowserWindow: Window,
    Menu: { buildFromTemplate: (items) => items },
  };
  const file = path.join(__dirname, '../src/main/main.js');
  const api = vm.runInNewContext(`${fs.readFileSync(file, 'utf8')}
    ({ createWindow, showWindow, doLaunch, buildTrayMenu, setCloud: (c) => { cloud = c; } });`, {
    require: (id) => {
      if (id === 'electron') return electron;
      if (id === 'electron-log/main') return { initialize() {}, transports: { file: {} } };
      if (id.startsWith('node:')) return require(id);
      return {};
    },
    __dirname: path.dirname(file),
    process: { argv: [], env: { MAGOEDU_CLOUD_TEST: '1' }, platform: 'win32', on() {} },
  });
  const cloud = {
    emitState: () => calls.push(['state']),
    canLaunchNow: () => true,
    launch: async (id) => { calls.push(['launch', id]); return { already: true, focused: true }; },
    stop: (id) => calls.push(['stop', id]),
  };
  api.setCloud(cloud);
  api.createWindow({ show: false });
  return { api, calls, cloud };
}

test('바로가기·트레이로 실행 중 앱을 열면 런처가 다시 포커스를 빼앗지 않음, 끄기는 별도 항목', async () => {
  const { api, calls } = mainFixture();
  await api.doLaunch('notes', { fromLink: true });
  assert.deepEqual(calls, [['launch', 'notes']]);
  const menu = api.buildTrayMenu({ phase: 'ready', apps: [{ id: 'notes', name: '노트', installed: {}, running: true }] });
  await menu.find((item) => item.label === '노트 (켜져 있음)').click();
  menu.find((item) => item.label === '노트 끄기').click();
  assert.deepEqual(calls, [['launch', 'notes'], ['launch', 'notes'], ['stop', 'notes']]);
});

test('런처 창을 다시 열거나 포커스하면 실제 바로가기 상태를 다시 보내고, 복구 실패도 표시', async () => {
  const { api, calls, cloud } = mainFixture();
  api.showWindow();
  assert.deepEqual(calls, [['show'], ['state'], ['state']]);
  calls.length = 0;
  cloud.launch = async () => { throw new Error('창을 앞으로 가져오지 못했어요'); };
  await api.doLaunch('notes', { fromLink: true });
  assert.equal(calls[0][0], 'show');
  assert.equal(calls.at(-1)[1], 'toast');
  assert.match(calls.at(-1)[2].text, /창을 앞으로/);
});

test('네이티브 트레이 폴백도 창이 보일 때만 숨기기를 제공하고 상태를 갱신', () => {
  const { api, calls } = mainFixture();
  const state = { phase: 'login', apps: [] };
  assert.ok(!api.buildTrayMenu(state).some((item) => item.label === '숨기기'));
  api.showWindow();
  calls.length = 0;
  api.buildTrayMenu(state).find((item) => item.label === '숨기기').click();
  assert.deepEqual(calls, [['hide'], ['state']]);
  assert.ok(!api.buildTrayMenu(state).some((item) => item.label === '숨기기'));
});
