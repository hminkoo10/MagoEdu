'use strict';

// 실시간 동기화(서버 알림 + 폴더 지켜보기), 바로 가기, 안드로이드 항목을 실제 서버와 함께 확인한다.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { startServer, ADMIN_PASSWORD } = require('../../server/test/helpers');
const { makeZip } = require('./lib/zipwriter');
const { ApiClient } = require('../src/core/api');
const { makePaths } = require('../src/core/paths');
const { SyncEngine } = require('../src/core/sync');
const { compileRules } = require('../src/core/rules');
const { EventStream, parseBlock } = require('../src/core/events');
const { Store } = require('../src/main/store');
const { Cloud } = require('../src/main/cloud');
const { Shortcuts } = require('../src/main/shortcuts');

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

test('알림 한 덩어리 읽기', () => {
  assert.deepEqual(parseBlock('event: change\ndata: {"appId":"a","seq":3,"deviceId":null}'), { event: 'change', data: { appId: 'a', seq: 3, deviceId: null } });
  assert.deepEqual(parseBlock('event: hello\r\ndata: {"time":"x"}\r'), { event: 'hello', data: { time: 'x' } });
  assert.equal(parseBlock(': ping'), null);
});

test('실시간 알림 연결: 끊기면 1초부터 두 배씩(많아야 30초) 다시, 로그인이 끝나면 멈춤', async (t) => {
  let fails = 3;
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(Date.now());
    if (req.headers.authorization === 'Bearer dead') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'session_invalid', message: '로그인이 끝났어요.' } }));
      return;
    }
    if (fails > 0) {
      fails -= 1;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.write('event: hello\ndata: {"time":"2026-11-01T00:00:00Z"}\n\n');
    res.write(': ping\n\nevent: change\ndata: {"appId":"notes","seq":7,"deviceId":"x"}\n\n');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => {
    srv.closeAllConnections();
    srv.close();
  });
  const base = `http://127.0.0.1:${srv.address().port}`;

  const st = new EventStream({ api: new ApiClient({ serverUrl: base, token: 'ok' }), minDelay: 40, maxDelay: 100, log: quiet });
  const waits = [];
  const wait = st._wait.bind(st);
  st._wait = (ms) => {
    waits.push(ms);
    return wait(ms);
  };
  const changes = [];
  st.on('change', (c) => changes.push(c));
  const hello = new Promise((r) => st.once('hello', r));
  st.start();
  await hello;
  await until(() => changes.length, 2000, 'change');
  st.stop();
  assert.deepEqual(changes[0], { appId: 'notes', seq: 7, deviceId: 'x' });
  assert.deepEqual(waits, [40, 80, 100], '두 배씩, 많아야 maxDelay');
  const gaps = hits.slice(1).map((h, i) => h - hits[i]);
  assert.equal(gaps.length, 3);
  gaps.forEach((g, i) => assert.ok(g >= waits[i] - 5, `기다린 간격 ${gaps}`));

  // 로그인이 끝남(401) → 다시 시도하지 않음
  const lost = [];
  const api = new ApiClient({ serverUrl: base, token: 'dead' });
  api.onAuthLost = (e) => lost.push(e.code);
  const dead = new EventStream({ api, minDelay: 20, log: quiet });
  const stopped = new Promise((r) => dead.once('stopped', r));
  const before = hits.length;
  dead.start();
  await stopped;
  await sleep(120);
  assert.equal(hits.length, before + 1);
  assert.deepEqual(lost, ['session_invalid'], '로그아웃 처리는 ApiClient.onAuthLost 가');
  assert.equal(dead.running, false);
});

