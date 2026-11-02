'use strict';

// 학원 공간: 같은 학원 사람들이 함께 쓰는 파일을 실제 서버와 함께 확인한다.
//   - 열 때만 받는 파일(shared.lazy)은 달라고 할 때만 받음
//   - 고칠 권한이 없는 파일은 서버 것으로 되돌림 (내 것은 conflicts 에 보관)
//   - 통합 클라우드: 실시간 알림(scope: 'academy')·요청 파일·실행 환경 변수

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startServer, ADMIN_PASSWORD } = require('../../server/test/helpers');
const { makeZip } = require('./lib/zipwriter');
const { ApiClient } = require('../src/core/api');
const { makePaths } = require('../src/core/paths');
const { SyncEngine } = require('../src/core/sync');
const { compileRules } = require('../src/core/rules');
const { normalizeManifest } = require('../src/core/manifest');
const { buildEnv } = require('../src/core/runner');
const { Store } = require('../src/main/store');
const { Cloud } = require('../src/main/cloud');
const sdk = require('../../sdk/node/magoedu-cloud');

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

const MANIFEST = {
  format: 1,
  id: 'notes',
  exe: 'bin/notes.sh',
  sync: { include: ['settings.json'] },
  shared: { include: ['**'], lazy: ['books/*/*.pdf'] },
};

