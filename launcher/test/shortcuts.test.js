'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Cloud } = require('../src/main/cloud');
const { Store } = require('../src/main/store');
const { Shortcuts } = require('../src/main/shortcuts');
const { makePaths } = require('../src/core/paths');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-shortcuts-'));
  const paths = makePaths({ userData: path.join(root, 'roaming'), localData: path.join(root, 'local') });
  const desktopDir = path.join(root, 'desktop');
  fs.mkdirSync(desktopDir);
  const shortcuts = new Shortcuts({
    exePath: path.join(root, 'cloud.exe'),
    desktopDir,
    startMenuDir: path.join(root, 'start'),
    shell: {
      writeShortcutLink(file, _action, options) {
        fs.writeFileSync(file, JSON.stringify(options));
        return true;
      },
      readShortcutLink: (file) => JSON.parse(fs.readFileSync(file, 'utf8')),
    },
  });
  const store = new Store({ paths });
  const cloud = new Cloud({ paths, store, shortcuts, version: '1', log: { warn() {} } });
  cloud.apps = [{ id: 'notes', name: '노트' }];
  cloud.installed.notes = { dir: root, version: '1', manifest: { exe: 'notes.exe' } };
  t.after(() => {
    cloud.shutdown();
    clearTimeout(cloud._emitTimer);
    fs.rmSync(root, { recursive: true, force: true });
  });
  cloud._writeShortcuts('notes');
  const [desktop, startMenu] = shortcuts._files('노트.lnk');
  return { cloud, store, shortcuts, desktop, startMenu, view: () => cloud.snapshot().apps[0] };
}

test('바탕 화면에서 직접 지움: 상태·설정에 반영, 업데이트로 되살리지 않음, 다시 추가 가능', (t) => {
  const { cloud, store, desktop, startMenu, view } = setup(t);
  assert.equal(view().desktopShortcut, true);
  fs.rmSync(desktop);
  assert.equal(view().desktopShortcut, false);
  assert.equal(store.config.shortcuts.notes.desktop, false);
  cloud._writeShortcuts('notes');
  assert.equal(fs.existsSync(desktop), false);
  assert.equal(fs.existsSync(startMenu), true);
  cloud.setDesktopShortcut('notes', true);
  assert.equal(view().desktopShortcut, true);
  assert.equal(fs.existsSync(desktop), true);
});

test('시작 메뉴만 직접 지워도 바탕 화면 바로 가기는 유지, 재추가 전에는 되살리지 않음', (t) => {
  const { cloud, store, desktop, startMenu, view } = setup(t);
  fs.rmSync(startMenu);
  assert.equal(view().desktopShortcut, true);
  assert.equal(view().startMenuShortcut, false);
  assert.equal(store.config.shortcuts.notes.startMenu, false);
  cloud._writeShortcuts('notes');
  assert.equal(fs.existsSync(desktop), true);
  assert.equal(fs.existsSync(startMenu), false);
  cloud.setDesktopShortcut('notes', true);
  assert.equal(view().startMenuShortcut, true);
});

test('삭제 직후 상태 조회보다 업데이트가 먼저 와도 삭제 의도를 저장함', (t) => {
  const { cloud, store, desktop, startMenu } = setup(t);
  fs.rmSync(desktop);
  fs.rmSync(startMenu);
  cloud._writeShortcuts('notes');
  assert.equal(store.config.shortcuts.notes.desktop, false);
  assert.equal(store.config.shortcuts.notes.startMenu, false);
  assert.equal(fs.existsSync(desktop), false);
  assert.equal(fs.existsSync(startMenu), false);
});

test('앱 이름 변경·런처 재시작 뒤에도 사용자가 지운 바로 가기는 복구하지 않음', (t) => {
  const { cloud, store, shortcuts, desktop, startMenu } = setup(t);
  fs.rmSync(desktop);
  fs.rmSync(startMenu);
  cloud.apps[0].name = '새 노트';
  cloud._ensureShortcuts();
  assert.deepEqual(shortcuts.exists('새 노트.lnk'), { desktop: false, startMenu: false });
  cloud.store = new Store({ paths: store.paths });
  cloud._ensureShortcuts();
  assert.equal(cloud.snapshot().apps[0].desktopShortcut, false);
  cloud.setDesktopShortcut('notes', true);
  assert.deepEqual(shortcuts.exists('새 노트.lnk'), { desktop: true, startMenu: true });
});