test('통합 클라우드: 실시간 동기화·바로 가기·안드로이드 항목', async (t) => {
  const emptyCatalog = path.join(tmp('catalog'), 'catalog.json');
  fs.writeFileSync(emptyCatalog, '[]'); // 기본 목록(GitHub 아이콘)을 받으러 가지 않게
  const s = await startServer({ catalogFile: emptyCatalog });
  t.after(() => s.close());
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const manifest = { format: 1, id: 'notes', exe: 'bin/notes.sh', sync: { include: ['**'], exclude: ['**/*.tmp'] } };
  await s.request('POST', '/api/admin/apps', { token: admin, body: { id: 'notes', name: '노트', source: { type: 'local' } } });
  await s.request('POST', '/api/admin/apps', {
    token: admin,
    body: { id: 'phone', name: '노트 (안드로이드)', platform: 'android', source: { type: 'local', asset: '^Phone-(\\d+\\.\\d+\\.\\d+)\\.apk$' } },
  });
  for (const [id, file, body] of [
    ['notes', 'Notes-1.0.0-win-x64.zip', makeZip({ 'magoedu-app.json': JSON.stringify({ ...manifest, version: '1.0.0' }), 'bin/notes.sh': '#!/bin/sh\n' })],
    ['phone', 'Phone-1.0.0.apk', Buffer.from('apk')],
  ]) {
    fs.mkdirSync(path.join(s.dataDir, 'packages', id), { recursive: true });
    fs.writeFileSync(path.join(s.dataDir, 'packages', id, file), body);
    await s.request('POST', '/api/admin/apps/refresh', { token: admin, body: { id } });
  }
  await s.request('POST', '/api/users', {
    token: admin,
    body: { role: 'teacher', name: '이선생', username: 'lee', password: 'pass1234', academyName: '마고', mustChangePassword: false },
  });

  // 이 컴퓨터 (통합 클라우드)
  const root = tmp('cloud');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = makePaths({ userData: path.join(root, 'roaming'), localData: path.join(root, 'local') });
  const store = new Store({ paths, defaults: { serverUrl: s.base } });
  const links = { written: [], removed: [] };
  const shortcutDir = path.join(root, 'shortcuts');
  const exePath = path.join(root, 'MagoEduCloud.exe');
  const realShortcuts = new Shortcuts({
    exePath,
    desktopDir: path.join(shortcutDir, 'desktop'),
    startMenuDir: path.join(shortcutDir, 'start'),
    shell: {
      writeShortcutLink(file, _action, opts) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(opts));
        return true;
      },
      readShortcutLink: () => ({ target: exePath }),
    },
    log: quiet,
  });
  const shortcuts = {
    fileName: (name) => realShortcuts.fileName(name),
    exists: (name) => realShortcuts.exists(name),
    write: (o) => {
      links.written.push(o);
      return realShortcuts.write(o);
    },
    remove: (name) => {
      links.removed.push(name);
      return realShortcuts.remove(name);
    },
  };
  const cloud = new Cloud({ paths, store, version: '1.0.0', log: quiet, shortcuts });
  t.after(() => cloud.shutdown());
  await cloud.init();
  let readyEvents = 0;
  cloud.on('ready', () => {
    readyEvents += 1;
  });
  await cloud.login('lee', 'pass1234');
  assert.equal(cloud.settled, true, '로그인한 뒤 목록을 받으면 settled');
  assert.equal(readyEvents, 1);

  let runs = 0;
  const makeEngine = cloud._engine.bind(cloud);
  cloud._engine = (id) => {
    const e = makeEngine(id);
    if (e) {
      const run = e.run.bind(e);
      e.run = (...a) => {
        runs += 1;
        return run(...a);
      };
    }
    return e;
  };

  await t.test('설치하면 바로 가기 (아이콘은 설치한 exe), 동기화 폴더 지켜보기', async () => {
    const inst = await cloud.install('notes');
    assert.equal(links.written.length, 1);
    const w = links.written[0];
    assert.equal(w.id, 'notes');
    assert.equal(w.name, '노트');
    assert.equal(w.desktop, true, '바탕 화면은 기본으로 켬');
    assert.equal(w.icon, path.join(inst.dir, 'bin', 'notes.sh'));
    assert.deepEqual(store.config.shortcuts.notes, { desktop: true, startMenu: true, name: '노트.lnk' });
    assert.ok(cloud.watchers.has('notes'));
    assert.equal(cloud.snapshot().apps.find((a) => a.id === 'notes').desktopShortcut, true);
  });

  await until(() => cloud.events?.connected, 4000, '실시간 연결');
  const uid = cloud.user.id;
  const mine = paths.account(uid).app('notes').sync;
  const fa = (rel) => path.join(mine, ...rel.split('/'));

  // 다른 컴퓨터 (같은 아이디)
  const B = tmp('pcB');
  t.after(() => fs.rmSync(B, { recursive: true, force: true }));
  const apiB = new ApiClient({ serverUrl: s.base, device: { id: 'pcB-id', name: 'B', platform: 'test', version: '1' } });
  await apiB.login('lee', 'pass1234');
  const dirsB = makePaths({ userData: path.join(B, 'r'), localData: path.join(B, 'l') }).account(uid).app('notes');
  const engineB = new SyncEngine({ api: apiB, appId: 'notes', dirs: dirsB, rules: compileRules(manifest.sync), log: quiet });
  const fb = (rel) => path.join(dirsB.sync, ...rel.split('/'));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  await t.test('다른 컴퓨터에서 바꾸면 바로 받음 (5분을 기다리지 않음)', async () => {
    write(fb('config.json'), '{"from":"B"}');
    const r = await engineB.run();
    assert.equal(r.uploaded, 1);
    await until(() => fs.existsSync(fa('config.json')) && fs.readFileSync(fa('config.json'), 'utf8') === '{"from":"B"}', 5000, '받기');
    assert.ok(!fs.readdirSync(mine).some((n) => n.includes('.magoedu-dl')), '임시 파일은 남지 않음');
  });

  await t.test('이 컴퓨터에서 파일을 쓰면 1초쯤 뒤에 올림', async () => {
    write(fa('sounds/bell.wav'), 'RIFF');
    write(fa('scratch.tmp'), 'skip'); // 임시 파일은 올리지 않음
    await until(async () => (await apiB.get('/api/sync/notes')).entries.some((e) => e.path === 'sounds/bell.wav'), 6000, '올리기');
    await engineB.run();
    assert.equal(fs.readFileSync(fb('sounds/bell.wav'), 'utf8'), 'RIFF');
  });

  const idle = async () => {
    // 하던 동기화와 기다리는 동기화가 모두 끝날 때까지
    let calm = 0;
    await until(() => {
      calm = cloud.syncQueue.size || Object.keys(cloud._syncing).length || Object.keys(cloud._syncAgain).length ? 0 : calm + 1;
      return calm > 30;
    }, 10000, '잠잠해지기');
  };

  await t.test('받은 파일 때문에 다시 맞추기를 되풀이하지 않음', async () => {
    await idle();
    const before = runs;
    await sleep(2500);
    assert.equal(runs, before, `잠잠한 동안 동기화 ${runs - before}번`);
  });

  await t.test('서버 연결이 끊겼다 다시 붙으면 한 번 맞춤', async () => {
    await idle();
    let hellos = 0;
    cloud.events.on('hello', () => {
      hellos += 1;
    });
    const before = runs;
    s.app.deps.events.endAll();
    await until(() => hellos >= 1, 5000, '다시 연결');
    await until(() => runs > before, 3000, '다시 연결한 뒤 동기화');
  });

  await t.test('바탕 화면 바로 가기 끄기·켜기', async () => {
    links.written.length = 0;
    await cloud.setDesktopShortcut('notes', false);
    assert.equal(links.written[0].desktop, false);
    assert.equal(store.config.shortcuts.notes.desktop, false);
    assert.equal(cloud.snapshot().apps.find((a) => a.id === 'notes').desktopShortcut, false);
    await cloud.setDesktopShortcut('notes', true);
    assert.equal(links.written[1].desktop, true);
  });

  await t.test('지운 바로 가기는 업데이트 때 되살리지 않고, 다시 켜면 실제 파일을 만듦', async () => {
    const [desktop, startMenu] = realShortcuts._files('노트.lnk');
    fs.rmSync(desktop, { force: true });
    assert.equal(cloud._refreshShortcutState(), true);
    links.written.length = 0;
    cloud._writeShortcuts('notes');
    assert.equal(fs.existsSync(desktop), false);
    assert.equal(fs.existsSync(startMenu), true);
    assert.equal(cloud.snapshot().apps.find((a) => a.id === 'notes').desktopShortcut, false);
    assert.equal(store.config.shortcuts.notes.desktop, false);
    await cloud.setDesktopShortcut('notes', true);
    assert.equal(fs.existsSync(desktop), true);
    assert.equal(fs.existsSync(startMenu), true);
    assert.equal(cloud.snapshot().apps.find((a) => a.id === 'notes').desktopShortcut, true);
  });

  await t.test('안드로이드 항목은 설치·실행·동기화하지 않음', async () => {
    const view = cloud.snapshot().apps.find((a) => a.id === 'phone');
    assert.equal(view.platform, 'android');
    await assert.rejects(cloud.install('phone'), /휴대폰/);
    await assert.rejects(cloud.launch('phone'), /휴대폰/);
    assert.deepEqual(cloud._syncIds(), ['notes']);
    assert.equal(cloud.canLaunchNow('phone'), false);
    assert.equal(cloud.canLaunchNow('notes'), true);
    assert.ok(!fs.existsSync(paths.app('phone').root));
  });

  await t.test('삭제하면 바로 가기도 지우고 지켜보기도 멈춤', async () => {
    await cloud.uninstall('notes', { removeData: true });
    assert.deepEqual(links.removed, ['노트.lnk']);
    assert.equal(store.config.shortcuts.notes, undefined);
    assert.equal(cloud.watchers.size, 0);
    assert.ok(!fs.existsSync(mine), '지켜보던 폴더도 지울 수 있음');
  });

  await t.test('로그아웃하면 실시간 연결을 닫음', async () => {
    const hub = s.app.deps.events;
    assert.ok(hub.size >= 1);
    await cloud.logout();
    assert.equal(cloud.events, null);
    assert.equal(cloud.settled, false);
    await until(() => hub.size === 0, 3000, '서버 쪽 연결 정리');
  });
});
