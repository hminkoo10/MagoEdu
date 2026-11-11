'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startServer, ADMIN_PASSWORD } = require('../../server/test/helpers');
const { ApiClient } = require('../src/core/api');
const { makePaths } = require('../src/core/paths');
const { SyncEngine } = require('../src/core/sync');
const { compileRules } = require('../src/core/rules');
const { normalizeManifest } = require('../src/core/manifest');
const { buildEnv } = require('../src/core/runner');
const { Cloud } = require('../src/main/cloud');
const quiet = { info() {}, warn() {}, error() {} };
const manifest = normalizeManifest({ library: { lazy: ['**/*.pdf'] } });
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-library-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = makePaths({ userData: path.join(root, 'r'), localData: path.join(root, 'l') });
  return { root, paths, dirs: paths.account('u').app('notes') };
}

test('공용 책장: 매니페스트·역할·폴더·실행 환경', (t) => {
  const { paths, dirs } = setup(t);
  assert.equal(normalizeManifest({}).library, null);
  assert.deepEqual(manifest.library, { include: ['**'], exclude: [], lazy: ['**/*.pdf'] });
  assert.deepEqual(normalizeManifest({ library: { include: ['books/**'], exclude: ['**/*.tmp'], lazy: ['**/*.pdf'] } }).library,
    normalizeManifest({ shared: { include: ['books/**'], exclude: ['**/*.tmp'], lazy: ['**/*.pdf'] } }).shared);
  const cloud = Object.assign(Object.create(Cloud.prototype), { paths, installed: { notes: { manifest } } });
  for (const role of ['admin', 'director', 'teacher', 'student', 'other']) {
    for (const academy of [null, { id: 'a' }]) {
      cloud.user = { id: 'u', role, academy };
      const expected = role === 'admin' || (['director', 'teacher'].includes(role) && !!academy);
      assert.equal(cloud._usesLibrary('notes'), expected);
      assert.equal(cloud._usesRequests('notes'), expected);
      const engine = cloud._libraryEngine('notes');
      assert.equal(!!engine, expected);
      if (engine) { assert.equal(engine.readOnly, true); assert.equal(engine.base, '/api/sync/notes/library'); }
      const env = buildEnv({ base: { MAGOEDU_LIBRARY_DIR: 'inherited' }, user: cloud.user, appDirs: dirs, library: expected });
      assert.equal(env.MAGOEDU_LIBRARY_DIR, expected ? dirs.library : '');
      assert.equal(env.MAGOEDU_REQUEST_DIR, expected ? dirs.requests : '');
    }
  }
  cloud.installed.notes.manifest = normalizeManifest({});
  assert.equal(cloud._usesLibrary('notes'), false);
  assert.equal(path.basename(dirs.libraryState), '.library-sync-state.json');
});