test('주기 확인은 직접 삭제를 감지해 화면 상태를 보냄', (t) => {
  const { cloud, desktop, startMenu } = setup(t);
  clearTimeout(cloud._emitTimer);
  cloud._emitTimer = null;
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  cloud.phase = 'ready';
  const states = [];
  cloud.on('state', (s) => states.push(s));
  cloud._startTimers();
  fs.rmSync(desktop);
  fs.rmSync(startMenu);
  t.mock.timers.tick(15000);
  t.mock.timers.tick(40);
  assert.equal(states.length, 1);
  assert.equal(states[0].apps[0].desktopShortcut, false);
  assert.equal(states[0].apps[0].startMenuShortcut, false);
});

test('바탕 화면 끄기·이름 변경은 남아 있는 시작 메뉴 바로 가기만 갱신함', (t) => {
  const { cloud, shortcuts, desktop, startMenu } = setup(t);
  cloud.setDesktopShortcut('notes', false);
  cloud.apps[0].name = '새 노트';
  cloud._ensureShortcuts();
  assert.deepEqual(shortcuts.exists('새 노트.lnk'), { desktop: false, startMenu: true });
  assert.equal(fs.existsSync(desktop), false);
  assert.equal(fs.existsSync(startMenu), false);
});

test('과목내비 이름 변경: PC의 옛 바로가기 교체, 같은 이름의 웹 앱은 바로가기 생성 안 함', (t) => {
  const { cloud, shortcuts, store } = setup(t);
  cloud.apps = [
    { id: 'mago-navi', name: '마고 과목내비', platform: 'web' },
    { id: 'mago-navi-pc', name: '마고 과목내비 (PC)', platform: 'windows' },
  ];
  cloud.installed['mago-navi-pc'] = cloud.installed.notes;
  cloud._writeShortcuts('mago-navi-pc');
  assert.deepEqual(shortcuts.exists('마고 과목내비 (PC).lnk'), { desktop: true, startMenu: true });
  cloud.apps[1].name = '마고 과목내비';
  cloud._ensureShortcuts();
  assert.deepEqual(shortcuts.exists('마고 과목내비 (PC).lnk'), { desktop: false, startMenu: false });
  assert.deepEqual(shortcuts.exists('마고 과목내비.lnk'), { desktop: true, startMenu: true });
  for (const file of shortcuts._files('마고 과목내비.lnk')) {
    assert.equal(JSON.parse(fs.readFileSync(file)).args, 'magoedu://launch/mago-navi-pc');
  }
  assert.equal(store.config.shortcuts['mago-navi'], undefined);
  assert.equal(store.config.shortcuts['mago-navi-pc'].name, '마고 과목내비.lnk');
  cloud._ensureShortcuts();
  assert.deepEqual(shortcuts.exists('마고 과목내비.lnk'), { desktop: true, startMenu: true });
});

test('과목내비 이름 변경: 사용자가 지운 바탕 화면 바로가기는 복원하지 않음', (t) => {
  const { cloud, shortcuts } = setup(t);
  cloud.apps = [{ id: 'mago-navi-pc', name: '마고 과목내비 (PC)', platform: 'windows' }];
  cloud.installed['mago-navi-pc'] = cloud.installed.notes;
  cloud._writeShortcuts('mago-navi-pc');
  fs.rmSync(shortcuts._files('마고 과목내비 (PC).lnk')[0]);
  cloud.apps[0].name = '마고 과목내비';
  cloud._ensureShortcuts();
  assert.deepEqual(shortcuts.exists('마고 과목내비 (PC).lnk'), { desktop: false, startMenu: false });
  assert.deepEqual(shortcuts.exists('마고 과목내비.lnk'), { desktop: false, startMenu: true });
});
