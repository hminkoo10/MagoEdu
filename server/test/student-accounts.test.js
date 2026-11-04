'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { openDb, MIGRATIONS } = require('../src/db');
const { DAY, sha256Hex } = require('../src/util');
const { verifyPassword, signTicket } = require('../src/security');
const { startServer, ADMIN_PASSWORD } = require('./helpers');

const PASSWORD = 'student-pass-1234';

function ok(r) {
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

function error(r, status, code) {
  assert.equal(r.status, status, JSON.stringify(r.data));
  assert.equal(r.data.error.code, code);
}

async function setup(t, config = {}) {
  const s = await startServer(config);
  t.after(() => s.close());
  const rq = s.request;
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const make = async (token, body) => ok(await rq('POST', '/api/users', {
    token, body: { password: PASSWORD, mustChangePassword: false, ...body },
  })).user;
  const da = await make(admin, { username: 'director-a', name: '가원장', role: 'director', academyName: '가학원' });
  const db = await make(admin, { username: 'director-b', name: '나원장', role: 'director', academyName: '나학원' });
  const dir = await s.login('director-a', PASSWORD);
  const other = await s.login('director-b', PASSWORD);
  const teacher = await make(dir, { username: 'teacher-a', name: '가선생' });
  const teach = await s.login('teacher-a', PASSWORD);
  const add = async (name, token = teach) => ok(await rq('POST', '/api/students', {
    token, body: { name, ...(token === teach ? { teacherId: teacher.id } : {}) },
  })).student;
  const create = async (sid, username, token = teach) => rq('POST', `/api/students/${sid}/account`, { token, body: { username, password: PASSWORD } });
  const login = async (username, password = PASSWORD, platform = 'web', id = 'student-web') => rq('POST', '/api/auth/login', {
    body: { username, password, device: { id, platform } },
  });
  return { ...s, rq, admin, dir, other, teacher, teach, da, db, add, create, login };
}

test('고침 7: 기존 열·세션·외래 키·인덱스·증가 번호 보존', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-mig7-'));
  let db;
  t.after(() => {
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, 'cloud.db');
  const raw = new DatabaseSync(file);
  for (const sql of MIGRATIONS.slice(0, 6)) raw.exec(sql);
  raw.exec('PRAGMA user_version = 6; PRAGMA foreign_keys = ON');
  raw.exec(`INSERT INTO academies(id, name, created_at, quota_mb) VALUES (1, '기존 학원', 1, 8000);
    INSERT INTO users(id, uid, username, name, role, academy_id, password_hash, must_change_password, status,
                      suspended_reason, allowed_apps, quota_mb, created_by, created_at, updated_at, last_login_at, password_changed_at)
    VALUES (7, 'old-admin', 'old-admin', '운영자', 'admin', NULL, 'hash-a', 1, 'active', NULL, NULL, 0, NULL, 1, 2, 3, 4),
           (8, 'old-director', 'old-director', '원장', 'director', 1, 'hash-b', 0, 'active', NULL, '["mago-navi"]', 1024, 7, 5, 6, 7, 8),
           (9, 'old-teacher', 'old-teacher', '선생님', 'teacher', 1, 'hash-c', 1, 'suspended', '사유', '[]', 512, 8, 9, 10, 11, 12);
    INSERT INTO sessions(token_hash, user_id, device_id, platform, created_at, last_seen_at, expires_at, app_id)
    VALUES ('session-old', 8, 'web-old', 'web-app', 1, 2, 9999999999999, 'mago-navi');
    INSERT INTO files(user_id, app_id, path, rev, seq, updated_at) VALUES (8, 'ohdapnote', 'old.json', 1, 1, 1);
    INSERT INTO group_activity(user_id, app_id, grp, last_used_at) VALUES (8, 'ohdapnote', 'old', 1);
    CREATE INDEX users_existing_name ON users(name);
    CREATE TRIGGER users_existing_update AFTER UPDATE OF name ON users BEGIN UPDATE users SET updated_at = 99 WHERE id = NEW.id; END;
    UPDATE sqlite_sequence SET seq = 80 WHERE name = 'users';`);
  const old = raw.prepare('SELECT * FROM users ORDER BY id').all();
  const sessions = raw.prepare('SELECT * FROM sessions').all();
  const files = raw.prepare('SELECT * FROM files').all();
  const groups = raw.prepare('SELECT * FROM group_activity').all();
  const indexes = raw.prepare("SELECT name, sql FROM sqlite_schema WHERE tbl_name = 'users' AND type IN ('index', 'trigger') ORDER BY name").all();
  raw.close();
  db = openDb(file);
  assert.equal(db.get('PRAGMA user_version').user_version, MIGRATIONS.length);
  assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  assert.deepEqual(db.all(`SELECT ${Object.keys(old[0]).join(', ')} FROM users ORDER BY id`), old);
  assert.deepEqual(db.all('SELECT * FROM sessions'), sessions);
  assert.deepEqual(db.all('SELECT * FROM files'), files);
  assert.deepEqual(db.all('SELECT * FROM group_activity'), groups);
  for (const i of indexes) assert.deepEqual(db.get('SELECT name, sql FROM sqlite_schema WHERE name = ?', i.name), i);
  for (const table of ['sessions', 'files', 'group_activity']) {
    assert.ok(db.all(`PRAGMA foreign_key_list(${table})`).some((r) => r.table === 'users' && r.on_delete === 'CASCADE'));
  }
  db.run("INSERT INTO students(id, academy_id, name, created_at, updated_at) VALUES ('student-one', 1, '학생', 1, 1)");
  const id = db.run(`INSERT INTO users(uid, username, name, role, academy_id, student_id, password_hash, created_at, updated_at)
    VALUES ('student-uid', 'student-name', '학생', 'student', 1, 'student-one', 'hash', 1, 1)`).lastInsertRowid;
  assert.equal(Number(id), 81);
  assert.equal(db.get('SELECT ai_mode FROM users WHERE id = ?', id).ai_mode, 'academy');
  assert.throws(() => db.run(`INSERT INTO users(uid, username, name, role, academy_id, student_id, password_hash, created_at, updated_at)
    VALUES ('student-uid2', 'student-name2', '학생', 'student', 1, 'student-one', 'hash', 1, 1)`), /UNIQUE/);
  assert.throws(() => db.run("UPDATE users SET username = 'OLD-ADMIN' WHERE id = ?", id), /UNIQUE/);
  assert.throws(() => db.run("UPDATE users SET student_id = 'missing' WHERE id = ?", id), /FOREIGN KEY/);
  assert.throws(() => db.run("UPDATE users SET role = 'unknown' WHERE id = ?", id), /CHECK/);
  assert.throws(() => db.run("UPDATE users SET student_id = 'student-one' WHERE id = 7"), /CHECK|UNIQUE/);
  db.run("UPDATE users SET name = '새 이름' WHERE id = 8");
  assert.equal(db.get('SELECT updated_at FROM users WHERE id = 8').updated_at, 99);
  db.run('DELETE FROM users WHERE id = 8');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM sessions').n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM files').n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM group_activity').n, 0);
});

