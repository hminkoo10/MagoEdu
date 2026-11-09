'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDb, MIGRATIONS } = require('../src/db');
const { startServer, ADMIN_PASSWORD } = require('./helpers');
const { DAY } = require('../src/util');
const { confirmConsentSms, CONSENT_VERSION } = require('../src/routes/guardians');
const PASSWORD = 'guardian-pass-1234';
const ok = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};

test('직원 목록과 담당 선생님에서 학생·보호자 제외', async (t) => {
  const s = await setup(t);
  const joined = ok(await s.join((await s.invite()).code));
  ok(
    await s.rq('POST', `/api/students/${s.student.id}/account`, {
      token: s.dir,
      body: { username: 'student-test', password: PASSWORD },
    }),
  );
  for (const token of [s.admin, s.dir]) {
    const users = ok(await s.rq('GET', '/api/users', { token })).users;
    assert.ok(users.some((u) => u.id === s.teacher.id));
    assert.ok(users.every((u) => !['student', 'guardian'].includes(u.role)));
    assert.deepEqual(ok(await s.rq('GET', '/api/users?role=guardian', { token })).users, []);
    const suffix = token === s.admin ? `?academy=${s.db.get("SELECT academy_id FROM users WHERE username = 'director-a'").academy_id}` : '';
    const members = ok(await s.rq('GET', '/api/academy/members' + suffix, { token })).members;
    assert.ok(members.some((u) => u.id === s.teacher.id));
    assert.ok(members.every((u) => !['student', 'guardian'].includes(u.role)));
  }
  assert.equal(ok(await s.rq('GET', '/api/guardian-accounts', { token: s.dir })).accounts[0].id, joined.user.id);
  const studentUser = s.db.get("SELECT uid FROM users WHERE username = 'student-test'");
  for (const teacherId of [joined.user.id, studentUser.uid]) {
    const create = await s.rq('POST', '/api/students', { token: s.dir, body: { name: '새 학생', teacherId } });
    assert.equal(create.data.error.code, 'invalid_teacher');
    const update = await s.rq('PATCH', `/api/students/${s.student.id}`, {
      token: s.dir,
      body: { baseRev: s.student.rev, teacherId },
    });
    assert.equal(update.data.error.code, 'invalid_teacher');
  }
});

