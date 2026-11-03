'use strict';

// 계정을 바꾸면 예전 계정으로 켠 프로그램을 끔, 사용 중지된 계정으로 켜기, 목록을 받은 뒤 새 버전이 나옴,
// 설정 파일 서명 키(dataSigning), 통합 클라우드를 다시 켠 뒤 새 버전으로 다시 켜기

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startServer, ADMIN_PASSWORD } = require('../../server/test/helpers');
const { makeZip } = require('./lib/zipwriter');
const { makePaths } = require('../src/core/paths');
const { Store } = require('../src/main/store');
const { Cloud } = require('../src/main/cloud');

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
  const open = async () => {
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
