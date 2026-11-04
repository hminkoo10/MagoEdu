'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDb, MIGRATIONS } = require('../src/db');
const { startServer, ADMIN_PASSWORD } = require('./helpers');
const { sha256Hex } = require('../src/util');

const school = { school: '마고중학교', schoolOffice: 'B10', schoolCode: '7010001' };
const schoolOf = (s) => ({ school: s.school, schoolOffice: s.schoolOffice, schoolCode: s.schoolCode });

test('고침 8: 기본 PC 이름만 변경, 웹·사용자 지정 이름 유지, 학생 코드 기본값', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-school-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['마고 과목내비 (PC)', '우리 학원 내비', '마고 과목내비']) {
    const file = path.join(root, `${name}.db`);
    const raw = new DatabaseSync(file);
    for (const sql of MIGRATIONS.slice(0, 7)) raw.exec(sql);
    raw.exec('PRAGMA user_version = 7');
    const insert = raw.prepare("INSERT INTO apps(id, name, source, created_at, updated_at) VALUES (?, ?, '{}', 1, 1)");
    insert.run('mago-navi-pc', name);
    insert.run('mago-navi', '웹 사용자 이름');
    raw.exec("INSERT INTO academies(id, name, created_at) VALUES (1, '학원', 1); INSERT INTO students(id, academy_id, name, school, created_at, updated_at) VALUES ('legacy', 1, '학생', '옛학교', 1, 1)");
    raw.close();
    const db = openDb(file);
    assert.equal(db.get("SELECT name FROM apps WHERE id = 'mago-navi-pc'").name, name === '마고 과목내비 (PC)' ? '마고 과목내비' : name);
    assert.equal(db.get("SELECT name FROM apps WHERE id = 'mago-navi'").name, '웹 사용자 이름');
    const old = db.get("SELECT * FROM students WHERE id = 'legacy'");
    assert.deepEqual([old.school, old.school_office, old.school_code], ['옛학교', '', '']);
    db.close();
    openDb(file).close(); // 다시 열어도 안전
  }
  const seed = require('../catalog.default.json');
  assert.equal(seed.find((a) => a.id === 'mago-navi-pc').name, '마고 과목내비');
  assert.equal(seed.find((a) => a.id === 'mago-navi').name, '마고 과목내비');
});