test('가입은 수집·알림 동의만 받고 미사용 항목 거절', async (t) => {
  const s = await setup(t);
  const { code } = await s.invite();
  const body = { code, username: 'guardian-a', password: PASSWORD, name: '보호자', consentVersion: CONSENT_VERSION };
  for (const item of ['overseas_ai', 'marketing']) {
    const result = await s.rq('POST', '/api/join', { body: { ...body, consents: { collect: true, [item]: true } } });
    assert.equal(result.status, 400);
    assert.equal(s.db.get('SELECT COUNT(*) AS n FROM guardian_consents').n, 0);
  }
  ok(await s.join(code));
  assert.deepEqual(
    s.db.all('SELECT item FROM guardian_consents ORDER BY item').map((c) => c.item),
    ['collect', 'messaging'],
  );
});
async function setup(t) {
  const s = await startServer();
  t.after(() => s.close());
  const rq = s.request,
    admin = await s.login('admin', ADMIN_PASSWORD);
  const make = async (token, b) =>
    ok(await rq('POST', '/api/users', { token, body: { password: PASSWORD, mustChangePassword: false, ...b } })).user;
  const d = await make(admin, { role: 'director', username: 'director-a', name: '원장', academyName: '가학원' });
  await make(admin, { role: 'director', username: 'director-b', name: '다른원장', academyName: '나학원' });
  const dir = await s.login('director-a', PASSWORD),
    other = await s.login('director-b', PASSWORD);
  const teacher = await make(dir, { username: 'teacher-a', name: '선생님' }),
    teach = await s.login('teacher-a', PASSWORD);
  const student = ok(await rq('POST', '/api/students', { token: dir, body: { name: '자녀', teacherId: teacher.id } })).student;
  const root = `/api/students/${student.id}/guardians`;
  const g = ok(
    await rq('POST', root, { token: dir, body: { name: '보호자', relation: '어머니', phone: '010-1234-5678', isPrimary: true } }),
  ).guardian;
  const invite = async (gid = g.id) => ok(await rq('POST', `${root}/${gid}/invite`, { token: dir }));
  const join = async (code, token, username = 'guardian-a') =>
    rq('POST', '/api/join', {
      token,
      body: {
        code,
        username,
        password: PASSWORD,
        name: '보호자',
        consentVersion: CONSENT_VERSION,
        consents: { collect: true, messaging: true },
      },
    });
  return { ...s, rq, admin, dir, other, teach, teacher, student, root, g, invite, join, db: s.app.deps.db, d };
}
test('보호자 마이그레이션: main 모든 행·열·연결·색인·트리거·증가번호 및 재개방 보존', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-mig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'db');
  let raw = new DatabaseSync(file);
  for (const sql of MIGRATIONS.slice(0, 12)) raw.exec(sql);
  raw.exec(
    `PRAGMA user_version=12;
    INSERT INTO academies(id,name,created_at)VALUES(1,'학원',1);
    INSERT INTO students(id,academy_id,name,created_at,updated_at)VALUES('student-1',1,'학생',1,1);
    INSERT INTO users(uid,username,name,role,academy_id,student_id,password_hash,ai_mode,created_at,updated_at)VALUES('u','student','학생','student',1,'student-1','hash','teacher',1,2);
    INSERT INTO sessions(token_hash,user_id,device_id,created_at,last_seen_at,expires_at)VALUES('h',1,'d',1,1,9999999999999);
    CREATE INDEX extra_user_name ON users(name);
    CREATE TRIGGER extra_user AFTER UPDATE OF name ON users BEGIN UPDATE users SET updated_at=77 WHERE id=NEW.id;
    END;
    UPDATE sqlite_sequence SET seq=80 WHERE name='users';`,
  );
  const users = raw.prepare('SELECT * FROM users').all(),
    sessions = raw.prepare('SELECT * FROM sessions').all();
  raw.close();
  for (let i = 0; i < 2; i++) {
    const db = openDb(file);
    assert.deepEqual(db.all('SELECT * FROM users'), users);
    assert.deepEqual(db.all('SELECT * FROM sessions'), sessions);
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    assert.ok(db.get("SELECT 1 FROM sqlite_schema WHERE name='extra_user_name'"));
    assert.ok(db.get("SELECT 1 FROM sqlite_schema WHERE name='extra_user'"));
    assert.equal(db.get("SELECT seq FROM sqlite_sequence WHERE name='users'").seq, 80);
    db.close();
  }
});
test('보호자 관리: 학원·담당 권한, 암호화, rev 충돌, 종이/온라인 동의, 철회, 연결끊기·삭제', async (t) => {
  const s = await setup(t);
  const { rq, dir, other, teach, root, g, db } = s;
  const unassigned = ok(await rq('POST', '/api/students', { token: dir, body: { name: '미담당' } })).student;
  assert.equal((await rq('GET', `/api/students/${unassigned.id}/guardians`, { token: teach })).status, 403);
  assert.equal(ok(await rq('GET', root, { token: teach })).guardians[0].phone, '010-1234-5678');
  assert.equal((await rq('GET', root, { token: other })).status, 404);
  assert.equal((await rq('PATCH', `${root}/${g.id}`, { token: teach, body: { rev: 1, name: '수정' } })).status, 403);
  assert.ok(!JSON.stringify(db.all('SELECT * FROM guardians')).includes('010-1234-5678'));
  ok(await rq('PATCH', `${root}/${g.id}`, { token: dir, body: { rev: 1, name: '수정' } }));
  assert.equal((await rq('PATCH', `${root}/${g.id}`, { token: dir, body: { rev: 1, name: '충돌' } })).status, 409);
  const paper = ok(await rq('POST', `${root}/${g.id}/consents`, { token: dir, body: { item: 'collect', version: 'paper-1' } })).consent;
  assert.equal(paper.verified, true);
  const joined = ok(await s.join((await s.invite()).code));
  const token = joined.token;
  assert.equal(joined.user.children[0].studentId, s.student.id);
  assert.ok(!JSON.stringify(ok(await rq('GET', '/api/me/guardians', { token }))).includes('010-1234-5678'));
  let cs = ok(await rq('GET', '/api/me/consents', { token })).consents;
  const online = cs.find((c) => c.method === 'online' && c.item === 'collect');
  assert.equal(online.verified, false);
  assert.equal(confirmConsentSms(db, online.id), 1);
  assert.equal(confirmConsentSms(db, online.id), 0);
  cs = ok(await rq('GET', '/api/me/consents', { token })).consents;
  assert.equal(cs.find((c) => c.id === online.id).verified, true);
  assert.equal((await rq('POST', `/api/me/consents/${online.id}/withdraw`, { token })).status, 400);
  ok(await rq('POST', `/api/me/consents/${cs.find((c) => c.item === 'messaging').id}/withdraw`, { token }));
  ok(await rq('DELETE', `${root}/${g.id}/account-link`, { token: dir }));
  assert.deepEqual(ok(await rq('GET', '/api/me', { token })).user.children, []);
  ok(await rq('DELETE', `/api/guardian-accounts/${joined.user.id}`, { token: dir }));
  assert.equal((await rq('GET', '/api/me', { token })).status, 401);
});
test('보호자 초대: 재발급·만료·일회성·같은 학원 다자녀·다른 학원 거절·실패 한도', async (t) => {
  const s = await setup(t);
  const canceled = await s.invite();
  ok(await s.rq('DELETE', s.root + '/' + s.g.id + '/invite', { token: s.dir }));
  assert.equal((await s.rq('GET', '/api/join/' + canceled.code)).status, 404);
  const a = await s.invite(),
    b = await s.invite();
  assert.equal(b.expiresAt - s.db.get('SELECT created_at FROM guardian_invites WHERE guardian_id=?', s.g.id).created_at, 7 * DAY);
  assert.equal((await s.rq('GET', `/api/join/${a.code}`)).status, 404);
  s.db.run('UPDATE guardian_invites SET expires_at=? WHERE guardian_id=?', Date.now() - 1, s.g.id);
  assert.equal((await s.join(b.code)).status, 404);
  const c = await s.invite();
  const joined = ok(await s.join(c.code));
  assert.equal((await s.join(c.code)).status, 404);
  const child = ok(await s.rq('POST', '/api/students', { token: s.dir, body: { name: '둘째' } })).student;
  const root = `/api/students/${child.id}/guardians`;
  const g = ok(await s.rq('POST', root, { token: s.dir, body: { name: '같은 보호자', phone: '010-1111-2222' } })).guardian;
  const i = ok(await s.rq('POST', `${root}/${g.id}/invite`, { token: s.dir }));
  assert.equal((await s.join(i.code, s.other)).status, 403);
  const linked = ok(await s.join(i.code, joined.token));
  assert.equal(linked.user.id, joined.user.id);
  assert.equal(linked.user.children.length, 2);
  const otherStudent = ok(await s.rq('POST', '/api/students', { token: s.other, body: { name: '다른 학원' } })).student;
  const og = ok(
    await s.rq('POST', `/api/students/${otherStudent.id}/guardians`, { token: s.other, body: { name: '보호자', phone: '010-5555-6666' } }),
  ).guardian;
  const oi = ok(await s.rq('POST', `/api/students/${otherStudent.id}/guardians/${og.id}/invite`, { token: s.other }));
  assert.equal((await s.join(oi.code, linked.token)).data.error.code, 'guardian_account_mismatch');
  for (let n = 0; n < 20; n++) await s.rq('GET', '/api/join/wrong');
  assert.equal((await s.rq('GET', '/api/auth/codes/wrong')).status, 429);
});
test('보호자 권한: 등록 라우트 전수 기본차단 + SSO opt-in·앱 세션 범위·purge', async (t) => {
  const s = await setup(t);
  const joined = ok(await s.join((await s.invite()).code));
  const token = joined.token;
  // 등록한 라우트 전체를 검사한다. 새 라우트도 자동으로 검사 대상에 들어간다.
  const routes = s.app.routes;
  const allowed = new Set([
    'GET /api/me',
    'GET /api/me/guardians',
    'GET /api/me/consents',
    'POST /api/me/consents/:cid/withdraw',
    'PATCH /api/me/password',
    'POST /api/auth/logout',
    'POST /api/sso/authorize',
    'POST /api/join',
    'GET /api/join/:code',
  ]);
  let blocked = 0;
  for (const r of routes) {
    if (allowed.has(`${r.method} ${r.pattern}`)) continue;
    const url = r.pattern.replace(/:[\w]+/g, 'audit-value').replace('/*', '/audit');
    const result = await s.rq(r.method, url, { token, ...(r.method === 'GET' ? {} : { body: {} }) });
    assert.ok([401, 403].includes(result.status), `${r.method} ${url}: ${result.status}`);
    blocked++;
  }
  t.diagnostic(`차단 라우트 ${blocked}개 / 전체 ${routes.length}개`);
  assert.ok(blocked > 100);
  s.app.deps.catalog.upsert({ id: 'guardian-app', name: '웹', platform: 'web', source: { type: 'web', url: 'https://example.invalid' } });
  assert.equal((await s.rq('POST', '/api/sso/authorize', { token, body: { appId: 'guardian-app' } })).status, 403);
  ok(await s.rq('PATCH', '/api/admin/apps/guardian-app', { token: s.admin, body: { guardianEnabled: true } }));
  const secret = ok(await s.rq('POST', '/api/admin/apps/guardian-app/secret', { token: s.admin })).secret;
  const code = ok(await s.rq('POST', '/api/sso/authorize', { token, body: { appId: 'guardian-app' } })).code;
  const appToken = ok(await s.rq('POST', '/api/sso/token', { body: { appId: 'guardian-app', secret, code } })).token;
  assert.equal(ok(await s.rq('GET', '/api/me', { token: appToken })).user.children.length, 1);
  for (const r of routes) {
    if (
      (r.method === 'GET' && ['/api/me', '/api/me/consents'].includes(r.pattern)) ||
      (r.method === 'POST' && r.pattern === '/api/auth/logout')
    )
      continue;
    const url = r.pattern.replace(/:[\w]+/g, 'audit-value').replace('/*', '/audit');
    const result = await s.rq(r.method, url, { token: appToken, ...(r.method === 'GET' ? {} : { body: {} }) });
    assert.ok([401, 403].includes(result.status), r.method + ' ' + url + ': ' + result.status);
  }
  const directorUser = s.db.get("SELECT * FROM users WHERE username='director-a'");
  const directorAppToken = s.app.deps.svc.createSession(directorUser, { platform: 'web-app' }, '127.0.0.1', { appId: 'guardian-app' });
  const teacherUser = s.db.get("SELECT * FROM users WHERE username='teacher-a'");
  const teacherAppToken = s.app.deps.svc.createSession(teacherUser, { platform: 'web-app' }, '127.0.0.1', { appId: 'guardian-app' });
  ok(await s.rq('GET', s.root, { token: directorAppToken }));
  assert.equal(ok(await s.rq('GET', s.root, { token: teacherAppToken })).guardians[0].phone, '010-1234-5678');
  assert.equal((await s.rq('PATCH', s.root + '/' + s.g.id, { token: teacherAppToken, body: { rev: 2, name: '금지' } })).status, 403);
  ok(await s.rq('PATCH', s.root + '/' + s.g.id, { token: directorAppToken, body: { rev: 2, name: '앱에서 수정' } }));
  for (const url of ['/api/students', '/api/academy/members', '/api/academy/ai', '/api/me/guardians']) {
    const r = await s.rq('GET', url, { token: appToken });
    assert.equal(r.status, 403);
  }
  ok(await s.rq('POST', '/api/auth/logout', { token: appToken }));
  assert.equal((await s.rq('GET', '/api/me', { token: appToken })).status, 401);
  ok(await s.rq('DELETE', `/api/students/${s.student.id}`, { token: s.dir }));
  ok(await s.rq('POST', '/api/students/purge', { token: s.dir, body: { ids: [s.student.id] } }));
  for (const table of ['guardians', 'guardian_invites', 'guardian_consents'])
    assert.equal(s.db.get(`SELECT COUNT(*) AS n FROM ${table}`).n, 0);
  assert.deepEqual(ok(await s.rq('GET', '/api/me', { token })).user.children, []);
});
