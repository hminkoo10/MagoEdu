'use strict';

// 계정을 바꾸면 예전 계정으로 켠 프로그램을 끔, 사용 중지된 계정으로 켜기, 목록을 받은 뒤 새 버전이 나옴,
// 설정 파일 서명 키(dataSigning), 통합 클라우드를 다시 켠 뒤 새 버전으로 다시 켜기

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { startServer, ADMIN_PASSWORD } = require('../../server/test/helpers');
const { makeZip } = require('./lib/zipwriter');
const { makePaths } = require('../src/core/paths');
const { Store } = require('../src/main/store');
const { Cloud } = require('../src/main/cloud');
const { Runner } = require('../src/core/runner');
const { setupSelfUpdate } = require('../src/main/selfupdate');

const quiet = { info() {}, warn() {}, error() {} };
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `magoedu-${name}-`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, what = '조건') {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`${what}: ${ms}ms 안에 되지 않았어요`);
    await sleep(40);
  }
}

async function setup(t, { apps = { bell: {} } } = {}) {
  const emptyCatalog = path.join(tmp('catalog'), 'catalog.json');
  fs.writeFileSync(emptyCatalog, '[]');
  const s = await startServer({ catalogFile: emptyCatalog });
  t.after(() => s.close());
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const publish = async (id, version, manifest = {}) => {
    const m = { format: 1, id, exe: 'bin/app.sh', sync: { include: ['**'] }, ...manifest };
    const dir = path.join(s.dataDir, 'packages', id);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f)); // 서버는 마지막 버전만 준다
    fs.writeFileSync(path.join(dir, `App-${version}-win-x64.zip`), makeZip({ 'magoedu-app.json': JSON.stringify(m), 'bin/app.sh': '#!/bin/sh\n' }));
    const r = await s.request('POST', '/api/admin/apps/refresh', { token: admin, body: { id } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  };
  for (const [id, manifest] of Object.entries(apps)) {
    await s.request('POST', '/api/admin/apps', { token: admin, body: { id, name: id, source: { type: 'local' } } });
    await publish(id, '1.0.0', manifest);
  }
  const mk = async (body) => {
    const r = await s.request('POST', '/api/users', { token: admin, body: { password: 'pass1234', mustChangePassword: false, ...body } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.user;
  };
  const root = tmp('cloud');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = makePaths({ userData: path.join(root, 'roaming'), localData: path.join(root, 'local') });
  const open = async (beforeInit = () => {}) => {
    const cloud = new Cloud({ paths, store: new Store({ paths, defaults: { serverUrl: s.base } }), version: '1.0.0', log: quiet });
    // 실제로 켜지 않고, 켜진 프로그램을 흉내 낸다 (계정·버전 기록)
    const running = new Map();
    cloud.fake = { running, launched: [], stopped: [] };
    cloud.runner.launch = ({ appId, installed, env }) => {
      cloud.fake.launched.push({ appId, env });
      running.set(appId, { pid: 1000 + cloud.fake.launched.length, userId: env.MAGOEDU_USER_ID, version: installed.version });
    };
    cloud.runner.isRunning = (id) => running.has(id);
    cloud.runner.runningInfo = (id) => running.get(id) || null;
    cloud.runner.stop = (id) => {
      cloud.fake.stopped.push(id);
      setTimeout(() => running.delete(id), 50);
      return true;
    };
    t.after(() => {
      cloud.shutdown();
      for (const id of [...cloud.watchers.keys()]) cloud._unwatch(id);
    });
    beforeInit(cloud);
    await cloud.init();
    return cloud;
  };
  return { s, admin, mk, open, publish };
}

test('계정 바꾸기: 로그아웃하면 그 계정으로 켠 프로그램을 끄고, 다른 계정으로 로그인하면 예전 계정의 프로그램을 끔', async (t) => {
  const { mk, open } = await setup(t);
  await mk({ role: 'director', name: 'A원장', username: 'usera', academyName: 'A학원' });
  await mk({ role: 'director', name: 'B원장', username: 'userb', academyName: 'B학원' });
  const c = await open();
  const a = await c.login('usera', 'pass1234');
  assert.equal((await c.launch('bell', { skipLegacyCheck: true })).started, true);
  await c.logout();
  assert.deepEqual(c.fake.stopped, ['bell'], '로그아웃할 때 끔');
  assert.equal(c.runner.isRunning('bell'), false);

  // 로그아웃 없이 로그인이 끊긴 뒤 다른 계정으로 로그인 (켜 둔 프로그램은 A 계정)
  c.fake.running.set('bell', { pid: 77, userId: a.id, version: '1.0.0' });
  const b = await c.login('userb', 'pass1234');
  assert.deepEqual(c.fake.stopped, ['bell', 'bell'], 'B 로 로그인하면 A 로 켠 것은 끔');
  // 켤 때 다른 계정으로 켜져 있으면 끄고 이 계정으로 켬 ('이미 켜져 있음'이 아니라)
  c.fake.running.set('bell', { pid: 78, userId: a.id, version: '1.0.0' });
  const r = await c.launch('bell', { skipLegacyCheck: true });
  assert.equal(r.started, true);
  assert.equal(c.fake.launched.at(-1).env.MAGOEDU_USER_ID, b.id);
  // 같은 계정으로 다시 로그인하면 켜 둔 것은 그대로
  c._authLost({ code: 'session_invalid', message: '로그인이 끝났어요.' });
  await c.login('userb', 'pass1234');
  assert.equal(c.runner.isRunning('bell'), true);
});

for (const fail of [false, true]) test(`자체 업데이트: 대기 중인 앱 설치까지 ${fail ? '실패로 끝나도' : '성공할 때까지'} 기다림`, async (t) => {
  const { open } = await setup(t);
  const c = await open();
  await c.login('admin', ADMIN_PASSWORD);
  await c.install('bell');
  let quitCount = 0;
  const updater = new EventEmitter();
  updater.setFeedURL = () => {};
  updater.checkForUpdates = async () => {};
  updater.quitAndInstall = () => { quitCount += 1; };
  const app = { isPackaged: true, getVersion: () => '1.0.0', emit() {} };
  const self = setupSelfUpdate({ app, cloud: c, log: quiet, isWindowVisible: () => false, updater });
  const releases = [];
  c.installer.install = () => new Promise((resolve, reject) => releases.push({ resolve, reject }));
  const first = c.install('bell');
  await until(() => releases.length === 1, 5000, '첫 설치 시작');
  const second = c.install('bell');
  const result = fail ? assert.rejects(second, /테스트 실패/) : second;
  updater.emit('update-downloaded', { version: '1.1.0' });
  assert.equal(self.install(), false);
  assert.equal(quitCount, 0);
  releases.shift().resolve(c.installed.bell);
  await first;
  await until(() => releases.length === 1, 5000, '대기하던 설치 시작');
  assert.equal(self.install(), false);
  assert.equal(quitCount, 0);
  const last = releases.shift();
  if (fail) last.reject(new Error('테스트 실패'));
  else last.resolve(c.installed.bell);
  await result;
  await until(() => quitCount === 1, 5000, '통합 클라우드 재시작');
  assert.equal(c.anyAppInstallTask(), false);
});

test('자동 업데이트: 다른 작업 뒤에 대기하고 중복 예약하지 않으며 조용한 실패 뒤 재시도 가능', async (t) => {
  const { open, publish } = await setup(t);
  const c = await open();
  await c.login('admin', ADMIN_PASSWORD);
  await c.install('bell');
  await publish('bell', '1.1.0');
  await c.refreshApps();
  c._setTask('bell', { kind: 'uninstall' });
  c._autoUpdate();
  assert.equal(c.anyAppInstallTask(), false, '삭제 중인 앱은 다시 설치하지 않음');
  c._setTask('bell', null);
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const busy = c._lock('bell', async () => {
    c._setTask('bell', { kind: 'launch' });
    await waiting;
    c._setTask('bell', null);
  });
  await until(() => c.tasks.has('bell'));
  const install = c.installer.install.bind(c.installer);
  const warnings = [];
  c.log = { ...quiet, warn: (...args) => warnings.push(args) };
  c.installer.install = async () => { throw new Error('테스트 다운로드 실패'); };
  c.store.setConfig({ autoUpdateApps: false });
  c._autoUpdate();
  assert.equal(c.anyAppInstallTask(), false);
  c.store.setConfig({ autoUpdateApps: true });
  c._autoUpdate();
  c._autoUpdate();
  try {
    assert.equal(c.installTasks.get('bell'), 1);
  } finally {
    release();
    await busy;
    await until(() => !c.anyAppInstallTask());
  }
  assert.equal(warnings.some((args) => args.includes('테스트 다운로드 실패')), true);
  assert.equal(c.tasks.has('bell'), false);
  c.installer.install = install;
  c._autoUpdate();
  await until(() => c.installed.bell.version === '1.1.0' && !c.anyAppInstallTask());
});

for (const fromSession of [true, false]) test(`중단된 업데이트: ${fromSession ? '저장된 로그인' : '새 로그인'} 뒤 동기화를 기다리지 않고 최신 목록으로 다시 받음`, async (t) => {
  const { open, publish } = await setup(t);
  const first = await open();
  await first.login('admin', ADMIN_PASSWORD);
  await first.install('bell');
  await publish('bell', '1.1.0');
  const zip = path.join(first.paths.downloadsDir, 'bell-1.1.0.zip');
  fs.writeFileSync(zip, 'half');
  fs.writeFileSync(`${zip}.part`, 'half');
  fs.mkdirSync(path.join(first.paths.app('bell').root, '1.1.0.partial'), { recursive: true });
  first.shutdown();
  if (!fromSession) first.store.clearSession();

  let finishSync;
  const syncing = new Promise((resolve) => { finishSync = resolve; });
  const restarted = await open((c) => { c.syncAll = () => syncing; });
  const login = fromSession ? Promise.resolve() : restarted.login('admin', ADMIN_PASSWORD);
  try {
    await until(() => restarted.installed.bell?.version === '1.1.0', 3000, '동기화 도중 업데이트');
    assert.equal(restarted.apps.find((a) => a.id === 'bell').release.version, '1.1.0');
    assert.equal(fs.existsSync(zip), false);
    assert.equal(fs.existsSync(`${zip}.part`), false);
    assert.equal(fs.existsSync(path.join(restarted.paths.app('bell').root, '1.1.0.partial')), false);
    assert.equal((await restarted.installer.installed('bell')).version, '1.1.0');
  } finally {
    finishSync();
    await login;
    await until(() => !restarted.anyAppInstallTask());
  }
});

for (const restartExitCode of [75, 42]) test(`프로그램 종료 코드 ${restartExitCode}: 새 버전으로 다시 켜고 재시작 표시를 지움`, async (t) => {
  const manifest = restartExitCode === 75 ? {} : { restartExitCode };
  const { open, publish } = await setup(t, { apps: { bell: manifest } });
  const c = await open();
  await c.login('admin', ADMIN_PASSWORD);
  await c.install('bell');
  const spawned = [];
  c.runner = new Runner({ paths: c.paths, log: quiet, spawnImpl: (exe, args, options) => {
    const child = new EventEmitter();
    child.pid = 1000 + spawned.length;
    spawned.push({ exe, options, child });
    return child;
  } });
  c.runner.on('exit', (id, info) => c._onAppExit(id, info));
  await c.launch('bell', { skipLegacyCheck: true });
  assert.equal(c.installed.bell.manifest.restartExitCode, restartExitCode);
  await publish('bell', '1.1.0', { restartExitCode: 43 });
  await c.refreshApps();
  await c.install('bell', { quiet: true });
  assert.equal(c.snapshot().apps.find((a) => a.id === 'bell').restartForUpdate, true);
  spawned[0].child.emit('exit', restartExitCode);
  await until(() => spawned.length === 2, 5000, '새 버전으로 다시 켜기');
  assert.equal(spawned[1].exe, path.join(c.installed.bell.dir, 'bin', 'app.sh'));
  assert.equal(c.runner.runningInfo('bell').version, '1.1.0');
  assert.equal(c.snapshot().apps.find((a) => a.id === 'bell').restartForUpdate, false);
  spawned[1].child.emit('exit', 0);
  await until(() => !c._syncing.bell);
});

for (const fail of [false, true]) test(`프로그램 재시작: 업데이트 중 종료 코드 75가 오면 재실행 ${fail ? '실패' : '성공'}까지 자체 설치하지 않음`, async (t) => {
  const { open, publish } = await setup(t);
  const c = await open();
  await c.login('admin', ADMIN_PASSWORD);
  await c.launch('bell', { skipLegacyCheck: true });
  await publish('bell', '1.1.0');
  await c.refreshApps();
  let quitCount = 0;
  const updater = new EventEmitter();
  updater.setFeedURL = () => {};
  updater.checkForUpdates = async () => {};
  updater.quitAndInstall = () => { quitCount += 1; };
  setupSelfUpdate({ app: { isPackaged: true, getVersion: () => '1.0.0', emit() {} }, cloud: c, updater, log: quiet, isWindowVisible: () => false });
  updater.emit('update-downloaded', { version: '1.1.0' });
  const install = c.installer.install.bind(c.installer);
  let finishDownload;
  const downloading = new Promise((resolve) => { finishDownload = resolve; });
  c.installer.install = async (...args) => {
    await downloading;
    return install(...args);
  };
  const update = c.install('bell', { quiet: true });
  await until(() => c.tasks.get('bell')?.kind === 'update');
  const userId = c.user.id;
  const launch = c.launch.bind(c);
  let attempted = false;
  c.launch = async (...args) => {
    attempted = true;
    if (fail) throw new Error('테스트 실행 실패');
    return launch(...args);
  };
  c.fake.running.delete('bell');
  c.runner.emit('exit', 'bell', { code: 75, restart: true, userId });
  finishDownload();
  await update;
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(quitCount, 0, '재실행을 기다리는 동안에도 자체 설치 금지');
  } finally {
    await until(() => attempted && !c.restarting.has('bell') && !c.tasks.has('bell'));
  }
  assert.equal(c.anyRunning(), !fail);
  if (!fail) assert.equal(c.fake.running.get('bell').version, '1.1.0');
  assert.equal(quitCount, 0);
});

test('사용 중지된 계정으로 켜기: 이상한 오류(null 의 id) 대신 사용 중지됐다고 알려 주고 켜지 않음', async (t) => {
  const { s, admin, mk, open } = await setup(t);
  await mk({ role: 'director', name: 'A원장', username: 'usera', academyName: 'A학원' });
  const u = await mk({ role: 'teacher', name: '김선생', username: 'teach1', academyName: 'A학원' });
  const c = await open();
  await c.login('teach1', 'pass1234');
  await c.install('bell');
  await s.request('POST', `/api/users/${u.id}/suspend`, { token: admin, body: {} });
  await assert.rejects(c.launch('bell', { skipLegacyCheck: true }), /사용이 중지된 계정/);
  assert.equal(c.fake.launched.length, 0);
  assert.equal(c.phase, 'login');
  assert.match(c.authMessage, /사용이 중지된 계정/);
});

test('목록을 받은 뒤 새 버전이 나와도 "그 버전은 받을 수 없어요" 대신 목록을 새로 받아 최신 버전으로 설치', async (t) => {
  const { open, publish } = await setup(t);
  const c = await open();
  await c.login('admin', ADMIN_PASSWORD);
  await c.install('bell');
  await publish('bell', '1.0.1');
  await c.refreshApps(); // 통합 클라우드의 목록: 1.0.1
  await publish('bell', '1.0.2'); // 서버는 이제 1.0.2 만 줌
  const inst = await c.install('bell', { quiet: true });
  assert.equal(inst.version, '1.0.2');
  assert.equal(c.apps.find((a) => a.id === 'bell').release.version, '1.0.2');
});

test('설정 파일 서명 키: 매니페스트에 dataSigning 이 있는 프로그램만 MAGOEDU_DATA_KEY 를 받음', async (t) => {
  const { s, open } = await setup(t, { apps: { bell: { dataSigning: true }, note: {} } });
  const c = await open();
  await c.login('admin', ADMIN_PASSWORD);
  await c.launch('bell', { skipLegacyCheck: true });
  await c.launch('note', { skipLegacyCheck: true });
  const token = await s.login('admin', ADMIN_PASSWORD, 'other-pc');
  const key = (await s.request('GET', '/api/me/data-key', { token })).data.dataKey;
  const env = Object.fromEntries(c.fake.launched.map((l) => [l.appId, l.env.MAGOEDU_DATA_KEY]));
  assert.deepEqual(env, { bell: key, note: '' });
  // 인터넷이 없을 때를 위해 로그인 정보와 함께 (암호화해서) 둠
  assert.equal(c.store.loadSession().dataKey, key);
  await c.logout();
  assert.equal(c.dataKey, null);
});

test('통합 클라우드를 다시 켜기 전에 켠 프로그램: 새 버전이 설치된 뒤 끝나면 새 버전으로 다시 켬', async (t) => {
  const { open, publish } = await setup(t);
  const c = await open();
  const me = await c.login('admin', ADMIN_PASSWORD);
  await c.install('bell');
  // 통합 클라우드를 다시 켜기 전에 1.0.0 으로 켜 둔 것
  c.adopted.set('bell', { pid: 50, userId: me.id, version: '1.0.0' });
  c._watchAdopted();
  assert.equal(c.fake.launched.length, 0, '그냥 끈 것이면 다시 켜지 않음');
  await publish('bell', '1.1.0');
  await c.refreshApps();
  await c.install('bell', { quiet: true });
  c.adopted.set('bell', { pid: 51, userId: me.id, version: '1.0.0' });
  c._watchAdopted(); // 종료 코드는 알 수 없지만, 켜져 있는 동안 새 버전이 설치됨
  await until(() => c.fake.launched.length === 1, 5000, '다시 켜기');
  assert.equal(c.fake.launched[0].appId, 'bell');
});
