'use strict';

// 웹에서 여는 바로 가기(magoedu://install·launch)가 쓰는 통합 클라우드 동작, 인터넷이 끊겼을 때 켜기, 브라우저 기기 알아보기

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { startServer, ADMIN_PASSWORD } = require('../../server/test/helpers');
const { makeZip } = require('./lib/zipwriter');
const { safeStorage } = require('./lib/safe-storage');
const { makePaths } = require('../src/core/paths');
const { Store } = require('../src/main/store');
const { Cloud } = require('../src/main/cloud');

const quiet = { info() {}, warn() {}, error() {} };
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `magoedu-${name}-`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, what = '조건') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`${what}: ${ms}ms 안에 되지 않았어요`);
    await sleep(40);
  }
}

test('브라우저 기기 알아보기: PC 처럼 보이는 안드로이드 태블릿·iPad 도', async (t) => {
  // 렌더러 파일은 ES 모듈이라 .mjs 로 복사해서 불러온다 (package.json 에 type 이 없어 나오는 경고를 피함)
  const dir = tmp('web');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'web-cloud.mjs');
  fs.copyFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'web-cloud.js'), file);
  const { detectClient } = await import(pathToFileURL(file).href);
  const d = (userAgent, extra = {}) => detectClient({ userAgent, maxTouchPoints: 0, ...extra });
  const pick = (c) => ({ os: c.os, mobile: c.mobile, canOpenApp: c.canOpenApp });
  const UA = {
    androidPhone: 'Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    androidTablet: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    cros: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  };
  const android = { os: 'android', mobile: true, canOpenApp: false };

  assert.deepEqual(pick(d(UA.androidPhone, { maxTouchPoints: 5 })), android);
  assert.deepEqual(pick(d(UA.androidTablet, { maxTouchPoints: 5 })), android, 'UA 에 Mobile 이 없는 태블릿');
  // 태블릿 Chrome 의 기본(데스크톱 사이트): "X11; Linux x86_64" + 터치
  assert.deepEqual(pick(d(UA.linux, { maxTouchPoints: 5 })), android);
  assert.deepEqual(pick(d(UA.linux, { maxTouchPoints: 5, userAgentData: { platform: 'Linux', mobile: false } })), android);
  assert.deepEqual(pick(d(UA.linux, { userAgentData: { platform: 'Android', mobile: false } })), android, 'platform 이 Android 면 터치가 없어도');
  assert.equal(d(UA.linux, { maxTouchPoints: 5 }).name, 'Chrome · Android');
  // 터치가 없는 리눅스 PC 는 그대로
  assert.deepEqual(pick(d(UA.linux)), { os: 'other', mobile: false, canOpenApp: false });
  assert.equal(d(UA.linux).name, 'Chrome · Linux');
  // 크롬북은 터치가 있어도 안드로이드가 아님
  assert.deepEqual(pick(d(UA.cros, { maxTouchPoints: 10 })), { os: 'other', mobile: false, canOpenApp: false });
  assert.equal(d(UA.cros, { maxTouchPoints: 10, userAgentData: { platform: 'Chrome OS', mobile: false } }).os, 'other');

  // iPadOS 는 Mac 처럼 보내지만 터치가 있음
  assert.deepEqual(pick(d(UA.mac, { maxTouchPoints: 5 })), { os: 'ios', mobile: true, canOpenApp: false });
  assert.equal(d(UA.mac, { maxTouchPoints: 5 }).name, 'Safari · iPad');
  assert.deepEqual(pick(d(UA.mac)), { os: 'mac', mobile: false, canOpenApp: false });
  assert.deepEqual(pick(d(UA.iphone, { maxTouchPoints: 5 })), { os: 'ios', mobile: true, canOpenApp: false });

  // Windows 는 터치 화면이어도 Windows (앱을 열 수 있음)
  assert.deepEqual(pick(d(UA.windows)), { os: 'windows', mobile: false, canOpenApp: true });
  assert.deepEqual(pick(d(UA.windows, { maxTouchPoints: 10 })), { os: 'windows', mobile: false, canOpenApp: true });
  assert.equal(d(UA.windows).name, 'Edge · Windows');
});