test('학생 계정: 학원 코드·직접 발급·일괄 발급·관리', async (t) => {
  const s = await setup(t);
  const { rq, dir, other, teach, admin, da, db: otherDirector, add, create, login } = s;
  const db = s.app.deps.db;
  const student = await add('첫 학생');
  const second = await add('둘째 학생');
  const third = await add('셋째 학생');
  const outsider = await add('다른 학원 학생', other);
  const events = t.mock.method(s.app.deps.events, 'publishAcademyInfo');

  await t.test('학원 코드: 원장·운영자만, 형식·중복 검사, 없으면 일괄 생성 거절', async () => {
    assert.equal(ok(await rq('GET', '/api/academy', { token: teach })).academy.code, null);
    error(await rq('POST', '/api/students/accounts/bulk', { token: teach, body: { studentIds: [student.id] } }), 400, 'academy_code_required');
    error(await rq('PATCH', '/api/academy', { token: teach, body: { code: 'mago' } }), 403, 'forbidden');
    for (const code of ['a', 'ABCDEFGHI', 'Mago', 'ma-go', '한글', null]) {
      error(await rq('PATCH', '/api/academy', { token: dir, body: { code } }), 400, 'invalid_academy_code');
    }
    assert.equal(ok(await rq('PATCH', '/api/academy', { token: dir, body: { code: 'mago' } })).academy.code, 'mago');
    error(await rq('PATCH', '/api/academy', { token: other, body: { code: 'mago' } }), 400, 'academy_code_taken');
    error(await rq('PATCH', '/api/academy', { token: admin, body: { code: 'other' } }), 400, 'academy_required');
    assert.equal(ok(await rq('PATCH', `/api/academy?academy=${otherDirector.academy.id}`, { token: admin, body: { code: 'other' } })).academy.code, 'other');
    error(await rq('GET', '/api/academy?academy=99999', { token: admin }), 404, 'not_found');
  });

  await t.test('직접 생성: 명단 필수·한 학생 하나·아이디 대소문자 중복·비밀번호 검증', async () => {
    error(await create('missing', 'no-student'), 404, 'no_student');
    error(await create(outsider.id, 'other-student'), 404, 'no_student');
    error(await create(student.id, 'a'), 400, 'invalid_username');
    error(await rq('POST', `/api/students/${student.id}/account`, { token: teach, body: { username: 'first', password: '123' } }), 400, 'weak_password');
    const made = ok(await create(student.id, 'First.Student'));
    assert.deepEqual(made.account, { username: 'first.student', status: 'active', mustChangePassword: false, aiMode: 'academy', lastLoginAt: null });
    error(await create(student.id, 'another-name'), 400, 'account_exists');
    error(await create(second.id, 'FIRST.STUDENT'), 400, 'username_taken');
    const user = ok(await login('FIRST.STUDENT')).user;
    assert.deepEqual(user.student, { id: student.id, name: student.name, school: '', schoolOffice: '', schoolCode: '', teacherUid: s.teacher.id, teacherName: s.teacher.name });
    assert.equal(user.roleLabel, '학생');
    assert.equal(user.aiMode, 'academy');
    assert.equal(user.mustChangePassword, false);
    error(await rq('PATCH', `/api/users/${user.id}`, { token: admin, body: { academyId: otherDirector.academy.id } }), 403, 'forbidden');
    const list = ok(await rq('GET', '/api/students', { token: teach })).students;
    assert.equal(list.find((x) => x.id === second.id).account, null);
    assert.ok(list.find((x) => x.id === student.id).account.lastLoginAt > 0);
    for (const token of [admin, dir]) assert.ok(ok(await rq('GET', '/api/users', { token })).users.every((u) => u.role !== 'student'));
    assert.deepEqual(ok(await rq('GET', '/api/users?role=student', { token: admin })).users, []);
    assert.ok(ok(await rq('GET', '/api/academy/members', { token: teach })).members.every((u) => u.role !== 'student'));
    error(await rq('PATCH', `/api/students/${second.id}`, { token: teach, body: { teacherId: user.id } }), 400, 'invalid_teacher');
  });

  let bulk;
  await t.test('일괄: KST 월 경계·기존 아이디 충돌 건너뛰기·순서 유지·기존 계정 제외', async (t) => {
    t.mock.method(Date, 'now', () => Date.parse('2026-10-31T15:00:00Z'));
    ok(await rq('PATCH', `/api/students/${student.id}/account`, { token: teach, body: { username: 'MAGO2611001' } }));
    bulk = ok(await rq('POST', '/api/students/accounts/bulk', { token: teach, body: { studentIds: [student.id, second.id, third.id, outsider.id, 'missing'] } }));
    assert.deepEqual(bulk.created.map((x) => [x.studentId, x.name, x.username]), [[second.id, second.name, 'mago2611002'], [third.id, third.name, 'mago2611003']]);
    assert.deepEqual(bulk.skipped, [
      { studentId: student.id, name: student.name, reason: 'account_exists' },
      { studentId: outsider.id, name: '', reason: 'no_student' },
      { studentId: 'missing', name: '', reason: 'no_student' },
    ]);
    for (const u of bulk.created) {
      const row = db.get('SELECT * FROM users WHERE student_id = ?', u.studentId);
      assert.equal(row.must_change_password, 1);
      assert.ok(verifyPassword(u.password, row.password_hash));
      assert.notEqual(u.password, row.password_hash);
    }
    const again = ok(await rq('POST', '/api/students/accounts/bulk', { token: teach, body: { studentIds: [second.id] } }));
    assert.deepEqual(again.created, []);
    assert.equal(again.skipped[0].reason, 'account_exists');
    assert.ok(!JSON.stringify(db.all('SELECT * FROM audit')).includes(bulk.created[0].password));
  });

  await t.test('학번: 아이디 변경 뒤에도 번호 유지, 새 KST 월에는 001부터', async (t) => {
    const fourth = await add('넷째');
    const fifth = await add('다섯째');
    t.mock.method(Date, 'now', () => Date.parse('2026-11-30T14:59:59Z'));
    ok(await rq('PATCH', `/api/students/${third.id}/account`, { token: teach, body: { username: 'third-renamed' } }));
    const a = ok(await rq('POST', '/api/students/accounts/bulk', { token: teach, body: { studentIds: [fourth.id] } }));
    assert.equal(a.created[0].username, 'mago2611004');
    t.mock.method(Date, 'now', () => Date.parse('2026-11-30T15:00:00Z'));
    const b = ok(await rq('POST', '/api/students/accounts/bulk', { token: teach, body: { studentIds: [fifth.id] } }));
    assert.equal(b.created[0].username, 'mago2612001');
  });

  await t.test('계정 관리: 변경·중지·재활성·초기화·삭제, 다른 학원 접근 거절', async () => {
    let token = ok(await login('mago2611001')).token;
    for (const [method, suffix, body] of [
      ['POST', 'account', { username: 'wrong', password: PASSWORD }], ['PATCH', 'account', { resetPassword: true }],
      ['DELETE', 'account'], ['POST', 'invite'], ['DELETE', 'invite'],
    ]) error(await rq(method, `/api/students/${student.id}/${suffix}`, { token: other, body }), 404, 'no_student');
    error(await rq('PATCH', `/api/students/${student.id}/account`, { token: teach, body: { aiMode: 'wrong' } }), 400, 'invalid_ai_mode');
    error(await rq('PATCH', `/api/students/${student.id}/account`, { token: teach, body: { status: 'suspended' } }), 400, 'invalid_status');
    const patch = ok(await rq('PATCH', `/api/students/${student.id}/account`, { token: teach, body: { username: 'renamed', aiMode: 'teacher', status: 'disabled' } }));
    assert.equal(patch.account.status, 'disabled');
    error(await rq('GET', '/api/me', { token }), 401, 'session_invalid');
    error(await login('renamed'), 403, 'account_suspended');
    ok(await rq('PATCH', `/api/students/${student.id}/account`, { token: teach, body: { status: 'active' } }));
    token = ok(await login('renamed')).token;
    const reset = ok(await rq('PATCH', `/api/students/${student.id}/account`, { token: teach, body: { resetPassword: true } }));
    assert.deepEqual(Object.keys(reset), ['password']);
    error(await rq('GET', '/api/me', { token }), 401, 'session_invalid');
    const after = ok(await login('renamed', reset.password));
    assert.equal(after.user.mustChangePassword, true);
    assert.equal(after.user.aiMode, 'teacher');
    ok(await rq('DELETE', `/api/students/${student.id}/account`, { token: teach }));
    error(await rq('GET', '/api/me', { token: after.token }), 401, 'session_invalid');
    assert.ok(db.get('SELECT 1 FROM students WHERE id = ?', student.id));
    assert.equal(ok(await rq('GET', '/api/students', { token: teach })).students.find((x) => x.id === student.id).account, null);
    error(await create(student.id, 'new-account', admin + '-wrong'), 401, 'session_invalid');
    ok(await rq('POST', `/api/students/${student.id}/account?academy=${da.academy.id}`, { token: admin, body: { username: 'new-account', password: PASSWORD } }));
    assert.ok(events.mock.calls.some((c) => c.arguments[0] === da.academy.id && c.arguments[1] === 'students'));
    assert.ok(db.get("SELECT 1 FROM audit WHERE action = 'student.account.password_reset'"));
  });
});

