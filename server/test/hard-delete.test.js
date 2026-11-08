'use strict';

// 학원 학생 명단·학원 공용 AI·학원 공간의 학생 폴더 (students.js, routes/students.js, sharing.js)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openEvents, settleEvents } = require('./event-helpers');
const { startServer, ADMIN_PASSWORD } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;

/** 원장 A·B(다른 학원), A학원 선생님 둘 */
async function setup(s) {
  const rq = s.request;
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const mk = async (token, body) => {
    const r = await rq('POST', '/api/users', { token, body: { password: 'pass1234', mustChangePassword: false, ...body } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.user;
  };
  const da = await mk(admin, { role: 'director', name: 'A원장', username: 'dira', academyName: 'A학원' });
  const db = await mk(admin, { role: 'director', name: 'B원장', username: 'dirb', academyName: 'B학원' });
  const dirA = await s.login('dira', 'pass1234');
  const dirB = await s.login('dirb', 'pass1234');
  const u1 = await mk(dirA, { name: '김선생', username: 'teach1' });
  const u2 = await mk(dirA, { name: '이선생', username: 'teach2' });
  const t1 = await s.login('teach1', 'pass1234');
  const t2 = await s.login('teach2', 'pass1234', 'dev-2');
  return { admin, dirA, dirB, t1, t2, u1, u2, da, db, acaA: da.academy.id, acaB: db.academy.id };
}

const q = (p) => encodeURIComponent(p);


async function fixture(t) {
  const s = await startServer(); t.after(() => s.close());
  const env = await setup(s);
  const db = s.app.deps.db, blobs = s.app.deps.blobs;
  const student = async (name = '개인정보') => (await s.request('POST', '/api/students', { token: env.dirA, body: { name, school: '학교', memo: '메모' } })).data.student.id;
  const put = async (token, sid, text) => {
    const r = await s.request('PUT', `/api/sync/ohdapnote/academy/file?path=${q(`students/${sid}/notes/test.json`)}&baseRev=0`, { token, raw: Buffer.from(text) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return require('../src/util').sha256Hex(text);
  };
  return { ...env, s, db, blobs, student, put };
}

test('수동 완전 삭제: 권한·범위·활성 거부·계정/초대/파일 정리·공유 해시 보존·동기화·기록', async (t) => {
  const { s, db, blobs, student, put, dirA, dirB, t1, acaA, acaB } = await fixture(t);
  const sid = await student();
  const req = (route, token, body) => s.request('POST', route, { token, body });
  assert.equal((await req('/api/students/purge', dirA, { ids: [sid] })).status, 400);
  const account = await req(`/api/students/${sid}/account`, dirA, { username: 'purge-student', password: 'pass1234' });
  assert.equal(account.status, 200);
  const uid = db.get('SELECT id FROM users WHERE student_id = ?', sid).id;
  assert.equal((await req('/api/auth/login', null, { username: 'purge-student', password: 'pass1234', device: { id: 'student-web', platform: 'web' } })).status, 200);
  await req(`/api/students/${sid}/invite`, dirA, {});
  const unique = await put(dirA, sid, 'private');
  const otherSid = (await req('/api/students', dirB, { name: '다른 학원' })).data.student.id;
  const shared = await put(dirB, otherSid, 'shared');
  const f = db.get('SELECT * FROM shared_files WHERE academy_id = ?', acaB);
  db.run(`INSERT INTO files(user_id, app_id, path, rev, seq, sha256, size, updated_at) VALUES (?, 'ohdapnote', 'private.json', 1, 1, ?, 6, ?)`, uid, shared, Date.now());
  await s.request('DELETE', `/api/students/${sid}`, { token: dirA });
  // Make a still-outstanding invitation to exercise purge itself, not only soft delete.
  db.run('INSERT INTO student_invites(code_hash, academy_id, student_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', 'testhash', acaA, sid, Date.now(), Date.now()+DAY);
  assert.equal((await req('/api/students/purge', t1, { ids: [sid] })).status, 403);
  assert.equal((await req(`/api/students/purge?academy=${acaA}`, dirB, { ids: [sid] })).status, 404);
  const r = await req('/api/students/purge', dirA, { ids: [sid] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.students, r.data.accounts, r.data.files], [1, 1, 2]);
  assert.equal(blobs.has(unique), false); assert.equal(blobs.has(shared), true);
  assert.equal(db.get('SELECT 1 FROM users WHERE id = ?', uid), undefined);
  assert.equal(db.get('SELECT 1 FROM sessions WHERE user_id = ?', uid), undefined);
  assert.equal(db.get('SELECT 1 FROM student_invites WHERE student_id = ?', sid), undefined);
  assert.equal(db.get("SELECT 1 FROM audit WHERE actor_id = ? AND action = 'login'", uid), undefined);
  const row = db.get('SELECT * FROM students WHERE id = ?', sid);
  for (const key of ['name', 'school', 'school_office', 'school_code', 'grade', 'memo']) assert.equal(row[key], '');
  for (const key of ['teacher_uid', 'created_by', 'updated_by', 'deleted_by']) assert.equal(row[key], null);
  assert.ok(row.purged_at);
  assert.deepEqual(db.get('SELECT * FROM shared_files WHERE id = ?', f.id), f);
  assert.deepEqual((await s.request('GET', '/api/students', { token: dirA })).data.purged, [sid]);
  const audit = db.get("SELECT * FROM audit WHERE action = 'student.purge'");
  assert.equal(audit.target, '개인정보'); assert.equal(JSON.parse(audit.detail).manual, true);
});

test('모두 삭제·30일 자동 삭제: 숨긴 학생만, 같은 개인정보 비움', async (t) => {
  const { s, db, student, put, dirA, admin, acaA, blobs } = await fixture(t);
  const ids = [await student('하나'), await student('둘')], active = await student('활성');
  for (const id of ids) await s.request('DELETE', `/api/students/${id}`, { token: dirA });
  const r = await s.request('POST', `/api/students/purge?academy=${acaA}`, { token: admin, body: { all: true } });
  assert.equal(r.data.students, 2); assert.equal(db.get('SELECT name FROM students WHERE id = ?', active).name, '활성');
  const sha = await put(dirA, active, 'expired');
  await s.request('DELETE', `/api/students/${active}`, { token: dirA });
  db.run('UPDATE students SET deleted_at = ? WHERE id = ?', Date.now()-31*DAY, active);
  assert.deepEqual(s.app.deps.students.purgeExpired(), { students: 1, files: 1 });
  assert.equal(blobs.has(sha), false); assert.equal(db.get('SELECT name FROM students WHERE id = ?', active).name, '');
  assert.equal(JSON.parse(db.get("SELECT detail FROM audit WHERE action = 'student.purge' AND target = '활성'").detail).manual, false);
});

test('계정·학원 삭제: 개인 blob 즉시 정리, 소속 계정·줄 제거, 다른 학원 유지, 운영자 기록', async (t) => {
  const { s, db, blobs, student, put, dirA, dirB, admin, u1, acaA, acaB } = await fixture(t);
  const sid = await student(), sha = await put(dirA, sid, 'academy-private');
  const otherSid = (await s.request('POST', '/api/students', { token: dirB, body: { name: '남음' } })).data.student.id;
  const shared = await put(dirB, otherSid, 'other');
  const user = db.get('SELECT * FROM users WHERE uid = ?', u1.id);
  const personal = require('../src/util').sha256Hex('personal');
  fs.mkdirSync(path.dirname(blobs.pathFor(personal)), { recursive: true }); fs.writeFileSync(blobs.pathFor(personal), 'personal');
  db.run("INSERT INTO files(user_id, app_id, path, rev, seq, sha256, size, updated_at) VALUES (?, 'x', 'x', 1, 1, ?, 8, ?)", user.id, personal, Date.now());
  db.run('UPDATE students SET teacher_uid = ? WHERE id = ?', user.uid, sid);
  assert.equal((await s.request('DELETE', `/api/users/${user.uid}`, { token: dirA })).status, 200);
  assert.equal(blobs.has(personal), false); assert.equal(db.get('SELECT teacher_uid FROM students WHERE id = ?', sid).teacher_uid, db.get("SELECT uid FROM users WHERE academy_id = ? AND role = 'director'", acaA).uid);
  const count = JSON.parse(db.get("SELECT detail FROM audit WHERE action = 'user.delete'").detail);
  assert.equal(count.removedFiles, 1);
  assert.equal((await s.request('DELETE', `/api/academies/${acaA}`, { token: dirB })).status, 403);
  assert.equal((await s.request('POST', `/api/students/${sid}/account`, { token: dirA, body: { username: 'academy-student', password: 'pass1234' } })).status, 200);
  const adminId = db.get("SELECT id FROM users WHERE username = 'admin'").id;
  db.run('UPDATE users SET academy_id = ? WHERE id = ?', acaA, adminId); // 학원에 속한 운영자가 그 학원을 지워도 운영자 계정은 남음
  const r = await s.request('DELETE', `/api/academies/${acaA}`, { token: admin }); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(db.get('SELECT academy_id FROM users WHERE id = ?', adminId).academy_id, null);
  assert.equal(blobs.has(sha), false); assert.equal(blobs.has(shared), true);
  for (const table of ['users', 'students', 'shared_files', 'shared_items', 'academy_ai', 'student_invites', 'notices']) assert.equal(db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE academy_id = ?`, acaA).n, 0, table);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM users WHERE role != 'admin' AND academy_id IS NULL").n, 0);
  assert.ok(db.get('SELECT 1 FROM users WHERE academy_id = ?', acaB));
  const audit = db.get("SELECT * FROM audit WHERE action = 'academy.delete'"); assert.equal(audit.academy_id, null); assert.ok(JSON.parse(audit.detail).accounts >= 2);
});

test('마이그레이션 11: 기존 완전 삭제 학생 개인정보 비움', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { MIGRATIONS } = require('../src/db');
  const raw = new DatabaseSync(':memory:');
  try {
    for (const sql of MIGRATIONS.slice(0,10)) raw.exec(sql);
    raw.exec("INSERT INTO academies(id,name,created_at) VALUES(1,'학원',1); INSERT INTO students(id,academy_id,name,school,memo,created_at,updated_at,purged_at) VALUES('old',1,'이름','학교','메모',1,2,3)");
    raw.exec(MIGRATIONS[10]); const r = raw.prepare('SELECT * FROM students').get();
    assert.equal(r.name, ''); assert.equal(r.school, ''); assert.equal(r.memo, ''); assert.equal(r.created_at, 0); assert.equal(r.purged_at, 3);
  } finally { raw.close(); }
});
