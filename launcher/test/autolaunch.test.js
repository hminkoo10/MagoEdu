'use strict';

// '윈도우 시작 시 실행': 윈도우가 켜지면서 통합 클라우드가 켜졌을 때(--hidden)만 프로그램을 켠다

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

test('윈도우 시작 시 실행: 윈도우가 켜질 때만, 쓰는 중에 통합 클라우드를 열 때는 켜지 않음', async (t) => {
  const emptyCatalog = path.join(tmp('catalog'), 'catalog.json');
  fs.writeFileSync(emptyCatalog, '[]');
  const s = await startServer({ catalogFile: emptyCatalog });
  t.after(() => s.close());
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const manifest = { format: 1, id: 'bell', exe: 'bin/bell.sh', sync: { include: ['**'] } };
  await s.request('POST', '/api/admin/apps', { token: admin, body: { id: 'bell', name: '타종', source: { type: 'local' }, autoLaunchDefault: true } });
  fs.mkdirSync(path.join(s.dataDir, 'packages', 'bell'), { recursive: true });
  fs.writeFileSync(path.join(s.dataDir, 'packages', 'bell', 'Bell-1.0.0-win-x64.zip'), makeZip({ 'magoedu-app.json': JSON.stringify(manifest), 'bin/bell.sh': '#!/bin/sh\n' }));
  await s.request('POST', '/api/admin/apps/refresh', { token: admin, body: { id: 'bell' } });

  const root = tmp('cloud');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = makePaths({ userData: path.join(root, 'roaming'), localData: path.join(root, 'local') });
  // 켜는 것은 기록만 하고, 로그인 뒤 할 일(동기화·업데이트)이 끝났는지 표시한다
  const open = async (startedAtLogin) => {
    const cloud = new Cloud({ paths, store: new Store({ paths, defaults: { serverUrl: s.base } }), version: '1.0.0', log: quiet, startedAtLogin });
    cloud.launched = [];
    cloud.runner.launch = ({ appId }) => cloud.launched.push(appId);
    const autoUpdate = cloud._autoUpdate.bind(cloud);
    cloud.afterLogin = 0;
    cloud._autoUpdate = () => {
      autoUpdate();
      cloud.afterLogin++;
    };
    t.after(() => {
      cloud.shutdown();
      for (const id of [...cloud.watchers.keys()]) cloud._unwatch(id);
    });
    await cloud.init();
    return cloud;
  };

  // 처음: 로그인하고 설치
  const first = await open(false);
  await first.login('admin', ADMIN_PASSWORD);
  await first.install('bell');
  first.shutdown();

  await t.test('쓰는 중에 통합 클라우드를 열면 켜지 않음', async () => {
    const c = await open(false);
    await until(() => c.afterLogin === 1, 8000, '로그인 뒤 할 일');
    assert.deepEqual(c.launched, []);
    c.shutdown();
  });

  await t.test('윈도우가 켜지면서 통합 클라우드가 켜지면 한 번 켬, 다시 로그인해도 또 켜지 않음', async () => {
    const c = await open(true);
    await until(() => c.launched.length === 1, 8000, '자동 실행');
    assert.deepEqual(c.launched, ['bell']);
    await c.logout();
    await c.login('admin', ADMIN_PASSWORD);
    await until(() => c.afterLogin === 2, 8000, '다시 로그인한 뒤 할 일');
    assert.deepEqual(c.launched, ['bell']);
    c.shutdown();
  });

  await t.test('켜 두면 통합 클라우드의 윈도우 시작 시 실행도 켜짐', async () => {
    const c = await open(false);
    await until(() => c.afterLogin === 1, 8000, '로그인 뒤 할 일');
    c.setConfig({ autoStart: false });
    const config = [];
    c.on('config', (cfg) => config.push(cfg.autoStart));
    c.setAutoLaunch('bell', false);
    assert.equal(c.store.config.autoStart, false, '끌 때는 그대로');
    c.setAutoLaunch('bell', true);
    assert.equal(c.store.config.autoStart, true);
    assert.deepEqual(config, [true], '윈도우 시작 프로그램 등록을 다시 하게 알림');
    c.shutdown();
  });
});
