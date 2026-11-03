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
  const requests = [];
  c.runner = new Runner({ paths, log, spawnImpl: (exe, args, options) => {
    const child = new EventEmitter();
    if (exe === 'taskkill') { commands.push(args); return child; }
    if (args?.includes('--quit')) { requests.push({ exe, args, options, child }); return child; }
    child.pid = 10000 + spawned.length;
    spawned.push(child);
    return child;
  } });
  c.runner.on('exit', (id, info) => c._onAppExit(id, info));
  const toasts = [];
  c.on('toast', (toast) => toasts.push(toast));
  t.after(() => { c.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { c, spawned, commands, requests, toasts };
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

test('끄기: 정상 종료는 바로 화면에 반영하고 동기화·정리를 기다리지 않음', async (t) => {
  const { c, spawned, commands } = setup(t);
  await c.launch('bell');
  t.mock.timers.tick(40);
  const states = [];
  c.on('state', (state) => states.push(state));
  c.syncApp = c.installer.cleanup = () => new Promise(() => {});
  assert.equal(c.stop('bell'), true);
  t.mock.timers.tick(20);
  spawned[0].emit('exit', 0);
  t.mock.timers.tick(40);
  assert.equal(states.at(-1).apps[0].running, false);
  t.mock.timers.tick(10000);
  assert.equal(commands.some((args) => args.includes('/F')), false);
  assert.equal(spawned.length, 1);
});

test('끄기: 요청을 무시하면 10초 유예 뒤 강제 종료, 연타해도 한 번만 요청', async (t) => {
  const { c, spawned, commands } = setup(t);
  await c.launch('bell');
  c.stop('bell');
  c.stop('bell');
  const forced = () => process.platform === 'win32'
    ? commands.filter((args) => args.includes('/F')).length
    : process.kill.mock.calls.filter(({ arguments: args }) => args[1] === 'SIGKILL').length;
  const graceful = () => process.platform === 'win32'
    ? commands.filter((args) => !args.includes('/F')).length
    : process.kill.mock.calls.filter(({ arguments: args }) => args[1] === 'SIGTERM').length;
  assert.equal(graceful(), 1);
  t.mock.timers.tick(9999);
  assert.equal(forced(), 0);
  assert.equal(c.runner.isRunning('bell'), true);
  t.mock.timers.tick(1);
  assert.equal(forced(), 1);
  spawned[0].emit('exit', 1);
  t.mock.timers.tick(3000);
  await settled(c);
  assert.equal(spawned.length, 1);
  assert.equal(c.runner.isRunning('bell'), false);
});

for (const forced of [false, true]) {
  test(`끄기: 런처가 이어받은 앱의 ${forced ? '강제' : '정상'} 종료도 즉시 통지·동기화하고 재실행하지 않음`, async (t) => {
    const { c, spawned } = setup(t);
    await c.launch('bell');
    const info = c.runner.runningInfo('bell');
    // 런처를 다시 켠 상황: 실행 기록만 있고 ChildProcess의 exit 이벤트는 없음.
    c.runner.running.clear();
    c.adopted.set('bell', info);
    c.installed.bell.version = '1.1.0';
    let alive = true;
    t.mock.method(process, 'kill', () => {
      if (!alive) throw Object.assign(new Error('꺼짐'), { code: 'ESRCH' });
      return true;
    });
    let syncs = 0;
    let cleanups = 0;
    c.syncApp = () => { syncs++; return new Promise(() => {}); };
    c.installer.cleanup = () => { cleanups++; return new Promise(() => {}); };
    t.mock.timers.tick(40);
    const states = [];
    const exits = [];
    c.on('state', (state) => states.push(state));
    c.runner.on('exit', (_id, exit) => exits.push(exit));
    c.stop('bell');
    c.stop('bell');
    t.mock.timers.tick(forced ? 10000 : 20);
    assert.equal(c.runner.isRunning('bell'), true, '창 숨김·종료 요청만으로 꺼졌다고 하지 않음');
    alive = false;
    t.mock.timers.tick(200);
    t.mock.timers.tick(40);
    assert.equal(states.at(-1)?.apps[0].running, false, '종료 뒤 240ms 안에 화면 갱신');
    assert.equal(exits.length, 1);
    assert.equal(exits[0].stopped, true);
    assert.equal(exits[0].restart, false);
    assert.equal(exits[0].userId, info.userId);
    assert.equal(syncs, 1);
    assert.equal(cleanups, 1);
    assert.equal(fs.existsSync(c.paths.app('bell').running), false);
    t.mock.timers.tick(15000);
    c._watchAdopted();
    await settled(c);
    assert.equal(spawned.length, 1);
    assert.equal(exits.length, 1);
  });
}

test('끄기: 이전 실행의 유예 타이머는 새로 켠 앱을 강제 종료하지 않음', async (t) => {
  const { c, spawned, commands } = setup(t);
  await c.launch('bell');
  c.stop('bell');
  spawned[0].emit('exit', 0);
  await c.launch('bell');
  t.mock.timers.tick(10000);
  assert.equal(c.runner.runningInfo('bell').pid, spawned[1].pid);
  assert.equal(commands.some((args) => args.includes('/F')), false);
});

for (const adopted of [false, true]) {
  test(`종료 인수: ${adopted ? '이어받은' : '직접 켠'} 앱에 조용히 요청하고 실제 종료만 통지`, async (t) => {
    const { c, spawned, commands, requests } = setup(t);
    c.installed.bell.manifest.stopArgs = ['--quit'];
    const installed = c.installed.bell;
    await c.launch('bell');
    const info = c.runner.runningInfo('bell');
    const env = c.runner.running.get('bell').env;
    let alive = true;
    if (adopted) {
      c.runner.running.clear();
      c.adopted.set('bell', info);
      t.mock.method(process, 'kill', () => {
        if (!alive) throw Object.assign(new Error('꺼짐'), { code: 'ESRCH' });
        return true;
      });
    } else {
      // 실행 중 업데이트했어도 직접 켠 앱에는 당시 실행 파일·인수를 쓴다.
      c.installed.bell = { ...installed, dir: path.join(installed.dir, 'new'), manifest: { ...installed.manifest, stopArgs: null } };
    }
    const exits = [];
    c.runner.on('exit', (_id, exit) => exits.push(exit));
    assert.equal(c.stop('bell'), true, '요청용 프로세스가 끝나길 기다리지 않음');
    c.stop('bell');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].args, ['--quit']);
    assert.equal(requests[0].exe, path.join(installed.dir, 'app.exe'));
    assert.equal(requests[0].options.cwd, installed.dir);
    assert.equal(requests[0].options.windowsHide, true);
    assert.equal(requests[0].options.stdio, 'ignore');
    assert.equal(requests[0].options.env, adopted ? undefined : env);
    assert.equal(commands.length, 0, 'WM_CLOSE를 같이 보내지 않음');
    requests[0].child.emit('exit', 75);
    assert.equal(exits.length, 0, '요청 도우미의 종료는 원본 종료가 아님');
    assert.equal(c.runner.runningInfo('bell').pid, info.pid);
    t.mock.timers.tick(20);
    if (adopted) alive = false;
    else spawned[0].emit('exit', 75);
    t.mock.timers.tick(200);
    assert.equal(exits.length, 1);
    assert.equal(exits[0].stopped, true);
    assert.equal(exits[0].restart, false);
    t.mock.timers.tick(10000);
    await settled(c);
    assert.equal(commands.length, 0);
    assert.equal(spawned.length, 1);
  });
}

