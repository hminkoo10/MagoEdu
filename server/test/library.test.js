'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Library } = require('../src/library');
const { bookId } = require('../scripts/library-publish');
const { startServer, ADMIN_PASSWORD } = require('./helpers');

const script = path.join(__dirname, '../scripts/library-publish.js');
const exam = { exam: 'synthetic', year: 2026, schoolYear: 2026, month: 6, grade: 3, subject: 'math', selection: null, form: 'A' };
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mago-library-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const library = path.join(dir, 'library');
  const output = path.join(dir, 'output');
  const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof data === 'object' ? JSON.stringify(data) : data); };
  const book = (id = 'source', subject = 'math') => {
    const folder = path.join(output, 'books', id);
    write(path.join(folder, 'book.json'), { id, exam: { ...exam, subject }, createdBy: { id: 'processor' } });
    write(path.join(folder, 'answers.json'), { synthetic: true });
    write(path.join(folder, 'problem-1.pdf'), '%PDF-synthetic');
    return folder;
  };
  const summary = (books = [{ bookId: 'source', done: true }]) => write(path.join(output, 'summary.json'), { exams: books });
  const publish = (...args) => {
    const r = spawnSync(process.execPath, [script, '--library', library, '--app', 'ohdapnote', ...(args.length ? args : [output])], { encoding: 'utf8' });
    return { code: r.status, result: JSON.parse(r.stdout), stderr: r.stderr };
  };
  const indexFile = path.join(library, 'ohdapnote', 'index.json');
  const index = () => JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  return { dir, library, output, write, book, summary, publish, indexFile, index };
}

test('공용 책장 올리기: 생성·동일 시험 갱신·삭제·복원·중복 blob', (t) => {
  const f = setup(t);
  const folder = f.book(); f.summary();
  assert.deepEqual(f.publish().result, { books: 1, changed: 3, deleted: 0, seq: 3 });
  const first = f.index();
  const id = bookId(exam);
  assert.ok(first.entries.every((e) => e.book === id && e.rev === 1));
  const meta = first.entries.find((e) => e.path.endsWith('/book.json'));
  const book = JSON.parse(fs.readFileSync(path.join(f.library, 'blobs', meta.sha256)));
  assert.equal(book.id, id);
  assert.deepEqual(book.createdBy, { id: 'mago-library', name: '마고 공용 책장' });
  assert.equal(f.publish().result.changed, 0);
  assert.deepEqual(f.index(), first);
  f.write(path.join(folder, 'answers.json'), { synthetic: 'changed' });
  fs.unlinkSync(path.join(folder, 'problem-1.pdf'));
  const r = f.publish();
  assert.equal(r.code, 0);
  assert.deepEqual(r.result, { books: 1, changed: 1, deleted: 1, seq: 5 });
  assert.equal(f.index().entries.find((e) => e.path.endsWith('/book.json')).rev, 1);
  const dead = f.index().entries.find((e) => e.deleted);
  assert.deepEqual([dead.rev, dead.sha256, dead.size], [2, null, 0]);
  assert.deepEqual(f.publish('--remove', id).result, { books: 0, changed: 0, deleted: 2, seq: 7 });
  assert.equal(f.publish('--remove', id).result.deleted, 0);
  assert.equal(f.publish().result.changed, 2);
  assert.equal(fs.readdirSync(path.join(f.library, 'blobs')).length, 4);
});

test('올리기: 잠금·시작 오류·깨진 입력·실패한 책 보존', (t) => {
  const f = setup(t); f.book(); f.summary(); f.publish();
  const before = f.index();
  const lock = path.join(f.library, 'ohdapnote', '.lock');
  f.write(lock, 'held');
  assert.equal(f.publish().code, 3);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'held');
  fs.unlinkSync(lock);
  f.write(path.join(f.output, 'summary.json'), '{');
  assert.equal(f.publish().code, 1);
  f.summary([{ bookId: 'source', done: true }, { bookId: 'missing', done: true }, { bookId: 'ignored', done: true, error: 'failed' }]);
  f.write(path.join(f.output, 'books/source/book.json'), '{');
  assert.equal(f.publish().code, 1);
  assert.deepEqual(f.index(), before);
  f.write(f.indexFile, '{');
  assert.equal(f.publish().code, 2);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(f.publish('--remove', '../bad').code, 2);
});

