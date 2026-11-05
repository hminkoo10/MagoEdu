'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setupSelfUpdate } = require('../src/main/selfupdate');

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('수동 설치: 작업 대기 이유를 알리고 창이 열려 있어도 작업 종료 뒤 설치', async (t) => {
  const { cloud, self, calls } = setup(t);
  cloud.visible = true;
  cloud.running = true;
  cloud.busy = true;
  assert.equal(self.install().status, 'deferred');
  assert.equal(cloud.update.status, 'deferred');
  assert.equal(cloud.update.message, '프로그램 설치가 끝나면 바로 업데이트해요.');
  cloud.busy = false;
  cloud.emit('app-task-settled');
  cloud.emit('app-task-settled');
  t.mock.timers.tick(3000);
  await tick();
  assert.deepEqual(calls, ['resume', [true, true]]);
});

function setup(t, { ready = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000000 });
  const cloud = new EventEmitter();
  Object.assign(cloud, {
    store: { config: { serverUrl: 'http://127.0.0.1' } },
    busy: false, running: false, visible: false,
    anyAppInstallTask() { return this.busy; },
    anyRunning() { return this.running; },
    states: [],
    emitState() { this.states.push(this.update); },
  });
  const app = new EventEmitter();
  app.isPackaged = true;
  app.getVersion = () => '1.0.0';
  const calls = [];
  app.on('before-update-install', () => calls.push('resume'));
  const updater = new EventEmitter();
  const powerMonitor = new EventEmitter();
  const checks = [];
  updater.setFeedURL = () => {};
  updater.checkForUpdates = async () => { checks.push(Date.now()); updater.emit('update-not-available'); };
  updater.quitAndInstall = (...args) => calls.push(args);
  const self = setupSelfUpdate({ app, cloud, updater, powerMonitor, log: { error() {} }, isWindowVisible: () => cloud.visible });
  if (ready) updater.emit('update-downloaded', { version: '1.1.0' });
  return { app, cloud, updater, powerMonitor, self, calls, checks };
}

test('자체 업데이트: 시작 8초 뒤와 매시간 확인', async (t) => {
  const { checks } = setup(t, { ready: false });
  t.mock.timers.tick(7999);
  assert.equal(checks.length, 0);
  t.mock.timers.tick(1);
  await tick();
  assert.equal(checks.length, 1);
  t.mock.timers.tick(60 * 60 * 1000 - 8000);
  await tick();
  assert.equal(checks.length, 2);
  t.mock.timers.tick(60 * 60 * 1000);
  await tick();
  assert.equal(checks.length, 3);
});

test('자체 업데이트: 절전 복귀는 최근 확인부터 10분 간격, 404 뒤에도 재시도', async (t) => {
  const { updater, powerMonitor, checks } = setup(t, { ready: false });
  updater.checkForUpdates = async () => { checks.push(Date.now()); throw new Error('404'); };
  t.mock.timers.tick(8000);
  await tick();
  powerMonitor.emit('resume');
  t.mock.timers.tick(10 * 60 * 1000 - 1);
  powerMonitor.emit('resume');
  assert.equal(checks.length, 1);
  t.mock.timers.tick(1);
  powerMonitor.emit('resume');
  await tick();
  assert.equal(checks.length, 2);
  powerMonitor.emit('resume');
  powerMonitor.emit('resume');
  assert.equal(checks.length, 2);
  t.mock.timers.tick(10 * 60 * 1000);
  powerMonitor.emit('resume');
  await tick();
  assert.equal(checks.length, 3);
});

test('자체 업데이트: 절전 복귀 직후 정기 확인도 중복하지 않음', async (t) => {
  const { powerMonitor, checks } = setup(t, { ready: false });
  t.mock.timers.tick(8000);
  await tick();
  t.mock.timers.tick(59 * 60 * 1000 - 8000);
  powerMonitor.emit('resume');
  await tick();
  assert.equal(checks.length, 2);
  t.mock.timers.tick(60 * 1000);
  await tick();
  assert.equal(checks.length, 2);
});

test('자체 업데이트: 앱 작업 중에는 유휴 설치를 미루고, 끝나면 한 번만 설치', async (t) => {
  const { cloud, calls } = setup(t);
  cloud.busy = true;
  t.mock.timers.tick(60 * 1000);
  assert.equal(cloud.update.status, 'ready');
  await tick();
  assert.deepEqual(calls, []);
  cloud.busy = false;
  cloud.emit('app-task-settled');
  cloud.emit('app-task-settled');
  t.mock.timers.tick(0);
  await tick();
  assert.deepEqual(calls, ['resume', [true, true]]);
});

test('자체 업데이트: 설치 예약 직후 앱 작업이 생기면 종료 직전에 다시 확인', async (t) => {
  const { cloud, self, calls } = setup(t);
  assert.equal(self.install().status, 'installing');
  cloud.busy = true;
  t.mock.timers.tick(3000);
  await tick();
  assert.deepEqual(calls, []);
  assert.equal(cloud.update.status, 'deferred');
  cloud.visible = true;
  cloud.busy = false;
  cloud.emit('app-task-settled');
  t.mock.timers.tick(3000);
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
  assert.equal(self.install().status, 'installing');
  t.mock.timers.tick(3000);
  await tick();
  assert.deepEqual(calls, ['resume', [true, true]]);
});