/** 서버 + 같은 학원의 원장·선생님 둘 */
async function academyServer(t) {
  const catalog = path.join(tmp('catalog'), 'catalog.json');
  fs.writeFileSync(catalog, '[]');
  const s = await startServer({ catalogFile: catalog });
  t.after(() => s.close());
  const admin = await s.login('admin', ADMIN_PASSWORD);
  await s.request('POST', '/api/admin/apps', { token: admin, body: { id: 'notes', name: '노트', source: { type: 'local' } } });
  fs.mkdirSync(path.join(s.dataDir, 'packages', 'notes'), { recursive: true });
  fs.writeFileSync(
    path.join(s.dataDir, 'packages', 'notes', 'Notes-1.0.0-win-x64.zip'),
    makeZip({ 'magoedu-app.json': JSON.stringify({ ...MANIFEST, version: '1.0.0' }), 'bin/notes.sh': '#!/bin/sh\n' }),
  );
  await s.request('POST', '/api/admin/apps/refresh', { token: admin, body: { id: 'notes' } });
  const mk = async (token, body) => {
    const r = await s.request('POST', '/api/users', { token, body: { password: 'pass1234', mustChangePassword: false, ...body } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.user;
  };
  await mk(admin, { role: 'director', name: '원장', username: 'boss', academyName: '마고' });
  const boss = await s.login('boss', 'pass1234');
  await mk(boss, { name: '김선생', username: 'kim' });
  await mk(boss, { name: '이선생', username: 'lee' });
  return s;
}

test('학원 공간 엔진: 열 때만 받기·권한 없는 파일 되돌리기·members', async (t) => {
  const s = await academyServer(t);
  const root = tmp('academy');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  /** 컴퓨터 한 대 (계정 하나) */
  async function pc(username) {
    const api = new ApiClient({ serverUrl: s.base, device: { id: `${username}-pc`, name: username, platform: 'test', version: '1' } });
    const { user } = await api.login(username, 'pass1234');
    const dirs = makePaths({ userData: path.join(root, username, 'r'), localData: path.join(root, username, 'l') }).account(user.id).app('notes');
    const engine = new SyncEngine({
      api,
      appId: 'notes',
      base: '/api/sync/notes/academy',
      dirs: { sync: dirs.academy, conflicts: dirs.academyConflicts, state: dirs.academyState },
      rules: compileRules(normalizeManifest(MANIFEST).shared),
      log: quiet,
    });
    const f = (rel) => path.join(dirs.academy, ...rel.split('/'));
    return {
      api,
      user,
      dirs,
      run: (o) => engine.run(o),
      has: (rel) => fs.existsSync(f(rel)),
      read: (rel) => fs.readFileSync(f(rel), 'utf8'),
      write: (rel, text) => {
        fs.mkdirSync(path.dirname(f(rel)), { recursive: true });
        fs.writeFileSync(f(rel), text);
      },
      rm: (rel) => fs.rmSync(f(rel)),
      kept: () => {
        // conflicts/academy/<시각>/<경로> 에 보관한 것
        const out = [];
        const walk = (d, rel) => {
          for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
            if (e.isDirectory()) walk(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name);
            else out.push([rel.split('/').slice(1).concat(e.name).join('/'), fs.readFileSync(path.join(d, e.name), 'utf8')]);
          }
        };
        walk(dirs.academyConflicts, '');
        return out.sort();
      },
    };
  }
  const kim = await pc('kim');
  const lee = await pc('lee');
  const boss = await pc('boss');

  await t.test('교재 PDF 는 달라고 할 때만 받고, 받은 뒤로는 계속 맞춤', async () => {
    kim.write('books/b1/book.json', '{"name":"쎈 수학"}');
    kim.write('books/b1/p1.pdf', 'PDF-1');
    assert.equal((await kim.run()).uploaded, 2);

    const r = await lee.run();
    assert.equal(r.downloaded, 1);
    assert.equal(lee.read('books/b1/book.json'), '{"name":"쎈 수학"}');
    assert.ok(!lee.has('books/b1/p1.pdf'), 'PDF 는 아직 받지 않음');
    assert.deepEqual(r.missing, []);

    const want = await lee.run({ want: new Set(['books/b1/p1.pdf', 'books/b1/none.pdf']) });
    assert.equal(lee.read('books/b1/p1.pdf'), 'PDF-1');
    assert.deepEqual(want.missing, ['books/b1/none.pdf'], '서버에 없는 것은 받지 못함');

    kim.write('books/b1/p1.pdf', 'PDF-1 고침');
    await kim.run();
    await lee.run();
    assert.equal(lee.read('books/b1/p1.pdf'), 'PDF-1 고침', '한 번 받은 PDF 는 보통 파일처럼');
  });

  await t.test('만든 사람이 아니면 서버 것으로 되돌리고 내 것은 보관', async () => {
    lee.write('books/b1/book.json', '{"name":"몰래 고침"}');
    lee.write('books/b1/extra.json', '{"x":1}');
    const r = await lee.run();
    assert.deepEqual(r.reverted.sort(), ['books/b1/book.json', 'books/b1/extra.json']);
    assert.deepEqual(r.errors, []);
    assert.equal(lee.read('books/b1/book.json'), '{"name":"쎈 수학"}', '서버 것으로');
    assert.ok(!lee.has('books/b1/extra.json'), '서버에 없는 것은 지움');
    assert.deepEqual(lee.kept(), [
      ['books/b1/book.json', '{"name":"몰래 고침"}'],
      ['books/b1/extra.json', '{"x":1}'],
    ]);
    const list = (await kim.api.get('/api/sync/notes/academy')).entries;
    assert.ok(!list.some((e) => e.path === 'books/b1/extra.json'));

    lee.rm('books/b1/book.json');
    const d = await lee.run();
    assert.deepEqual(d.reverted, ['books/b1/book.json'], '지워도 되살림');
    assert.equal(lee.read('books/b1/book.json'), '{"name":"쎈 수학"}');

    const again = await lee.run();
    assert.equal(again.reverted.length + again.uploaded + again.downloaded, 0, '되돌린 뒤에는 조용함');
  });

  await t.test('원장은 남의 교재도 고침, 선생님은 새 교재를 만듦', async () => {
    await boss.run();
    boss.write('books/b1/book.json', '{"name":"쎈 수학 (원장)"}');
    assert.equal((await boss.run()).uploaded, 1);
    lee.write('books/b2/book.json', '{"name":"이선생 교재"}');
    assert.equal((await lee.run()).uploaded, 1);
    await kim.run();
    assert.equal(kim.read('books/b1/book.json'), '{"name":"쎈 수학 (원장)"}');
    assert.equal(kim.read('books/b2/book.json'), '{"name":"이선생 교재"}');
  });

  await t.test('members/<내 계정>: 나와 원장만 받음', async () => {
    const note = `members/${lee.user.id}/notes/n1.json`;
    lee.write(note, '{"student":"철수"}');
    assert.equal((await lee.run()).uploaded, 1);
    await kim.run();
    assert.ok(!kim.has(note), '다른 선생님은 받지 않음');
    await boss.run();
    assert.equal(boss.read(note), '{"student":"철수"}', '원장은 받음');
    boss.write(note, '{"student":"영희"}');
    assert.deepEqual((await boss.run()).reverted, [note], '원장도 남의 노트는 못 고침');
    assert.equal(boss.read(note), '{"student":"철수"}');
  });

  await t.test('받지 않은 원본은 받지 않은 채로 서버에서 지움 (drop)', async () => {
    kim.write('books/b5/book.json', '{"name":"지울 교재"}');
    kim.write('books/b5/p.pdf', 'PDF-5');
    await kim.run();
    await boss.run();
    assert.ok(boss.has('books/b5/book.json') && !boss.has('books/b5/p.pdf'));
    boss.rm('books/b5/book.json');
    const r = await boss.run({ drop: new Set(['books/b5/p.pdf']) });
    assert.equal(r.deletedRemote, 2);
    assert.deepEqual(r.missing, []);
    assert.ok(!boss.has('books/b5/p.pdf'), '지우려고 받지는 않음');
    const left = (await kim.api.get('/api/sync/notes/academy')).entries.filter((e) => e.path.startsWith('books/b5/') && !e.deleted);
    assert.deepEqual(left, []);
    await kim.run();
    assert.ok(!kim.has('books/b5/p.pdf'), '주인 컴퓨터에서도 지워짐');
  });

  await t.test('개인 공간과는 따로', async () => {
    const mine = (await kim.api.get('/api/sync/notes')).entries;
    assert.deepEqual(mine, []);
  });
});

test('통합 클라우드: 학원 공간 실시간·요청 파일·실행 환경 변수', async (t) => {
  const s = await academyServer(t);
  const root = tmp('cloud');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = makePaths({ userData: path.join(root, 'roaming'), localData: path.join(root, 'local') });
  const store = new Store({ paths, defaults: { serverUrl: s.base } });
  const cloud = new Cloud({ paths, store, version: '1.0.0', log: quiet });
  t.after(() => cloud.shutdown());
  await cloud.init();
  await cloud.login('kim', 'pass1234');
  await cloud.install('notes');
  await until(() => cloud.events?.connected, 4000, '실시간 연결');
  const dirs = paths.account(cloud.user.id).app('notes');
  const mine = (rel) => path.join(dirs.academy, ...rel.split('/'));

  // 같은 학원의 다른 선생님 컴퓨터
  const apiLee = new ApiClient({ serverUrl: s.base, device: { id: 'lee-pc', name: 'lee', platform: 'test', version: '1' } });
  await apiLee.login('lee', 'pass1234');
  const put = (p, body) => apiLee.request('PUT', `/api/sync/notes/academy/file?path=${encodeURIComponent(p)}&baseRev=0`, { body: Buffer.from(body) });

  await t.test('동기화 폴더·학원 공간·요청 폴더를 지켜봄', () => {
    assert.equal(cloud.watchers.get('notes').length, 3);
  });

  await t.test('다른 선생님이 만든 교재가 바로 옴 (PDF 는 빼고)', async () => {
    await put('books/b9/book.json', '{"name":"새 교재"}');
    await put('books/b9/p1.pdf', 'PDF-9');
    await until(() => fs.existsSync(mine('books/b9/book.json')), 5000, '실시간으로 받기');
    assert.equal(fs.readFileSync(mine('books/b9/book.json'), 'utf8'), '{"name":"새 교재"}');
    await until(() => !Object.keys(cloud._syncing).length && !cloud.syncQueue.size, 5000, '동기화 끝');
    assert.ok(!fs.existsSync(mine('books/b9/p1.pdf')));
    assert.ok(cloud.syncInfo.notes.academySeq > 0);
  });

  await t.test('프로그램이 요청 파일을 쓰면 그 파일을 받고 답함 (SDK requestFiles)', async () => {
    const session = { academyDir: dirs.academy, requestDir: dirs.requests };
    const r = await sdk.requestFiles(session, ['books/b9/p1.pdf', 'books/b9/없음.pdf'], { timeoutMs: 8000 });
    assert.deepEqual(r, { ok: false, missing: ['books/b9/없음.pdf'] });
    assert.equal(fs.readFileSync(mine('books/b9/p1.pdf'), 'utf8'), 'PDF-9');
    assert.deepEqual(fs.readdirSync(dirs.requests), [], '요청·답 모두 정리');
    assert.deepEqual(await sdk.requestFiles(session, ['books/b9/p1.pdf'], { timeoutMs: 1000 }), { ok: true, missing: [] });
  });

  await t.test('실행 환경 변수: 학원 공간을 쓰는 프로그램만', () => {
    const base = { base: {}, ticket: 't', appId: 'notes', user: cloud.user, appDirs: dirs, serverUrl: s.base, launcherVersion: '1', trustFile: 'x' };
    const on = buildEnv({ ...base, academy: cloud._usesAcademy('notes') });
    assert.equal(on.MAGOEDU_ACADEMY_DIR, dirs.academy);
    assert.equal(on.MAGOEDU_REQUEST_DIR, dirs.requests);
    assert.equal(on.MAGOEDU_ACADEMY_ID, String(cloud.user.academy.id));
    const off = buildEnv(base);
    assert.equal(off.MAGOEDU_ACADEMY_DIR, '');
    assert.equal(off.MAGOEDU_REQUEST_DIR, '');
  });
});
