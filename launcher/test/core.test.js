'use strict';

// 통합 클라우드 프로그램의 핵심 기능을 실제 서버와 함께 확인한다.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startServer, ADMIN_PASSWORD } = require('../../server/test/helpers');
const { makeZip } = require('./lib/zipwriter');
const { safeStorage } = require('./lib/safe-storage');
const { Store } = require('../src/main/store');
const { ApiClient } = require('../src/core/api');
const { makePaths } = require('../src/core/paths');
const { Installer } = require('../src/core/installer');
const { SyncEngine } = require('../src/core/sync');
const { compileRules, globToRegExp } = require('../src/core/rules');
const { detectLegacy, importLegacy } = require('../src/core/legacy');
const { verifyTicket, writeTrust, TicketStore } = require('../src/core/tickets');
const { Runner, buildEnv } = require('../src/core/runner');

const DAY = 24 * 60 * 60 * 1000;
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `magoedu-${name}-`));
const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const read = (file) => fs.readFileSync(file, 'utf8');

test('규칙: 포함·제외·묶음', () => {
  assert.ok(globToRegExp('data/**').test('data/projects/a/b.pdf'));
  assert.ok(globToRegExp('**/*.tmp').test('x.tmp'));
  assert.ok(globToRegExp('**/*.tmp').test('a/b/x.tmp'));
  assert.ok(!globToRegExp('data/*').test('data/a/b'));
  const r = compileRules({ include: ['data/**', 'config.json'], exclude: ['**/*.tmp'], groups: [{ pattern: 'data/projects/*', cold: true }] });
  assert.ok(r.wants('data/projects/p1/project.json'));
  assert.ok(r.wants('config.json'));
  assert.ok(!r.wants('cache/x'));
  assert.ok(!r.wants('data/a.tmp'));
  assert.ok(!r.wants('data/a.pdf.magoedu-dl'), '통합 클라우드 임시 파일은 언제나 뺌');
  assert.equal(r.groupOf('data/projects/p1/problem.pdf'), 'data/projects/p1');
  assert.equal(r.groupOf('data/projects/p1'), '', '묶음 폴더 안의 파일만');
  assert.equal(r.groupOf('data/settings.json'), '');
});