test('자체 업데이트: 끌 때는 받아 둔 업데이트를 설치 (중단된 앱 설치는 다음 시작 때 정리하고 다시 받음)', (t) => {
  const { updater } = setup(t);
  assert.equal(updater.autoInstallOnAppQuit, true);
});

test('자체 업데이트: 예약 뒤 오류가 나면 설치하지 않고, 다시 준비되면 재시도', async (t) => {
  const { updater, self, calls } = setup(t);
  assert.equal(self.install().status, 'installing');
  updater.emit('error', new Error('테스트 설치 오류'));
  t.mock.timers.tick(3000);
  await tick();
  assert.deepEqual(calls, []);
  updater.emit('update-downloaded', { version: '1.1.0' });
  assert.equal(self.install().status, 'installing');
  t.mock.timers.tick(3000);
  await tick();
  assert.deepEqual(calls, ['resume', [true, true]]);
});

test('수동 설치: 즉시 상태 전송, 안내 3초 뒤 조용히 설치, 중복 클릭·확인 차단', async (t) => {
  const { cloud, updater, self, calls, checks } = setup(t);
  const state = self.install();
  assert.equal(state.status, 'installing');
  assert.equal(state.version, '1.1.0');
  assert.equal(state.message, '업데이트를 설치하려고 잠시 닫아요. 1분쯤 뒤에 다시 켜져요.');
  assert.equal(cloud.states.at(-1), state);
  assert.equal(self.install(), state);
  assert.equal(await self.check(), state);
  assert.equal(checks.length, 0);
  t.mock.timers.tick(2999);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  await tick();
  assert.deepEqual(calls, ['resume', [true, true]]);
  assert.equal(updater.autoRunAppAfterInstall, true);
});

test('수동 대기: 작업 종료 알림을 놓쳐도 재개, 정기 확인은 대기 상태 보존', async (t) => {
  const { cloud, self, calls, checks } = setup(t);
  cloud.busy = cloud.visible = true;
  self.install();
  await self.check();
  assert.equal(cloud.update.status, 'deferred');
  assert.equal(checks.length, 0);
  cloud.busy = false;
  t.mock.timers.tick(60000);
  t.mock.timers.tick(3000);
  await tick();
  assert.deepEqual(calls, ['resume', [true, true]]);
});

for (const kind of ['throw', 'event']) test(`설치 실패 ${kind}: 이유·재시도 상태 전송, 종료 허용 복원, 직접 재시도`, async (t) => {
  const { app, cloud, updater, self, calls } = setup(t);
  let restored = 0;
  app.on('update-install-failed', () => restored++);
  const install = updater.quitAndInstall;
  updater.quitAndInstall = () => {
    if (kind === 'throw') throw new Error('설치 파일 실행 실패');
    updater.emit('error', new Error('설치 파일 실행 실패'));
  };
  self.install();
  t.mock.timers.tick(3000);
  await tick();
  assert.equal(cloud.update.status, 'error');
  assert.equal(cloud.update.canRetryInstall, true);
  assert.match(cloud.update.message, /설치 파일 실행 실패/);
  assert.equal(cloud.states.at(-1), cloud.update);
  assert.equal(restored, 1);
  t.mock.timers.tick(60000);
  assert.deepEqual(calls, ['resume'], '오류 뒤 자동 재시도하지 않음');
  updater.quitAndInstall = install;
  self.install();
  t.mock.timers.tick(3000);
  await tick();
  assert.deepEqual(calls, ['resume', 'resume', [true, true]]);
});

test('받기 전 오류: 설치 재시도 대신 업데이트 확인, 준비 전 설치 요청도 상태 반환', (t) => {
  const { cloud, updater, self, calls } = setup(t, { ready: false });
  updater.emit('error', new Error('내려받기 실패'));
  assert.equal(cloud.update.canRetryInstall, false);
  assert.equal(self.install(), cloud.update);
  t.mock.timers.tick(3000);
  assert.deepEqual(calls, []);
});

test('자동 설치: 실제 종료 직전에 창이 열리면 멈추고, 닫힌 뒤 조용히 설치', async (t) => {
  const { cloud, self, calls } = setup(t);
  self.install({ automatic: true });
  cloud.visible = true;
  t.mock.timers.tick(0);
  assert.equal(cloud.update.status, 'ready');
  assert.deepEqual(calls, []);
  cloud.visible = false;
  cloud.emit('app-task-settled');
  t.mock.timers.tick(0);
  await tick();
  assert.deepEqual(calls, ['resume', [true, true]]);
});

test('자동 설치 예약 직후 앱 작업이 시작되면 수동 예약으로 바꾸지 않고 유휴 조건 유지', async (t) => {
  const { cloud, self, calls } = setup(t);
  self.install({ automatic: true });
  cloud.busy = true;
  t.mock.timers.tick(0);
  assert.equal(cloud.update.status, 'ready');
  cloud.visible = true;
  cloud.busy = false;
  cloud.emit('app-task-settled');
  t.mock.timers.tick(60000);
  assert.deepEqual(calls, []);
  cloud.visible = false;
  cloud.emit('app-task-settled');
  t.mock.timers.tick(0);
  await tick();
  assert.deepEqual(calls, ['resume', [true, true]]);
});
