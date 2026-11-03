'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Cloud } = require('../src/main/cloud');
const { Store } = require('../src/main/store');
const { makePaths } = require('../src/core/paths');
const { Runner } = require('../src/core/runner');

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settled(c) {
  // 파일 작업까지 끝날 때까지 기다리되 실제 타이머는 진행하지 않는다.
  for (let i = 0; i < 10000; i++) {
    await tick();
    if (!c.anyAppInstallTask() && !c.restarting.size && !c.tasks.size) return;
  }
  assert.fail('복구 작업이 끝나지 않았어요');
}

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000000 });
  t.mock.method(process, 'kill', () => true); // 가짜 PID에는 실제 종료 신호를 보내지 않음
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-recovery-'));
  const paths = makePaths({ userData: path.join(root, 'roaming'), localData: path.join(root, 'local') });
  const log = { info() {}, warn() {}, error() {} };
  const c = new Cloud({ paths, store: new Store({ paths }), version: '1.0.0', log });
  c.user = { id: 'user1', username: 'test', name: '테스트' };
  c.phase = 'ready';
  c.apps = [{ id: 'bell', name: '타종', autoLaunchDefault: true, release: { version: '1.1.0' } }];
  c.installed.bell = { dir: root, version: '1.0.0', manifest: { exe: 'app.exe', restartExitCode: 75 } };
  fs.writeFileSync(path.join(root, 'app.exe'), 'fake');
  c._watchAll = () => {};
  c._writeShortcuts = () => {};
  c.syncApp = async () => {};
  c._ticket = async () => 'ticket';
  c.legacyDetect = async () => [];
  c.installer.cleanup = async () => {};
  c.installer.install = async () => ({ ...c.installed.bell, version: '1.1.0' });
  const spawned = [];
  const commands = [];
  c.runner = new Runner({ paths, log, spawnImpl: (exe, args) => {
    const child = new EventEmitter();
    if (exe === 'taskkill') { commands.push(args); return child; }
    child.pid = 10000 + spawned.length;
    spawned.push(child);
    return child;
  } });
  c.runner.on('exit', (id, info) => c._onAppExit(id, info));
  const toasts = [];
  c.on('toast', (toast) => toasts.push(toast));
  t.after(() => { c.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { c, spawned, commands, toasts };
}

test('자동 업데이트: 꺼진 자동 실행 앱을 새 버전으로 조용히 켬', async (t) => {
  const { c, spawned, toasts } = setup(t);
  c._autoUpdate();
  await settled(c);
  assert.equal(c.installed.bell.version, '1.1.0');
  assert.equal(spawned.length, 1);
  assert.equal(c.runner.runningInfo('bell').version, '1.1.0');
  assert.deepEqual(toasts, []);
  c._autoUpdate();
  await settled(c);
  assert.equal(spawned.length, 1);
});

for (const reason of ['계정에서 끔', '이미 실행 중', '로그아웃', '설치 실패', '수동 설치']) {
  test(`자동 업데이트: ${reason}이면 새로 켜지 않음`, async (t) => {
    const { c, spawned } = setup(t);
    if (reason === '계정에서 끔') c.setAutoLaunch('bell', false);
    if (reason === '이미 실행 중') c.runner.launch({ appId: 'bell', installed: c.installed.bell, env: { MAGOEDU_USER_ID: c.user.id } });
    if (reason === '설치 실패') c.installer.install = async () => { throw new Error('다운로드 실패'); };
    const before = spawned.length;
    if (reason === '수동 설치') await c.install('bell');
    else c._autoUpdate();
    if (reason === '로그아웃') c.user = null;
    await settled(c);
    assert.equal(spawned.length, before);
  });
}

test('자동 업데이트: 기본값이 꺼져 있어도 현재 계정이 켜면 자동 실행', async (t) => {
  const { c, spawned } = setup(t);
  c.apps[0].autoLaunchDefault = false;
  c.setAutoLaunch('bell', true);
  c._autoUpdate();
  await settled(c);
  assert.equal(spawned.length, 1);
});

test('비정상 종료: 3초 뒤 한 번 복구, 2분 안에 다시 죽으면 오류만 표시', async (t) => {
  const { c, spawned, toasts } = setup(t);
  await c.launch('bell');
  spawned[0].emit('exit', 1);
  t.mock.timers.tick(2999);
  await tick();
  assert.equal(spawned.length, 1);
  assert.equal(c.anyRunning(), true, '재실행 대기도 자체 업데이트를 막음');
  t.mock.timers.tick(1);
  await settled(c);
  assert.equal(spawned.length, 2);
  t.mock.timers.tick(119000);
  spawned[1].emit('exit', 2);
  t.mock.timers.tick(3000);
  await settled(c);
  assert.equal(spawned.length, 2);
  assert.equal(toasts.filter((x) => x.kind === 'error').length, 1);
  t.mock.timers.tick(5 * 60 * 1000);
  await settled(c);
  assert.equal(spawned.length, 2);
});

test('비정상 종료: 복구 후 2분 이상 정상 실행했다면 다음 충돌도 한 번 복구', async (t) => {
  const { c, spawned } = setup(t);
  await c.launch('bell');
  spawned[0].emit('exit', 1);
  t.mock.timers.tick(3000);
  await settled(c);
  t.mock.timers.tick(2 * 60 * 1000);
  spawned[1].emit('exit', 1);
  t.mock.timers.tick(3000);
  await settled(c);
  assert.equal(spawned.length, 3);
});

for (const reason of ['정상 종료', '자동 실행 끔', '다른 계정', '사용자 끄기', '복구 대기 중 끄기', '통합 클라우드 종료', '복구 대기 중 로그아웃']) {
  test(`비정상 종료: ${reason}이면 복구하지 않음`, async (t) => {
    const { c, spawned } = setup(t);
    await c.launch('bell');
    if (reason === '자동 실행 끔') c.setAutoLaunch('bell', false);
    if (reason === '다른 계정') c.user = { id: 'user2' };
    if (reason === '사용자 끄기') c.stop('bell');
    spawned[0].emit('exit', reason === '정상 종료' ? 0 : 1);
    if (reason === '복구 대기 중 끄기') c.stop('bell');
    if (reason === '통합 클라우드 종료') c.shutdown();
    if (reason === '복구 대기 중 로그아웃') { c.user = null; c.phase = 'login'; }
    t.mock.timers.tick(3000);
    await settled(c);
    assert.equal(spawned.length, 1);
  });
}

test('재시작 코드 75: 충돌 제한과 별개로 기존 재시작 유지', async (t) => {
  const { c, spawned } = setup(t);
  await c.launch('bell');
  for (let i = 0; i < 2; i++) {
    spawned[i].emit('exit', 75);
    t.mock.timers.tick(600);
    await settled(c);
  }
  assert.equal(spawned.length, 3);
});

test('사용자 끄기: 종료 코드 75가 와도 다시 켜지 않음', async (t) => {
  const { c, spawned } = setup(t);
  await c.launch('bell');
  let exit;
  c.runner.once('exit', (_id, info) => { exit = info; });
  c.stop('bell');
  spawned[0].emit('exit', 75);
  t.mock.timers.tick(3000);
  await settled(c);
  assert.equal(exit.stopped, true);
  assert.equal(exit.restart, false);
  assert.equal(typeof exit.startedAt, 'number');
  assert.equal(spawned.length, 1);
});

test('종료 정보에 계정이 없으면 복구하지 않고 종료 처리만 함', (t) => {
  const { c, spawned } = setup(t);
  assert.doesNotThrow(() => c._onAppExit('bell', { code: 0 }));
  assert.equal(spawned.length, 0);
});

for (const reason of ['끄기', '로그아웃', '계정 변경', '자동 실행 해제', '종료']) {
  test(`충돌 복구: 재실행 동기화를 기다리는 중 ${reason}이면 켜지 않음`, async (t) => {
    const { c, spawned } = setup(t);
    await c.launch('bell');
    let finishSync;
    let syncing = false;
    c.syncApp = () => { syncing = true; return new Promise((resolve) => { finishSync = resolve; }); };
    spawned[0].emit('exit', 1);
    t.mock.timers.tick(3000);
    for (let i = 0; i < 10000 && !syncing; i++) await tick();
    assert.equal(syncing, true);
    if (reason === '끄기') c.stop('bell');
    if (reason === '로그아웃') { c.api.logout = async () => {}; await c.logout(); }
    if (reason === '계정 변경') c.user = { id: 'user2' };
    if (reason === '자동 실행 해제') c.setAutoLaunch('bell', false);
    if (reason === '종료') c.shutdown();
    finishSync();
    await settled(c);
    assert.equal(spawned.length, 1);
  });
}