test('통합 클라우드: 웹의 ‘PC에 설치’, 인터넷이 끊겼을 때 켜기, 로그인 전에는 켜지 않음', async (t) => {
  const emptyCatalog = path.join(tmp('catalog'), 'catalog.json');
  fs.writeFileSync(emptyCatalog, '[]'); // 기본 목록(GitHub 아이콘)을 받으러 가지 않게
  const s = await startServer({ catalogFile: emptyCatalog });
  let serverUp = true;
  t.after(() => serverUp && s.close());
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const manifest = { format: 1, id: 'notes', exe: 'bin/notes.sh', sync: { include: ['**'] } };
  const notesZip = (version) => makeZip({ 'magoedu-app.json': JSON.stringify({ ...manifest, version }), 'bin/notes.sh': '#!/bin/sh\n' });
  const publish = async (id, file, body) => {
    fs.mkdirSync(path.join(s.dataDir, 'packages', id), { recursive: true });
    fs.writeFileSync(path.join(s.dataDir, 'packages', id, file), body);
    await s.request('POST', '/api/admin/apps/refresh', { token: admin, body: { id } });
  };
  await s.request('POST', '/api/admin/apps', { token: admin, body: { id: 'notes', name: '노트', source: { type: 'local' } } });
  await s.request('POST', '/api/admin/apps', { token: admin, body: { id: 'soon', name: '준비 중', source: { type: 'local' } } });
  await s.request('POST', '/api/admin/apps', {
    token: admin,
    body: { id: 'phone', name: '노트 (안드로이드)', platform: 'android', source: { type: 'local', asset: '^Phone-(\\d+\\.\\d+\\.\\d+)\\.apk$' } },
  });
  await publish('notes', 'Notes-1.0.0-win-x64.zip', notesZip('1.0.0'));
  await publish('phone', 'Phone-1.0.0.apk', Buffer.from('apk'));
  await s.request('POST', '/api/users', {
    token: admin,
    body: { role: 'teacher', name: '이선생', username: 'lee', password: 'pass1234', academyName: '마고', mustChangePassword: false },
  });

  // 이 컴퓨터. 켜는 것은 기록만 한다
  const root = tmp('cloud');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = makePaths({ userData: path.join(root, 'roaming'), localData: path.join(root, 'local') });
  const open = async (p = paths) => {
    const cloud = new Cloud({ paths: p, store: new Store({ paths: p, safeStorage, defaults: { serverUrl: s.base } }), version: '1.0.0', log: quiet });
    cloud.launched = [];
    cloud.toasts = [];
    cloud.runner.launch = ({ appId, env }) => cloud.launched.push({ appId, ticket: env.MAGOEDU_TICKET });
    cloud.on('toast', (x) => cloud.toasts.push(x));
    t.after(() => {
      cloud.shutdown();
      for (const id of [...cloud.watchers.keys()]) cloud._unwatch(id);
    });
    await cloud.init();
    return cloud;
  };

  const cloud = await open();
  await cloud.login('lee', 'pass1234');
  assert.equal(cloud.settled, true);

  await t.test('PC에 설치: 없으면 설치만 하고 켜지 않음', async () => {
    const r = await cloud.installFromLink('notes');
    assert.deepEqual(r, { installed: true, version: '1.0.0' });
    assert.equal(cloud.installed.notes.version, '1.0.0');
    assert.deepEqual(cloud.launched, []);
    assert.ok(cloud.toasts.some((x) => x.text === '노트을(를) 설치했어요'));
  });

  await t.test('PC에 설치: 이미 최신이면 알려만 줌', async () => {
    const r = await cloud.installFromLink('notes');
    assert.deepEqual(r, { already: true, version: '1.0.0' });
    assert.ok(cloud.toasts.some((x) => /이미 최신 버전\(1\.0\.0\)/.test(x.text)));
    assert.deepEqual(cloud.launched, []);
  });

  await t.test('PC에 설치: 새 버전이 있으면 업데이트', async () => {
    await publish('notes', 'Notes-1.1.0-win-x64.zip', notesZip('1.1.0'));
    await cloud.refreshApps();
    const r = await cloud.installFromLink('notes');
    assert.deepEqual(r, { installed: true, version: '1.1.0' });
    assert.equal(cloud.installed.notes.version, '1.1.0');
    assert.deepEqual(cloud.launched, []);
  });

  await t.test('PC에 설치: 안드로이드·배포 전·없는 프로그램은 거절', async () => {
    await assert.rejects(cloud.installFromLink('phone'), /휴대폰에서 내려받아/);
    await assert.rejects(cloud.installFromLink('soon'), /아직 배포된 버전이 없어요/);
    await assert.rejects(cloud.installFromLink('nope'), /찾을 수 없어요/);
    assert.equal(cloud.installed.phone, undefined);
  });

  await t.test('인터넷이 될 때 켜면 실행 허가를 보관해 둠', async () => {
    assert.deepEqual(await cloud.launch('notes'), { started: true });
    assert.equal(cloud.launched.length, 1);
    assert.ok(cloud.launched[0].ticket);
  });

  // 서버가 꺼진 뒤 통합 클라우드를 다시 켬 (저장된 로그인으로)
  const online = cloud.launched[0].ticket;
  cloud.shutdown();
  await s.close();
  serverUp = false;
  const offline = await open();

  await t.test('서버에 연결할 수 없으면 보관한 허가로 켬', async () => {
    assert.equal(offline.phase, 'ready', '저장된 로그인으로 바로 시작');
    await until(() => offline.settled, 8000, '목록 새로 고침 끝');
    assert.equal(offline.online, false);
    assert.ok(offline.apps.some((a) => a.id === 'notes'), '보관한 목록');
    assert.deepEqual(await offline.launch('notes'), { started: true });
    assert.deepEqual(offline.launched, [{ appId: 'notes', ticket: online }]);
  });

  await t.test('서버에 연결할 수 없고 보관한 허가도 없으면 켜지 않음', async () => {
    fs.rmSync(paths.account(offline.user.id).tickets, { recursive: true, force: true });
    await assert.rejects(offline.launch('notes'), /인터넷 없이 쓸 수 있는 기간도 지났어요/);
    assert.equal(offline.launched.length, 1);
  });

  await t.test('한 번도 로그인하지 않았으면 켜지도 설치하지도 않음', async () => {
    const p = makePaths({ userData: path.join(root, 'new-roaming'), localData: path.join(root, 'new-local') });
    const fresh = await open(p);
    assert.equal(fresh.phase, 'login');
    assert.equal(fresh.settled, false, 'magoedu:// 로 부른 것은 로그인할 때까지 기다림');
    await assert.rejects(fresh.launch('notes'), /로그인이 필요해요/);
    await assert.rejects(fresh.installFromLink('notes'), /로그인이 필요해요/);
    assert.deepEqual(fresh.launched, []);
    assert.deepEqual(Object.keys(fresh.installed), []);
  });
});