test('학생 초대: 7일·해시만 저장·재발급·폐기·일회용 웹 가입', async (t) => {
  const s = await setup(t);
  const { rq, teach, add, create } = s;
  const db = s.app.deps.db;
  const student = await add('초대 학생');
  const issue = async () => ok(await rq('POST', `/api/students/${student.id}/invite`, { token: teach }));
  let first = await issue();
  assert.deepEqual(Object.keys(first).sort(), ['code', 'expiresAt']);
  const row = db.get('SELECT * FROM student_invites WHERE student_id = ?', student.id);
  assert.equal(row.expires_at - row.created_at, 7 * DAY);
  assert.equal(row.code_hash, sha256Hex(first.code));
  assert.ok(!JSON.stringify(row).includes(first.code));
  assert.deepEqual(ok(await rq('GET', `/api/join/${first.code}`)), { academyName: '가학원', studentName: student.name });
  const second = await issue();
  error(await rq('GET', `/api/join/${first.code}`), 404, 'invalid_code');
  ok(await rq('DELETE', `/api/students/${student.id}/invite`, { token: teach }));
  error(await rq('GET', `/api/join/${second.code}`), 404, 'invalid_code');
  first = await issue();
  db.run('UPDATE student_invites SET expires_at = ? WHERE student_id = ?', Date.now() - 1, student.id);
  error(await rq('GET', `/api/join/${first.code}`), 404, 'invalid_code');
  error(await rq('POST', '/api/join', { body: { code: first.code, username: 'expired', password: PASSWORD } }), 404, 'invalid_code');
  first = await issue();
  error(await rq('POST', '/api/join', { body: { code: first.code, username: 'ADMIN', password: PASSWORD } }), 400, 'username_taken');
  error(await rq('POST', '/api/join', { body: { code: first.code, username: 'join-student', password: '1' } }), 400, 'weak_password');
  const joined = ok(await rq('POST', '/api/join', { body: { code: first.code, username: 'Join.Student', password: PASSWORD, device: { platform: 'windows' } } }));
  assert.deepEqual(Object.keys(joined).sort(), ['server', 'token', 'user']);
  assert.equal(joined.user.username, 'join.student');
  assert.equal(joined.user.mustChangePassword, false);
  assert.equal(joined.user.student.id, student.id);
  assert.equal(db.get('SELECT platform FROM sessions WHERE token_hash = ?', sha256Hex(joined.token)).platform, 'web');
  assert.ok(db.get('SELECT used_at FROM student_invites WHERE student_id = ?', student.id).used_at);
  ok(await rq('GET', '/api/me', { token: joined.token }));
  error(await rq('POST', '/api/join', { body: { code: first.code, username: 'reuse', password: PASSWORD } }), 404, 'invalid_code');
  error(await rq('GET', `/api/join/${first.code}`), 404, 'invalid_code');
  error(await rq('POST', `/api/students/${student.id}/invite`, { token: teach }), 400, 'account_exists');
  assert.ok(!JSON.stringify(db.all('SELECT * FROM audit')).includes(first.code));

  const direct = await add('직접 발급 학생');
  const oldInvite = ok(await rq('POST', `/api/students/${direct.id}/invite`, { token: teach }));
  ok(await create(direct.id, 'direct-invite'));
  ok(await rq('DELETE', `/api/students/${direct.id}/account`, { token: teach }));
  error(await rq('GET', `/api/join/${oldInvite.code}`), 404, 'invalid_code');

  const concurrent = await add('동시 가입 학생');
  const concurrentInvite = ok(await rq('POST', `/api/students/${concurrent.id}/invite`, { token: teach }));
  const attempts = await Promise.all(['join-one', 'join-two'].map((username) => rq('POST', '/api/join', { body: { code: concurrentInvite.code, username, password: PASSWORD } })));
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 404]);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM users WHERE student_id = ?', concurrent.id).n, 1);
});

