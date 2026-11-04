'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDb, MIGRATIONS } = require('../src/db');
const { normalizeSubjects, parseSubjects } = require('../src/util');
const { startServer, ADMIN_PASSWORD } = require('./helpers');
const { openEvents, settleEvents } = require('./event-helpers');

function ok(r) {
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

test('계약 과목: 요청 검사와 DB 읽기', () => {
  assert.deepEqual(normalizeSubjects(['korean', 'math', 'math', 'english']), ['math', 'english', 'korean']);
  assert.deepEqual(normalizeSubjects([]), []);
  for (const value of ['math', null, {}, ['science'], ['math', 1]]) {
    assert.throws(() => normalizeSubjects(value), { status: 400, code: 'invalid_subjects', message: '과목은 수학·영어·국어 중에서 골라 주세요.' });
  }
  for (const value of ['broken', '"math"', 'null', '{}', null, undefined]) assert.deepEqual(parseSubjects(value), ['math']);
  assert.deepEqual(parseSubjects('["korean","science","math","math",null]'), ['math', 'korean']);
  assert.deepEqual(parseSubjects('["science"]'), []);
  assert.deepEqual(parseSubjects('[]'), []);
});

test('고침 9: 8번 DB의 기존 학원·가입 코드에 수학을 넣고 보존', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-mig9-'));
  const file = path.join(dir, 'cloud.db');
  let db;
  t.after(() => {
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const raw = new DatabaseSync(file);
  try {
    for (const sql of MIGRATIONS.slice(0, 8)) raw.exec(sql);
    raw.exec('PRAGMA user_version = 8');
    raw.prepare('INSERT INTO academies(id, name, created_at, quota_mb) VALUES (?, ?, ?, ?)').run(3, '기존 학원', 1, 8000);
    raw.prepare('INSERT INTO signup_codes(code, academy_name, created_at) VALUES (?, ?, ?)').run('OLD-CODE', '기존 코드 학원', 2);
  } finally {
    raw.close();
  }
  db = openDb(file);
  assert.equal(db.get('PRAGMA user_version').user_version, MIGRATIONS.length);
  const academy = db.get('SELECT * FROM academies WHERE id = 3');
  assert.deepEqual([academy.name, academy.quota_mb, JSON.parse(academy.subjects)], ['기존 학원', 8000, ['math']]);
  const code = db.get('SELECT * FROM signup_codes WHERE code = ?', 'OLD-CODE');
  assert.deepEqual([code.academy_name, JSON.parse(code.subjects)], ['기존 코드 학원', ['math']]);
  db.close();
  db = openDb(file);
  assert.deepEqual(JSON.parse(db.get('SELECT subjects FROM academies WHERE id = 3').subjects), ['math']);
});

test('학원 계약 과목: API·권한·감사 기록·실시간', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const rq = s.request;
  const db = s.app.deps.db;
  const createAcademy = async (name, extra = {}) => ok(await rq('POST', '/api/academies', { token: admin, body: { name, ...extra } })).academy;
  const createUser = async (username, extra = {}) => ok(await rq('POST', '/api/users', {
    token: admin, body: { username, name: username, password: 'pass1234', role: 'director', mustChangePassword: false, ...extra },
  })).user;
  const academy = await createAcademy('마고학원');
  const director = await createUser('boss', { academyId: academy.id });
  const boss = await s.login('boss', 'pass1234');
  await createUser('teach', { role: 'teacher', academyId: academy.id });
  const teach = await s.login('teach', 'pass1234');

  await t.test('새 학원: 기본 수학·순서·중복·빈 배열·목록·감사 기록', async () => {
    assert.deepEqual(academy.subjects, ['math']);
    const sorted = await createAcademy('순서 학원', { subjects: ['korean', 'math', 'math'] });
    assert.deepEqual(sorted.subjects, ['math', 'korean']);
    const empty = await createAcademy('빈 학원', { subjects: [] });
    assert.deepEqual(empty.subjects, []);
    const list = ok(await rq('GET', '/api/academies', { token: admin })).academies;
    assert.deepEqual(list.find((a) => a.id === sorted.id).subjects, ['math', 'korean']);
    assert.deepEqual(list.find((a) => a.id === empty.id).subjects, []);
    const audit = db.get("SELECT * FROM audit WHERE action = 'academy.create' AND academy_id = ?", sorted.id);
    assert.deepEqual(JSON.parse(audit.detail), { subjects: ['math', 'korean'] });
  });

  await t.test('모든 생성 경로·PATCH: 모르는 값·배열 아님·null 거절, 부분 저장 없음', async () => {
    for (const subjects of [['science'], 'math', null]) {
      for (const [method, url, body] of [
        ['POST', '/api/academies', { name: '잘못된 학원', subjects }],
        ['POST', '/api/codes', { subjects }],
        ['POST', '/api/users', { username: 'invaliduser', name: '원장', role: 'director', academyName: '잘못된 학원', academySubjects: subjects }],
        ['PATCH', '/api/academies/' + academy.id, { name: '저장되면 안 됨', subjects }],
      ]) {
        const r = await rq(method, url, { token: admin, body });
        assert.equal(r.status, 400, JSON.stringify(r.data));
        assert.equal(r.data.error.code, 'invalid_subjects');
      }
    }
    assert.equal(db.get('SELECT name FROM academies WHERE id = ?', academy.id).name, '마고학원');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM academies WHERE name = ?', '잘못된 학원').n, 0);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM users WHERE username = ?', 'invaliduser').n, 0);
  });

  await t.test('로그인·내 계정: 과목 포함, 학원 없는 운영자는 null', async () => {
    assert.deepEqual(director.academy.subjects, ['math']);
    for (const token of [boss, teach]) assert.deepEqual(ok(await rq('GET', '/api/me', { token })).user.academy.subjects, ['math']);
    const login = ok(await rq('POST', '/api/auth/login', { body: { username: 'boss', password: 'pass1234' } }));
    assert.deepEqual(login.user.academy, academy);
    assert.equal(ok(await rq('GET', '/api/me', { token: admin })).user.academy, null);
    assert.equal(ok(await rq('POST', '/api/auth/login', { body: { username: 'admin', password: ADMIN_PASSWORD } })).user.academy, null);
  });

  await t.test('계정 만들기: 새 학원 과목·기본값·빈 배열, 기존 학원이면 무시', async () => {
    assert.deepEqual((await createUser('newboss', { academyName: '새 학원', academySubjects: ['korean', 'english', 'english'] })).academy.subjects, ['english', 'korean']);
    assert.deepEqual((await createUser('defaultboss', { academyName: '기본 학원' })).academy.subjects, ['math']);
    assert.deepEqual((await createUser('emptyboss', { academyName: '계약 없는 학원', academySubjects: [] })).academy.subjects, []);
    assert.deepEqual((await createUser('existingboss', { academyId: academy.id, academySubjects: ['science'] })).academy.subjects, ['math']);
  });

  await t.test('가입 코드: 기본값·빈 배열·목록·감사 기록, 코드 과목으로 원장 가입', async () => {
    const makeCode = async (body) => ok(await rq('POST', '/api/codes', { token: admin, body })).code;
    assert.deepEqual((await makeCode({})).subjects, ['math']);
    assert.deepEqual((await makeCode({ subjects: [] })).subjects, []);
    const code = await makeCode({ academyName: '영어 학원', subjects: ['english', 'english'] });
    assert.deepEqual(code.subjects, ['english']);
    assert.deepEqual(ok(await rq('GET', '/api/codes', { token: admin })).codes.find((c) => c.id === code.id).subjects, ['english']);
    assert.deepEqual(JSON.parse(db.get("SELECT detail FROM audit WHERE action = 'code.create' AND target = ?", code.code).detail).subjects, ['english']);
    const joined = ok(await rq('POST', '/api/auth/signup', {
      body: { code: code.code, username: 'englishboss', name: '영어 원장', password: 'pass1234', subjects: ['math'] },
    }));
    assert.deepEqual(joined.user.academy.subjects, ['english']);
    assert.deepEqual(ok(await rq('GET', '/api/me', { token: joined.token })).user.academy.subjects, ['english']);
  });

  await t.test('PATCH: 운영자만 변경, 실제 변경만 기록·같은 학원에 알림, 원장 이름 변경 유지', async (t) => {
    await createUser('otherboss', { academyName: '다른 학원' });
    const otherToken = await s.login('otherboss', 'pass1234');
    const own = await openEvents(s.base, teach);
    const other = await openEvents(s.base, otherToken);
    t.after(() => { own.close(); other.close(); });
    const url = '/api/academies/' + academy.id;
    const patch = (token, body) => rq('PATCH', url, { token, body });
    const updated = ok(await patch(admin, { subjects: ['english', 'math', 'math'] })).academy;
    assert.deepEqual(updated, { id: academy.id, name: academy.name, quotaMb: null, subjects: ['math', 'english'] });
    assert.deepEqual((await own.next('academy')).data, { kind: 'academy' });
    await settleEvents(s.app.deps.events, other);
    assert.equal(other.events.filter((e) => e.event === 'academy').length, 0);
    const audits = () => db.all("SELECT * FROM audit WHERE action = 'academy.subjects' AND academy_id = ?", academy.id);
    assert.equal(audits().length, 1);
    assert.deepEqual(JSON.parse(audits()[0].detail), { subjects: ['math', 'english'], before: ['math'] });
    assert.equal(audits()[0].target, academy.name);
    ok(await patch(admin, { subjects: ['english', 'math', 'english'] }));
    await settleEvents(s.app.deps.events, own);
    assert.equal(audits().length, 1);
    assert.equal(own.events.filter((e) => e.event === 'academy').length, 1, '같은 과목은 알리지 않음');
    const denied = await patch(boss, { name: '권한 없이 바꾸기', subjects: [] });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error.message, '계약 과목은 운영자만 바꿀 수 있어요.');
    assert.equal((await patch(teach, { subjects: [] })).status, 403);
    assert.equal(db.get('SELECT name FROM academies WHERE id = ?', academy.id).name, academy.name);
    const renamed = ok(await patch(boss, { name: '바뀐 학원' })).academy;
    assert.equal(renamed.name, '바뀐 학원');
    assert.deepEqual(renamed.subjects, ['math', 'english']);
    assert.deepEqual((await own.next('academy')).data, { kind: 'academy' });
    assert.deepEqual(ok(await patch(admin, { subjects: [] })).academy.subjects, []);
    assert.deepEqual(JSON.parse(audits().at(-1).detail), { subjects: [], before: ['math', 'english'] });
    assert.deepEqual(ok(await rq('GET', '/api/me', { token: boss })).user.academy.subjects, []);
  });

  await t.test('DB의 깨진 값은 수학, 모르는 과목은 빼고 읽기', async () => {
    for (const [stored, expected] of [['broken', ['math']], ['{}', ['math']], ['["science","korean","math","math"]', ['math', 'korean']], ['[]', []]]) {
      db.run('UPDATE academies SET subjects = ? WHERE id = ?', stored, academy.id);
      assert.deepEqual(ok(await rq('GET', '/api/me', { token: boss })).user.academy.subjects, expected);
      assert.deepEqual(ok(await rq('GET', '/api/academies', { token: boss })).academies[0].subjects, expected);
    }
  });
});