for (const failure of ['요청 무시', '비동기 실행 오류', '동기 실행 오류']) {
  test(`종료 인수: ${failure}여도 10초 유예 뒤 원본만 강제 종료`, async (t) => {
    const { c, spawned, commands, requests } = setup(t);
    c.installed.bell.manifest.stopArgs = ['--quit'];
    await c.launch('bell');
    if (failure === '동기 실행 오류') {
      const spawn = c.runner.spawn;
      t.mock.method(c.runner, 'spawn', (exe, ...args) => {
        if (exe !== 'taskkill') throw new Error('spawn failed');
        return spawn(exe, ...args);
      });
    }
    assert.equal(c.stop('bell'), true);
    if (failure === '비동기 실행 오류') requests[0].child.emit('error', new Error('ENOENT'));
    else if (failure === '요청 무시') requests[0].child.emit('exit', 0);
    const forced = () => process.platform === 'win32'
      ? commands.filter((args) => args.includes('/F')).length
      : process.kill.mock.calls.filter(({ arguments: args }) => args[1] === 'SIGKILL').length;
    t.mock.timers.tick(9999);
    assert.equal(forced(), 0);
    assert.equal(c.runner.isRunning('bell'), true);
    t.mock.timers.tick(1);
    assert.equal(forced(), 1);
    spawned[0].emit('exit', 1);
    t.mock.timers.tick(3000);
    await settled(c);
    assert.equal(spawned.length, 1);
  });
}

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