test('학생 인증: 임시 비밀번호 강제·허용 목록·PC 거절·본인 변경', async (t) => {
  const s = await setup(t);
  const { rq, dir, teach, add, login } = s;
  const student = await add('임시 학생');
  ok(await rq('PATCH', '/api/academy', { token: dir, body: { code: 'mago' } }));
  const made = ok(await rq('POST', '/api/students/accounts/bulk', { token: teach, body: { studentIds: [student.id] } })).created[0];
  for (const platform of ['windows', 'android', 'web-app', '', 'WEB']) error(await login(made.username, made.password, platform), 403, 'student_web_only');
  const token = ok(await login(made.username, made.password)).token;
  assert.equal(ok(await rq('GET', '/api/me', { token })).user.mustChangePassword, true);
  for (const [method, url] of [['GET', '/api/notices'], ['GET', '/api/students'], ['PATCH', '/api/me'], ['PATCH', '/api/me/username'], ['POST', '/api/sso/authorize'], ['GET', '/api/ai/relay/mago-navi/models']]) {
    error(await rq(method, url, { token, body: method === 'GET' ? undefined : {} }), 403, 'password_change_required');
  }
  const auth = (method, path) => s.app.deps.svc.authenticate({ req: { method, headers: { authorization: `Bearer ${token}` } }, path, ip: '127.0.0.1' });
  for (const path of ['/api/me/notes', '/api/me/notes/note-id/pdf']) assert.throws(() => auth('GET', path), (e) => e.code === 'password_change_required');
  error(await rq('PATCH', '/api/me/password', { token, body: { currentPassword: 'wrong', newPassword: PASSWORD } }), 400, 'invalid_password');
  error(await rq('PATCH', '/api/me/password', { token, body: { currentPassword: made.password, newPassword: made.password } }), 400, 'same_password');
  assert.equal(ok(await rq('PATCH', '/api/me/password', { token, body: { currentPassword: made.password, newPassword: PASSWORD } })).user.mustChangePassword, false);
  ok(await rq('GET', '/api/notices', { token }));
  for (const path of ['/api/me/notes', '/api/me/notes/note-id/pdf', '/api/me/notes/']) assert.equal(auth('GET', path).user.student_id, student.id);
  for (const [method, path] of [['POST', '/api/me/notes'], ['GET', '/api/me/notes/other'], ['GET', '/api/me/notes/note-id/pdf/extra'], ['GET', '/api/me/notes-secret']]) {
    assert.throws(() => auth(method, path), (e) => e.status === 403 && e.code === 'student_forbidden');
  }
  for (const [method, url] of [
    ['GET', '/api/meta'], ['GET', '/api/launcher'], ['GET', '/api/not-a-route'],
    ['GET', '/api/students'], ['POST', '/api/students'], ['PATCH', `/api/students/${student.id}`], ['DELETE', `/api/students/${student.id}`],
    ['POST', `/api/students/${student.id}/account`], ['POST', `/api/students/${student.id}/invite`], ['GET', '/api/academy'], ['PATCH', '/api/academy'],
    ['GET', '/api/academy/members'], ['GET', '/api/academy/ai'], ['GET', '/api/academy/ai/all'], ['PUT', '/api/academy/ai'],
    ['GET', '/api/users'], ['GET', '/api/admin/apps'], ['GET', '/api/apps'], ['POST', '/api/apps/ohdapnote/ticket'], ['POST', '/api/apps/ohdapnote/download-link'],
    ['GET', '/api/me/data-key'], ['GET', '/api/me/devices'], ['PATCH', '/api/me/name'], ['POST', '/api/notices'],
    ['GET', '/api/sync/events'], ['GET', '/api/sync/ohdapnote'], ['GET', '/api/sync/ohdapnote/academy'],
    ['GET', '/api/ai/relay/ohdapnote/v1beta/models'],
  ]) error(await rq(method, url, { token, body: ['GET', 'DELETE'].includes(method) ? undefined : {} }), 403, 'student_forbidden');
  const renamed = ok(await rq('PATCH', '/api/me', { token, body: { username: 'My.Student', role: 'admin', aiMode: 'teacher' } })).user;
  assert.equal(renamed.username, 'my.student');
  assert.equal(renamed.role, 'student');
  assert.equal(renamed.aiMode, 'academy');
  error(await rq('PATCH', '/api/me', { token, body: { username: 'ADMIN' } }), 400, 'username_taken');
  error(await rq('PATCH', '/api/me', { token, body: { username: 'a' } }), 400, 'invalid_username');
  ok(await rq('PATCH', `/api/students/${student.id}`, { token: teach, body: { name: '바뀐 학생', teacherId: s.da.id } }));
  const me = ok(await rq('GET', '/api/me', { token })).user;
  assert.deepEqual(me.student, { id: student.id, name: '바뀐 학생', school: '', schoolOffice: '', schoolCode: '', teacherUid: s.da.id, teacherName: s.da.name });
  assert.equal(me.name, '바뀐 학생');
  ok(await rq('POST', '/api/auth/logout', { token }));
  error(await rq('GET', '/api/me', { token }), 401, 'session_invalid');
  const user = s.app.deps.db.get('SELECT * FROM users WHERE student_id = ?', student.id);
  assert.throws(() => s.app.deps.svc.createSession(user, { platform: 'windows' }, ''), (e) => e.code === 'student_web_only');
});