test('받기 전용: 실제 읽기 API·수정 복원·삭제·lazy·want·요청 분리·계약 축소', async (t) => {
  const { root, paths, dirs } = setup(t);
  const libraryDir = path.join(root, 'published');
  const indexFile = path.join(libraryDir, 'notes', 'index.json');
  const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
  const entry = (p, content, seq) => {
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    write(path.join(libraryDir, 'blobs', sha256), content);
    return { path: p, rev: 1, seq, sha256, size: Buffer.byteLength(content), mtime: Date.now(), deleted: false, subject: 'math', book: 'b1' };
  };
  let entries = [entry('books/b1/book.json', 'metadata', 1), entry('books/b1/a.pdf', 'pdf', 2), entry('books/b1/remove.json', 'delete', 3)];
  const publish = () => write(indexFile, JSON.stringify({ format: 1, appId: 'notes', seq: 3, entries }));
  publish();
  const s = await startServer({ libraryDir });
  t.after(() => s.close());
  const token = await s.login('admin', ADMIN_PASSWORD);
  assert.equal((await s.request('POST', '/api/admin/apps', { token, body: { id: 'notes', name: '노트', source: { type: 'local' } } })).status, 200);
  const api = new ApiClient({ serverUrl: s.base, device: { id: 'library-test', name: '시험', platform: 'test', version: '1' } });
  await api.login('admin', ADMIN_PASSWORD);
  const gets = [], writes = [];
  const get = api.get.bind(api);
  api.get = (p, opts) => { gets.push(p); return get(p, opts); };
  for (const name of ['upload', 'del']) api[name] = (...args) => { writes.push(name); throw new Error('쓰기 요청 금지'); };
  const request = api.request.bind(api);
  api.request = (method, ...args) => { if (method !== 'GET') { writes.push(method); throw new Error('쓰기 요청 금지'); } return request(method, ...args); };
  const cloud = Object.assign(Object.create(Cloud.prototype), { paths, api, installed: { notes: { manifest } }, user: { id: 'u', role: 'admin' }, log: quiet });
  const run = (opts) => cloud._libraryEngine('notes').run(opts);
  const local = (p) => path.join(dirs.library, p);
  assert.equal((await run({ drop: new Set(['books/b1/a.pdf']) })).downloaded, 2);
  assert.equal(fs.existsSync(local('books/b1/a.pdf')), false);
  assert.equal((await run()).downloaded, 0, '같은 파일은 다시 받지 않음');
  write(local('books/b1/book.json'), 'tampered');
  write(local('only-local.json'), 'local');
  write(local('books/b1/a.pdf'), 'tampered lazy');
  const fixed = await run();
  assert.equal(fixed.downloaded, 2);
  assert.equal(fs.readFileSync(local('books/b1/book.json'), 'utf8'), 'metadata');
  assert.equal(fs.readFileSync(local('books/b1/a.pdf'), 'utf8'), 'pdf');
  assert.equal(fs.existsSync(local('only-local.json')), false);
  assert.deepEqual(fixed.conflicts, []);
  assert.equal(fs.existsSync(dirs.conflicts), false);
  fs.rmSync(local('books/b1/a.pdf'));
  assert.equal((await run()).downloaded, 1, '한 번 받은 lazy 삭제도 복원');
  // 새 컴퓨터는 lazy를 받지 않다가 want를 주면 받는다. drop은 성공적으로 무시한다.
  const freshDirs = paths.account('fresh').app('notes');
  const freshEngine = new SyncEngine({ api, appId: 'notes', base: '/api/sync/notes/library', readOnly: true,
    dirs: { sync: freshDirs.library, state: freshDirs.libraryState }, rules: compileRules(manifest.library), log: quiet });
  await freshEngine.run();
  assert.equal(fs.existsSync(path.join(freshDirs.library, 'books/b1/a.pdf')), false);
  const wanted = await freshEngine.run({ want: new Set(['books/b1/a.pdf', 'missing.pdf']), drop: new Set(['books/b1/a.pdf']) });
  assert.equal(wanted.downloaded, 1);
  assert.deepEqual(wanted.missing, ['missing.pdf']);
  entries = entries.map((e) => e.path.endsWith('remove.json') ? { ...e, deleted: true, sha256: null, size: 0 } : e);
  publish();
  assert.equal((await run()).deletedLocal, 1);
  assert.equal(fs.existsSync(local('books/b1/remove.json')), false);
  fs.rmSync(local('books/b1/book.json'));
  assert.equal((await run()).downloaded, 1);
  // SDK가 만든 library 요청만 답하며, 학원 공간 요청은 그대로 둔다.
  write(path.join(dirs.requests, 'academy.json'), JSON.stringify({ paths: ['academy-only'] }));
  write(path.join(dirs.requests, 'library.json'), JSON.stringify({ library: true, paths: ['books/b1/a.pdf', 'missing.pdf'], remove: [] }));
  await cloud._syncLibrary('notes');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirs.requests, 'library.done.json'))), { ok: false, missing: ['missing.pdf'] });
  assert.equal(fs.existsSync(path.join(dirs.requests, 'academy.json')), true);
  entries = []; publish();
  assert.equal((await run()).deletedLocal, 2, '전체 목록에서 빠진 과목 파일 정리');
  assert.ok(gets.every((p) => p.endsWith('?since=0')));
  assert.deepEqual(writes, [], 'PUT·DELETE·upload 한 번도 안 보냄');
});

test('공용 책장 실패: 403·404·연결 오류는 로그만, 요청에는 실패 답', async (t) => {
  const { paths, dirs } = setup(t);
  fs.mkdirSync(dirs.requests, { recursive: true });
  for (const status of [403, 404, 500]) {
    const logs = [];
    const cloud = Object.assign(Object.create(Cloud.prototype), { paths, user: { id: 'u' }, log: { warn: (...args) => logs.push(args) },
      _libraryEngine: () => ({ run: async () => { const err = new Error('failed'); err.status = status; throw err; } }) });
    fs.writeFileSync(path.join(dirs.requests, 'req.json'), JSON.stringify({ library: true, paths: ['a.pdf'] }));
    assert.equal(await cloud._syncLibrary('notes'), null);
    assert.equal(logs.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.requests, 'req.done.json'))).ok, false);
  }
});

test('앱 실행: 공용 책장 실패해도 개인·학원 동기화와 실행 계속', async (t) => {
  const { paths, dirs } = setup(t);
  const calls = [];
  const summary = { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: [], errors: [], reverted: [], localOnly: {}, seq: 0, at: Date.now(), usageBytes: null };
  const cloud = Object.assign(Object.create(Cloud.prototype), {
    paths, user: { id: 'u', role: 'admin' }, apps: [{ id: 'notes' }], installed: { notes: { manifest } },
    autoLaunching: new Map(), _syncing: {}, _syncAgain: {}, syncInfo: {}, version: '1',
    store: { config: {} }, log: quiet,
    api: { get: async () => { calls.push('library'); throw new Error('수신 실패'); } },
    installer: { needsUpdate: () => false }, _app: () => ({}), _lock: (_id, fn) => fn(),
    _setTask() {}, emitState() {}, _online() {}, _syncDeviceName: async () => {},
    _engine: () => ({ run: async () => { calls.push('personal'); return summary; } }),
    _syncAcademy: async () => { calls.push('academy'); return null; },
    _ticket: async () => 'ticket',
    runner: { isRunning: () => false, launch: ({ env }) => { calls.push('launch'); assert.equal(env.MAGOEDU_LIBRARY_DIR, dirs.library); } },
  });
  assert.deepEqual(await cloud.launch('notes', { skipLegacyCheck: true }), { started: true });
  assert.deepEqual(calls, ['library', 'personal', 'academy', 'launch']);
  assert.equal(fs.existsSync(dirs.library), true);
});