test('학생 학교 코드: 생성·수정·목록·본인·충돌·복원·이전 파일 재삽입 왕복', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const token = await s.login('admin', ADMIN_PASSWORD);
  const { db, svc, students, blobs } = s.app.deps;
  const aca = Number(db.run("INSERT INTO academies(name, created_at) VALUES ('학교학원', 1)").lastInsertRowid);
  const qs = `?academy=${aca}`;
  const request = (method, url, body) => s.request(method, url + qs, { token, body });
  let student;
  await t.test('이름만 있는 기존 클라이언트·새 필드 생성', async () => {
    const legacy = await request('POST', '/api/students', { name: '이름만', school: '대안학교' });
    assert.deepEqual(schoolOf(legacy.data.student), { school: '대안학교', schoolOffice: '', schoolCode: '' });
    const r = await request('POST', '/api/students', { name: '학교학생', ...school });
    assert.equal(r.status, 200);
    student = r.data.student;
    assert.deepEqual(schoolOf(student), school);
    assert.deepEqual(schoolOf((await request('GET', '/api/students')).data.students.find((x) => x.id === student.id)), school);
  });
  await t.test('문자열·형식·코드 쌍을 생성/수정 모두 검증', async () => {
    const invalid = [
      { schoolOffice: 'b10', schoolCode: '7010001' }, { schoolOffice: 'B1', schoolCode: '7010001' },
      { schoolOffice: 'B10', schoolCode: '701001' }, { schoolOffice: 'B10', schoolCode: 7010001 },
      { schoolOffice: null, schoolCode: '' }, { schoolOffice: ' B10', schoolCode: '7010001' },
      { schoolOffice: 'B10\n', schoolCode: '7010001' }, { schoolOffice: 'B10', schoolCode: '7010001\n' },
      { schoolOffice: 'B10', schoolCode: '' }, { schoolOffice: '', schoolCode: '7010001' },
      { schoolOffice: 'B10' }, { schoolCode: '7010001' }, { schoolOffice: {}, schoolCode: [] },
    ];
    for (const bad of invalid) for (const method of ['POST', 'PATCH']) {
      const r = await request(method, method === 'POST' ? '/api/students' : `/api/students/${student.id}`, { name: '학생', school: '학교', ...bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.data.error.code, 'invalid_school');
    }
  });
  await t.test('부분 수정 보존·코드 변경·충돌 응답·이름 변경/빈 값은 코드 삭제', async () => {
    const url = `/api/students/${student.id}`;
    const memo = await request('PATCH', url, { memo: '메모' });
    assert.deepEqual(schoolOf(memo.data.student), school);
    assert.deepEqual(schoolOf((await request('PATCH', url, { school: school.school })).data.student), school);
    const updated = { ...school, schoolCode: '7010002' };
    assert.deepEqual(schoolOf((await request('PATCH', url, updated)).data.student), updated);
    const conflict = await request('PATCH', url, { baseRev: 1, name: '뒤늦은 수정' });
    assert.equal(conflict.status, 409);
    assert.deepEqual(schoolOf(conflict.data.error.student), updated);
    assert.deepEqual(schoolOf((await request('PATCH', url, { school: '직접 입력' })).data.student), { school: '직접 입력', schoolOffice: '', schoolCode: '' });
    await request('PATCH', url, school);
    assert.deepEqual(schoolOf((await request('PATCH', url, { school: '' })).data.student), { school: '', schoolOffice: '', schoolCode: '' });
    await request('PATCH', url, school);
    assert.deepEqual(schoolOf((await request('PATCH', url, { schoolOffice: '', schoolCode: '' })).data.student), { school: school.school, schoolOffice: '', schoolCode: '' });
    await request('PATCH', url, school);
  });
  await t.test('학생 계정 본인 명단·사용자 직렬화에도 코드 포함', async () => {
    db.run("INSERT INTO users(uid, username, name, role, academy_id, student_id, password_hash, created_at, updated_at) VALUES ('school-self', 'school-self', '학생', 'student', ?, ?, '', 1, 1)", aca, student.id);
    const user = db.get("SELECT * FROM users WHERE uid = 'school-self'");
    const selfToken = svc.createSession(user, { id: 'self', platform: 'web-app' }, '127.0.0.1', { appId: 'mago-navi' });
    const own = await s.request('GET', '/api/students', { token: selfToken });
    assert.equal(own.status, 200);
    assert.equal(own.data.students.length, 1);
    assert.deepEqual(schoolOf(own.data.students[0]), school);
    assert.deepEqual(schoolOf(svc.publicUser(user).student), school);
  });
  await t.test('삭제·복원은 코드 유지', async () => {
    const url = `/api/students/${student.id}`;
    assert.deepEqual(schoolOf((await request('DELETE', url)).data.student), school);
    assert.deepEqual(schoolOf((await request('POST', url + '/restore', {})).data.student), school);
  });
  await t.test('이전 학생 파일 재삽입도 코드 보존·검증', async () => {
    const add = async (id, values) => {
      const data = JSON.stringify({ name: '복원 학생', ...values });
      const sha = sha256Hex(data);
      const file = blobs.pathFor(sha);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
      students.onSharedPut(aca, 'ohdapnote', `students/${id}.json`, sha);
      return students.list(aca).students.find((x) => x.id === id);
    };
    assert.deepEqual(schoolOf(await add('restored-school', school)), school);
    assert.deepEqual(schoolOf(await add('restored-legacy', { school: '옛학교' })), { school: '옛학교', schoolOffice: '', schoolCode: '' });
    assert.equal(await add('restored-invalid', { ...school, schoolCode: 7010001 }), undefined);
  });
});