test('학생 명단 삭제·복구·완전 삭제는 계정·세션·초대에도 반영', async (t) => {
  const s = await setup(t);
  const { rq, teach, add, create, login } = s;
  const db = s.app.deps.db;
  const student = await add('삭제 학생');
  ok(await create(student.id, 'delete-student'));
  const token = ok(await login('delete-student')).token;
  const user = db.get('SELECT * FROM users WHERE student_id = ?', student.id);
  const appToken = s.app.deps.svc.createSession(user, { id: 'app', platform: 'web-app' }, '', { appId: 'mago-navi' });
  ok(await rq('DELETE', `/api/students/${student.id}`, { token: teach }));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', user.id).n, 0);
  for (const value of [token, appToken]) error(await rq('GET', '/api/me', { token: value }), 401, 'session_invalid');
  error(await login('delete-student'), 403, 'account_suspended');
  assert.equal(ok(await rq('GET', '/api/students', { token: teach })).students.find((x) => x.id === student.id).account.status, 'disabled');
  error(await rq('PATCH', `/api/students/${student.id}/account`, { token: teach, body: { status: 'active' } }), 400, 'student_deleted');
  ok(await rq('POST', `/api/students/${student.id}/restore`, { token: teach }));
  const restored = ok(await login('delete-student')).token;
  ok(await rq('GET', '/api/me', { token: restored }));
  ok(await rq('DELETE', `/api/students/${student.id}`, { token: teach }));
  db.run('UPDATE students SET deleted_at = ? WHERE id = ?', Date.now() - 31 * DAY, student.id);
  assert.equal(s.app.deps.students.purgeExpired().students, 1);
  assert.equal(db.get('SELECT * FROM users WHERE student_id = ?', student.id), undefined);
  assert.ok(db.get('SELECT purged_at FROM students WHERE id = ?', student.id).purged_at);
  error(await rq('POST', `/api/students/${student.id}/restore`, { token: teach }), 404, 'no_student');
  error(await create(student.id, 'purged-account'), 404, 'no_student');

  const invited = await add('초대 삭제');
  const invite = ok(await rq('POST', `/api/students/${invited.id}/invite`, { token: teach }));
  ok(await rq('DELETE', `/api/students/${invited.id}`, { token: teach }));
  error(await rq('GET', `/api/join/${invite.code}`), 404, 'invalid_code');
  error(await create(invited.id, 'deleted-account'), 400, 'student_deleted');
  error(await rq('POST', `/api/students/${invited.id}/invite`, { token: teach }), 400, 'student_deleted');
  ok(await rq('POST', `/api/students/${invited.id}/restore`, { token: teach }));
  error(await rq('GET', `/api/join/${invite.code}`), 404, 'invalid_code');
});

