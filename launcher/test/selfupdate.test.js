'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setupSelfUpdate } = require('../src/main/selfupdate');

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const cloud = new EventEmitter();
  Object.assign(cloud, {
    store: { config: { serverUrl: 'http://127.0.0.1' } },
    busy: false, running: false, visible: false,
    anyAppInstallTask() { return this.busy; },
    anyRunning() { return this.running; },
    emitState() {},
  });
  const app = new EventEmitter();
  app.isPackaged = true;
  app.getVersion = () => '1.0.0';
  const calls = [];
  app.on('before-update-install', () => calls.push('resume'));
  const updater = new EventEmitter();
  updater.setFeedURL = () => {};
  updater.checkForUpdates = async () => {};
  updater.quitAndInstall = (...args) => calls.push(args);
  const self = setupSelfUpdate({ app, cloud, updater, log: { error() {} }, isWindowVisible: () => cloud.visible });
  updater.emit('update-downloaded', { version: '1.1.0' });
  return { cloud, updater, self, calls };
}

test('자체 업데이트: 앱 작업 중에는 유휴 설치를 미루고, 끝나면 한 번만 설치', async (t) => {
  const { cloud, self, calls } = setup(t);
  cloud.busy = true;
  t.mock.timers.tick(60 * 1000);
  assert.equal(self.install(), false);
  await tick();
  assert.deepEqual(calls, []);
  cloud.busy = false;
  cloud.emit('app-task-settled');
  cloud.emit('app-task-settled');
  await tick();
  assert.deepEqual(calls, ['resume', [true, true]]);
});

test('자체 업데이트: 설치 예약 직후 앱 작업이 생기면 종료 직전에 다시 확인', async (t) => {
  const { cloud, self, calls } = setup(t);
  assert.equal(self.install(), true);
  cloud.busy = true;
  await tick();
  assert.deepEqual(calls, []);
  cloud.busy = false;
  cloud.emit('app-task-settled');
  await tick();
  assert.deepEqual(calls, ['resume', [true, true]]);
});

test('자체 업데이트: 보이는 창·실행 중인 앱은 자동 설치만 막고 수동 설치는 허용', async (t) => {
  const { cloud, self, calls } = setup(t);
  cloud.visible = true;
  t.mock.timers.tick(60 * 1000);
  await tick();
  assert.deepEqual(calls, []);
  cloud.visible = false;
  cloud.running = true;
  t.mock.timers.tick(60 * 1000);
  await tick();
  assert.deepEqual(calls, []);
  cloud.visible = true;
  assert.equal(self.install(), true);
  await tick();
  assert.deepEqual(calls, ['resume', [true, true]]);
});

test('자체 업데이트: 끌 때는 받아 둔 업데이트를 설치 (중단된 앱 설치는 다음 시작 때 정리하고 다시 받음)', (t) => {
  const { updater } = setup(t);
  assert.equal(updater.autoInstallOnAppQuit, true);
});

test('자체 업데이트: 예약 뒤 오류가 나면 설치하지 않고, 다시 준비되면 재시도', async (t) => {
  const { updater, self, calls } = setup(t);
  assert.equal(self.install(), true);
  updater.emit('error', new Error('테스트 설치 오류'));
  await tick();
  assert.deepEqual(calls, []);
  updater.emit('update-downloaded', { version: '1.1.0' });
  assert.equal(self.install(), true);
  await tick();
  assert.deepEqual(calls, ['resume', [true, true]]);
});