test('통합 클라우드 핵심: 설치·동기화·보관 기간·예전 데이터·실행', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  const admin = await s.login('admin', ADMIN_PASSWORD);
  await s.request('POST', '/api/admin/apps', {
    token: admin,
    body: { id: 'notes', name: '노트', source: { type: 'local' }, coldStorage: { enabled: true, days: 30 } },
  });
  await s.request('POST', '/api/users', {
    token: admin,
    body: { role: 'teacher', name: '이선생', username: 'lee', password: 'pass1234', academyName: '마고', mustChangePassword: false },
  });

  const manifest = {
    format: 1,
    id: 'notes',
    exe: 'bin/notes.sh',
    stopArgs: ['--quit'],
    sync: { include: ['data/**'], exclude: ['**/*.tmp'], groups: [{ pattern: 'data/projects/*', cold: true }] },
    legacy: [{ id: 'old', label: '예전 노트', from: '{APPDATA}/OldNotes/data', to: 'sync/data' }],
  };
  const exeScript = '#!/bin/sh\nenv | grep ^MAGOEDU_ > "$MAGOEDU_LOCAL_DIR/env.txt"\nexit ${EXIT_CODE:-0}\n';
  const pkgDir = path.join(s.dataDir, 'packages', 'notes');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'Notes-1.0.0-win-x64.zip'),
    makeZip({ 'Notes/magoedu-app.json': JSON.stringify({ ...manifest, version: '1.0.0' }), 'Notes/bin/notes.sh': exeScript, 'Notes/res/a.txt': 'v1' }),
  );
  await s.request('POST', '/api/admin/apps/refresh', { token: admin, body: { id: 'notes' } });

  // 컴퓨터 두 대 (같은 아이디)
  function pc(name) {
    const root = tmp(name);
    const paths = makePaths({ userData: path.join(root, 'roaming'), localData: path.join(root, 'local') });
    const api = new ApiClient({ serverUrl: s.base, device: { id: `${name}-id`, name, platform: 'test', version: '1.0.0' } });
    return { name, root, paths, api };
  }
  const A = pc('pcA');
  const B = pc('pcB');
  t.after(() => {
    fs.rmSync(A.root, { recursive: true, force: true });
    fs.rmSync(B.root, { recursive: true, force: true });
  });
  const loginA = await A.api.login('lee', 'pass1234');
  await B.api.login('lee', 'pass1234');
  const uid = loginA.user.id;

  let installed;
  await t.test('설치 (zip 을 받아 확인하고 풀기)', async () => {
    const inst = new Installer({ paths: A.paths, log: { warn() {} } });
    const { apps } = await A.api.get('/api/apps');
    const app = apps.find((a) => a.id === 'notes');
    const steps = [];
    installed = await inst.install(A.api, app, { onProgress: (p) => steps.push(p.phase) });
    assert.equal(installed.version, '1.0.0');
    assert.ok(steps.includes('download') && steps.includes('extract'));
    assert.equal(read(path.join(installed.dir, 'res', 'a.txt')), 'v1', '상위 폴더(Notes/)는 벗겨 냄');
    assert.equal(installed.manifest.exe, 'bin/notes.sh');
    assert.deepEqual(installed.manifest.stopArgs, ['--quit']);
    assert.deepEqual(JSON.parse(read(A.paths.app('notes').installed)).manifest.stopArgs, ['--quit']);
    assert.deepEqual(Object.keys(await inst.listInstalled()), ['notes']);
  });

  await t.test('업데이트: 새 버전을 옆에 풀고 예전 버전은 정리', async () => {
    fs.writeFileSync(
      path.join(pkgDir, 'Notes-1.1.0-win-x64.zip'),
      makeZip({ 'magoedu-app.json': JSON.stringify({ ...manifest, version: '1.1.0' }), 'bin/notes.sh': exeScript, 'res/a.txt': 'v2' }),
    );
    await s.request('POST', '/api/admin/apps/refresh', { token: admin, body: { id: 'notes' } });
    const inst = new Installer({ paths: A.paths, log: { warn() {} } });
    const app = (await A.api.get('/api/apps')).apps.find((a) => a.id === 'notes');
    assert.ok(inst.needsUpdate(installed, app));
    installed = await inst.install(A.api, app);
    assert.equal(installed.version, '1.1.0');
    assert.equal(read(path.join(installed.dir, 'res', 'a.txt')), 'v2');
    assert.ok(!fs.existsSync(path.join(A.paths.app('notes').root, '1.0.0')));
    assert.ok(!inst.needsUpdate(installed, app));
  });

  const engine = (P) => {
    const dirs = P.paths.account(uid).app('notes');
    return { dirs, sync: new SyncEngine({ api: P.api, appId: 'notes', dirs, rules: compileRules(manifest.sync), log: { warn() {} } }) };
  };
  const a = engine(A);
  const b = engine(B);
  const fa = (rel) => path.join(a.dirs.sync, ...rel.split('/'));
  const fb = (rel) => path.join(b.dirs.sync, ...rel.split('/'));

  await t.test('같은 아이디면 다른 컴퓨터에도 그대로', async () => {
    write(fa('data/settings.json'), '{"theme":"orange"}');
    write(fa('data/projects/p1/project.json'), '{"name":"쎈"}');
    write(fa('data/projects/p1/problem.pdf'), Buffer.alloc(20000, 1));
    write(fa('data/tmp.tmp'), 'skip');
    write(fa('other/ignored.txt'), 'skip');
    const r1 = await a.sync.run();
    assert.equal(r1.uploaded, 3);
    const r2 = await b.sync.run();
    assert.equal(r2.downloaded, 3);
    assert.equal(read(fb('data/projects/p1/project.json')), '{"name":"쎈"}');
    assert.ok(!fs.existsSync(fb('data/tmp.tmp')));
    const again = await a.sync.run();
    assert.deepEqual([again.uploaded, again.downloaded], [0, 0], '바뀐 게 없으면 아무것도 안 함');
  });

  await t.test('고친 것과 지운 것도 따라감', async () => {
    write(fb('data/settings.json'), '{"theme":"dark"}');
    fs.rmSync(fb('data/projects/p1/problem.pdf'));
    const r = await b.sync.run();
    assert.deepEqual([r.uploaded, r.deletedRemote], [1, 1]);
    const ra = await a.sync.run();
    assert.deepEqual([ra.downloaded, ra.deletedLocal], [1, 1]);
    assert.equal(read(fa('data/settings.json')), '{"theme":"dark"}');
    assert.ok(!fs.existsSync(fa('data/projects/p1/problem.pdf')));
  });

  await t.test('같은 내용을 복사하면 다시 보내지 않음', async () => {
    write(fa('data/projects/p1/answer.pdf'), Buffer.alloc(5000, 9));
    await a.sync.run();
    write(fa('data/projects/p1/answer-copy.pdf'), Buffer.alloc(5000, 9));
    const r = await a.sync.run();
    assert.equal(r.uploaded, 1);
    await b.sync.run();
    assert.equal(fs.statSync(fb('data/projects/p1/answer-copy.pdf')).size, 5000);
  });

  await t.test('두 컴퓨터에서 동시에 고치면 서버 것을 쓰고 내 것은 보관', async () => {
    write(fa('data/settings.json'), '{"from":"A"}');
    write(fb('data/settings.json'), '{"from":"B"}');
    await a.sync.run();
    const r = await b.sync.run();
    assert.deepEqual(r.conflicts, ['data/settings.json']);
    assert.equal(read(fb('data/settings.json')), '{"from":"A"}');
    const kept = fs.readdirSync(b.dirs.conflicts);
    assert.equal(read(path.join(b.dirs.conflicts, kept[0], 'data', 'settings.json')), '{"from":"B"}', '밀려난 내 파일은 conflicts 에 남음');
  });

  await t.test('보관 기간이 지나면 서버에서만 지우고, 다시 쓰면 다시 올라감', async () => {
    write(fa('data/projects/old/project.json'), '{"name":"작년 교재"}');
    write(fa('data/projects/old/problem.pdf'), Buffer.alloc(30000, 3));
    await a.sync.run();
    await b.sync.run();
    const db = s.app.deps.db;
    db.run("UPDATE files SET updated_at = ? WHERE path LIKE 'data/projects/old/%'", Date.now() - 40 * DAY);
    db.run("UPDATE group_activity SET last_used_at = ? WHERE grp = 'data/projects/old'", Date.now() - 40 * DAY);
    const cold = s.app.deps.jobs.runColdStorage();
    assert.equal(cold.groups, 1);

    const ra = await a.sync.run();
    assert.equal(ra.deletedLocal, 0, '내 컴퓨터 파일은 지우지 않음');
    assert.ok(fs.existsSync(fa('data/projects/old/problem.pdf')));
    assert.deepEqual([ra.localOnly.files, ra.localOnly.groups], [2, 1]);

    // 새 컴퓨터는 받을 수 없음 (서버에 없으니)
    const C = pc('pcC');
    t.after(() => fs.rmSync(C.root, { recursive: true, force: true }));
    await C.api.login('lee', 'pass1234');
    const c = engine(C);
    const rc = await c.sync.run();
    assert.ok(!fs.existsSync(path.join(c.dirs.sync, 'data', 'projects', 'old', 'problem.pdf')));
    assert.ok(fs.existsSync(path.join(c.dirs.sync, 'data', 'projects', 'p1', 'project.json')));
    assert.equal(rc.errors.length, 0);

    // A 에서 다시 열어서 고침 → 묶음 전체가 다시 올라감 → C 도 받음
    write(fa('data/projects/old/project.json'), '{"name":"작년 교재","openedAt":1}');
    const again = await a.sync.run();
    assert.equal(again.uploaded, 2, '고친 파일 + 이 컴퓨터에만 있던 파일');
    assert.equal(again.localOnly.files, 0);
    await c.sync.run();
    assert.equal(fs.statSync(path.join(c.dirs.sync, 'data', 'projects', 'old', 'problem.pdf')).size, 30000);
  });

  await t.test('서버 용량이 꽉 차면 올리기만 멈춤', async () => {
    const list = await s.request('GET', '/api/users?q=lee', { token: admin });
    await s.request('PATCH', `/api/users/${list.data.users[0].id}`, { token: admin, body: { quotaMb: 0 } });
    // 0 = 제한 없음 → 1MB 로 줄이고 큰 파일
    await s.request('PATCH', `/api/users/${list.data.users[0].id}`, { token: admin, body: { quotaMb: 1 } });
    write(fa('data/projects/big/huge.pdf'), Buffer.alloc(2 * 1024 * 1024, 5));
    const r = await a.sync.run();
    assert.equal(r.quotaExceeded, true);
    assert.equal(r.quotaBytes, 1024 * 1024);
    fs.rmSync(path.join(a.dirs.sync, 'data', 'projects', 'big'), { recursive: true });
    await s.request('PATCH', `/api/users/${list.data.users[0].id}`, { token: admin, body: { quotaMb: null } });
  });

  await t.test('예전에 따로 설치해 쓰던 데이터 가져오기', async () => {
    const fakeAppData = tmp('appdata');
    t.after(() => fs.rmSync(fakeAppData, { recursive: true, force: true }));
    write(path.join(fakeAppData, 'OldNotes', 'data', 'projects', 'legacy1', 'project.json'), '{"name":"예전"}');
    write(path.join(fakeAppData, 'OldNotes', 'data', 'settings.json'), '{"old":true}');
    const env = { APPDATA: fakeAppData };
    const m = installed.manifest;
    const found = await detectLegacy(m, { appDirs: a.dirs, pcMarkerFile: A.paths.legacyFile, env });
    assert.equal(found.length, 1);
    assert.equal(found[0].files, 2);
    assert.equal(found[0].importedHere, false);
    const r = await importLegacy(m, 'old', { appDirs: a.dirs, pcMarkerFile: A.paths.legacyFile, accountLabel: '이선생 (lee)', env });
    assert.deepEqual([r.copied, r.skipped], [1, 1], '이미 있는 settings.json 은 덮어쓰지 않음');
    assert.equal(read(fa('data/projects/legacy1/project.json')), '{"name":"예전"}');
    const after = await detectLegacy(m, { appDirs: a.dirs, pcMarkerFile: A.paths.legacyFile, env });
    assert.equal(after[0].importedHere, true);
    assert.equal(after[0].importedBy, '이선생 (lee)');
    const sync = await a.sync.run();
    assert.equal(sync.uploaded, 1, '가져온 데이터는 서버로 올라감');
  });

  await t.test('실행 허가증과 실행', async () => {
    const meta = await A.api.meta();
    await writeTrust(A.paths.trustFile, { serverUrl: s.base, serverId: meta.serverId, keys: meta.keys });
    const { ticket, expiresAt } = await A.api.post('/api/apps/notes/ticket', {});
    const payload = verifyTicket(meta.keys, ticket, { appId: 'notes' });
    assert.equal(payload.sub, uid);
    assert.equal(verifyTicket(meta.keys, ticket, { appId: 'other' }), null);
    const store = new TicketStore(A.paths.account(uid).tickets, new Store({ paths: A.paths, safeStorage }));
    await store.put('notes', ticket, expiresAt);
    assert.equal((await store.get('notes', meta.keys)).ticket, ticket);

    if (process.platform === 'win32') return;
    const runner = new Runner({ paths: A.paths, log: { warn() {} } });
    fs.mkdirSync(a.dirs.local, { recursive: true });
    const env = buildEnv({
      ticket,
      appId: 'notes',
      user: loginA.user,
      appDirs: a.dirs,
      serverUrl: s.base,
      launcherVersion: '1.0.0',
      trustFile: A.paths.trustFile,
      base: { PATH: process.env.PATH, EXIT_CODE: '75' },
    });
    const exited = new Promise((resolve) => runner.once('exit', (id, info) => resolve(info)));
    runner.launch({ appId: 'notes', installed, env });
    assert.equal(runner.isRunning('notes'), true);
    const info = await exited;
    assert.equal(info.code, 75);
    assert.equal(info.restart, true, '75 로 끝나면 다시 켜 달라는 뜻');
    assert.equal(runner.isRunning('notes'), false);
    const got = read(path.join(a.dirs.local, 'env.txt'));
    assert.match(got, /MAGOEDU_TICKET=MGT1\./);
    assert.match(got, new RegExp(`MAGOEDU_DATA_DIR=${a.dirs.sync.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
    assert.match(got, /MAGOEDU_USERNAME=lee/);
  });

  await t.test('삭제', async () => {
    const inst = new Installer({ paths: A.paths, log: { warn() {} } });
    await inst.uninstall('notes');
    assert.equal(await inst.installed('notes'), null);
    assert.ok(fs.existsSync(fa('data/settings.json')), '프로그램을 지워도 데이터는 남음');
  });
});

test('끄기: 창 닫기로 안 꺼지면 잠시 뒤 강제로 끔 (트레이로 숨는 프로그램)', async () => {
  const dir = tmp('stop');
  const runner = new Runner({ paths: { app: () => ({ running: path.join(dir, 'running.json') }) }, log: { warn() {} } });
  // 닫기 신호를 무시하는 프로그램
  const child = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('spawn', resolve));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  runner.running.set('stubborn', { pid: child.pid });
  assert.equal(runner.stop('stubborn', { graceMs: 300 }), true);
  await exited;
  fs.rmSync(dir, { recursive: true, force: true });
});