test('학생 SSO·학원 AI: 자기 정보만·웹 앱 범위·원장 허가·담당 선생님 키 분기', async (t) => {
  const seen = [];
  const ai = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => ai.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => ai.close(resolve)));
  const s = await setup(t, { aiRelayAllowPrivate: true });
  const { rq, teach, dir, admin, add, create, login } = s;
  const student = await add('SSO 학생');
  await add('보이면 안 되는 학생');
  await add('다른 학원 학생', s.other);
  ok(await create(student.id, 'sso-student'));
  const token = ok(await login('sso-student')).token;
  ok(await rq('PATCH', '/api/admin/apps/mago-navi', { token: admin, body: { enabled: true } }));
  const secret = ok(await rq('POST', '/api/admin/apps/mago-navi/secret', { token: admin })).secret;
  const authorize = () => rq('POST', '/api/sso/authorize', { token, body: { appId: 'mago-navi', state: 'student-state' } });
  const exchange = (code) => rq('POST', '/api/sso/token', { body: { appId: 'mago-navi', secret, code } });
  const code = ok(await authorize()).code;
  const appToken = ok(await exchange(code)).token;
  error(await exchange(code), 400, 'invalid_code');
  assert.equal(ok(await rq('GET', '/api/me', { token: appToken })).user.student.id, student.id);
  const list = ok(await rq('GET', '/api/students', { token: appToken }));
  assert.deepEqual(list.students.map((x) => x.id), [student.id]);
  assert.equal(list.students[0].memo, undefined);
  assert.equal(list.students[0].account, undefined);
  assert.deepEqual(list.purged, []);
  for (const [method, url] of [['POST', '/api/students'], ['PATCH', `/api/students/${student.id}`], ['GET', '/api/academy/ai/all'], ['GET', '/api/sync/ohdapnote/academy']]) {
    error(await rq(method, url, { token: appToken, body: method === 'GET' ? undefined : {} }), 403, 'student_forbidden');
  }
  // 과목내비 서버가 학원 AI 종류·모델을 읽음 (키는 없음). 학생 웹 세션으로는 못 읽음
  assert.equal(ok(await rq('GET', '/api/academy/ai', { token: appToken })).app, 'mago-navi');
  error(await rq('GET', '/api/academy/ai', { token }), 403, 'student_forbidden');
  error(await rq('POST', '/api/sso/authorize', { token: appToken, body: { appId: 'mago-navi' } }), 403, 'app_session');
  error(await rq('PATCH', '/api/me', { token: appToken, body: { username: 'wrong-app' } }), 403, 'app_session');
  error(await rq('POST', '/api/sso/authorize', { token, body: { appId: 'ohdapnote' } }), 404, 'no_app');
  ok(await rq('PUT', '/api/academy/ai', { token: dir, body: { app: 'mago-navi', config: { provider: 'openai', baseUrl: `http://127.0.0.1:${ai.address().port}`, apiKey: 'academy-secret' } } }));
  const academyAi = ok(await rq('GET', '/api/academy/ai', { token: appToken })).ai;
  assert.equal(academyAi.provider, 'openai');
  assert.equal(JSON.stringify(academyAi).includes('academy-secret'), false);
  for (const value of [token, appToken]) ok(await rq('POST', '/api/ai/relay/mago-navi/chat/completions', { token: value, body: { messages: [] } }));
  assert.deepEqual(seen, ['Bearer academy-secret', 'Bearer academy-secret']);
  const user = s.app.deps.db.get('SELECT * FROM users WHERE student_id = ?', student.id);
  const wrongApp = s.app.deps.svc.createSession(user, { id: 'wrong-app', platform: 'web-app' }, '', { appId: 'other-web' });
  error(await rq('GET', '/api/ai/relay/mago-navi/models', { token: wrongApp }), 403, 'app_session');
  error(await rq('GET', '/api/ai/relay/ohdapnote/v1beta/models', { token: appToken }), 403, 'student_forbidden');
  ok(await rq('PATCH', `/api/students/${student.id}/account`, { token: teach, body: { aiMode: 'teacher' } }));
  for (const value of [token, appToken]) error(await rq('GET', '/api/ai/relay/mago-navi/models', { headers: { 'x-goog-api-key': value } }), 403, 'student_ai_teacher');
  assert.equal(seen.length, 2);
  assert.equal(ok(await rq('GET', '/api/me', { token: appToken })).user.aiMode, 'teacher');
  ok(await rq('PATCH', `/api/students/${student.id}/account`, { token: teach, body: { aiMode: 'academy' } }));
  ok(await rq('PATCH', `/api/users/${s.da.id}`, { token: admin, body: { allowedApps: [] } }));
  error(await authorize(), 403, 'forbidden');
  error(await rq('GET', '/api/ai/relay/mago-navi/models', { token: appToken }), 403, 'forbidden');
  ok(await rq('PATCH', `/api/users/${s.da.id}`, { token: admin, body: { allowedApps: null } }));
  const pending = ok(await authorize()).code;
  const reset = ok(await rq('PATCH', `/api/students/${student.id}/account`, { token: teach, body: { resetPassword: true } }));
  error(await exchange(pending), 403, 'password_change_required');
  for (const value of [token, appToken]) error(await rq('GET', '/api/me', { token: value }), 401, 'session_invalid');
  const temporary = ok(await login('sso-student', reset.password)).token;
  ok(await rq('POST', '/api/auth/logout', { token: temporary }));
  const ticket = signTicket(s.app.deps.keys, { typ: 'app', app: 'mago-navi', sub: user.uid, dev: 'student-web', exp: Math.floor(Date.now() / 1000) + 60 });
  error(await rq('GET', '/api/ai/relay/mago-navi/models', { token: ticket }), 403, 'student_web_only');
});