test('올리기: 일부 성공·완료 상태 필터·다른 입력 id의 같은 시험', (t) => {
  const f = setup(t); f.book('a'); f.book('b');
  f.summary([{ bookId: 'a', done: true }, { bookId: 'bad', done: true }, { bookId: 'pending', done: false }]);
  const r = f.publish(); assert.equal(r.code, 1); assert.equal(r.result.books, 1);
  f.summary([{ bookId: 'b', done: true }]);
  assert.equal(f.publish().result.changed, 0);
  assert.equal(new Set(f.index().entries.map((e) => e.book)).size, 1);
  for (const key of Object.keys(exam)) assert.notEqual(bookId({ ...exam, [key]: key === 'year' ? 2025 : 'different' }), bookId(exam));
});

test('올리기 권한: umask와 무관한 폴더 0750·파일 0640', { skip: process.platform === 'win32' && 'Windows는 POSIX 권한 비트를 지원하지 않음' }, (t) => {
  const f = setup(t); f.book(); f.summary();
  const previous = process.umask(0o077);
  try { assert.equal(f.publish().code, 0); } finally { process.umask(previous); }
  function check(folder) {
    assert.equal(fs.statSync(folder).mode & 0o777, 0o750);
    for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, e.name);
      if (e.isDirectory()) check(file); else assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    }
  }
  check(f.library);
});

test('색인: 없음·깨짐·잘못된 sha·mtime/크기 변경 시 재읽기', (t) => {
  const f = setup(t); const warnings = [];
  const library = new Library(f.library, { warn: (m) => warnings.push(m) });
  assert.equal(library.index('ohdapnote').seq, 0);
  library.index('ohdapnote'); assert.equal(warnings.length, 1);
  f.book(); f.summary(); f.publish();
  const original = library.index('ohdapnote');
  assert.equal(original.seq, 3);
  assert.equal(library.index('ohdapnote'), original);
  f.write(f.indexFile, '{broken');
  assert.equal(library.index('ohdapnote').seq, 0);
  library.index('ohdapnote'); assert.equal(warnings.length, 2);
  const bad = structuredClone(original); bad.entries[0].sha256 = '../escape'; f.write(f.indexFile, bad);
  assert.equal(library.index('ohdapnote').seq, 0);
  f.write(f.indexFile, original);
  assert.equal(library.index('ohdapnote').seq, 3);
  assert.throws(() => library.blob('../escape'));
});

test('읽기 API: 역할·계약 과목·증분·HEAD·삭제·색인 갱신', async (t) => {
  const f = setup(t); const mathDir = f.book(); f.book('english', 'english');
  f.summary([{ bookId: 'source', done: true }, { bookId: 'english', done: true }]); f.publish();
  const s = await startServer({ libraryDir: f.library }); t.after(() => s.close());
  const rq = s.request;
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const make = async (token, body) => {
    const r = await rq('POST', '/api/users', { token, body: { password: 'test-pass-1234', mustChangePassword: false, ...body } });
    assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.user;
  };
  await make(admin, { username: 'director', name: '합성 원장', role: 'director', academyName: '합성 학원', academySubjects: ['math'] });
  const director = await s.login('director', 'test-pass-1234');
  const teacher = await make(director, { username: 'teacher', name: '합성 선생님' });
  const teach = await s.login('teacher', 'test-pass-1234');
  const base = '/api/sync/ohdapnote/library';
  const list = (token, since = 0) => rq('GET', `${base}?since=${since}`, { token });
  const file = (token, p, method = 'GET') => rq(method, `${base}/file?path=${encodeURIComponent(p)}`, { token });
  const mathPath = `books/${bookId(exam)}/answers.json`;
  const engPath = `books/${bookId({ ...exam, subject: 'english' })}/answers.json`;
  assert.equal((await list()).status, 401);
  for (const token of [director, teach]) {
    const r = await list(token); assert.equal(r.status, 200);
    assert.deepEqual(r.data.subjects, ['math']); assert.equal(r.data.entries.length, 3);
    assert.ok(r.data.entries.every((e) => e.subject === 'math'));
    assert.equal((await file(token, engPath)).status, 403);
  }
  const all = (await list(admin)).data;
  assert.equal(all.entries.length, 6); assert.deepEqual(all.subjects, ['english', 'math']);
  const head = await file(teach, mathPath, 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.data.length, 0);
  assert.equal(head.headers.get('x-rev'), '1'); assert.equal(head.headers.get('cache-control'), 'no-store');
  const get = await file(teach, mathPath); assert.equal(get.data.toString(), '{"synthetic":true}');
  assert.equal(get.headers.get('x-sha256'), head.headers.get('x-sha256'));
  assert.equal((await file(teach, '../index.json')).status, 400);
  assert.equal((await file(teach, 'books/missing/book.json')).status, 404);
  assert.equal((await rq('PUT', `${base}/file?path=x`, { token: admin, raw: 'x' })).status, 405);
  assert.equal((await list(teach, all.seq)).data.full, false);
  assert.deepEqual((await list(teach, all.seq)).data.entries, []);
  f.write(path.join(mathDir, 'answers.json'), { synthetic: 'new' }); f.publish();
  const delta = (await list(teach, all.seq)).data;
  assert.equal(delta.entries.length, 1); assert.equal(delta.entries[0].rev, 2);
  f.publish('--remove', bookId(exam));
  const dead = (await list(teach, delta.seq)).data;
  assert.equal(dead.entries.length, 3); assert.ok(dead.entries.every((e) => e.deleted));
  assert.equal((await file(teach, mathPath)).status, 404);
  f.publish('--remove', bookId({ ...exam, subject: 'english' }));
  assert.equal((await list(teach, dead.seq)).data.entries.length, 0);
  assert.equal((await list(admin, dead.seq)).data.entries.length, 3);
  s.app.deps.db.run("UPDATE users SET academy_id = NULL WHERE username IN ('teacher', 'director')");
  for (const token of [director, teach]) {
    const r = await list(token); assert.equal(r.status, 404); assert.equal(r.data.error.code, 'no_academy');
  }
  // 같은 세션에서 프로그램 사용 권한 변경도 즉시 반영.
  s.app.deps.db.run("UPDATE users SET allowed_apps = '[]' WHERE username = 'teacher'");
  assert.equal((await list(teach)).status, 403);
  assert.ok(teacher.id);
});

test('API: 학생 library_forbidden·색인 없음/깨짐은 빈 책장', async (t) => {
  const f = setup(t);
  const s = await startServer({ libraryDir: f.library }); t.after(() => s.close());
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const endpoint = '/api/sync/ohdapnote/library';
  assert.deepEqual((await s.request('GET', endpoint, { token: admin })).data.entries, []);
  f.write(f.indexFile, '{');
  assert.equal((await s.request('GET', endpoint, { token: admin })).data.seq, 0);
  const db = s.app.deps.db;
  const aca = db.run("INSERT INTO academies(name, subjects, created_at) VALUES ('합성 학원', '[\"math\"]', 1)").lastInsertRowid;
  db.run("INSERT INTO students(id, academy_id, name, created_at, updated_at) VALUES ('synthetic-student', ?, '합성 학생', 1, 1)", aca);
  const uid = db.run(`INSERT INTO users(uid, username, name, role, academy_id, student_id, password_hash, must_change_password, created_at, updated_at)
    VALUES ('synthetic-uid', 'student', '합성 학생', 'student', ?, 'synthetic-student', 'unused', 0, 1, 1)`, aca).lastInsertRowid;
  const token = 'synthetic-student-token';
  const { sha256Hex } = require('../src/util');
  db.run(`INSERT INTO sessions(user_id, token_hash, device_id, device_name, platform, created_at, last_seen_at, expires_at)
    VALUES (?, ?, 'test', 'test', 'web', ?, ?, ?)`, uid, sha256Hex(token), Date.now(), Date.now(), Date.now() + 60000);
  for (const suffix of ['', '/file?path=books/x/book.json']) {
    const r = await s.request('GET', endpoint + suffix, { token });
    assert.equal(r.status, 403); assert.equal(r.data.error.code, 'library_forbidden');
  }
});
