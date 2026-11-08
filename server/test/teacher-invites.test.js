'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ADMIN_PASSWORD } = require('./helpers');
const { sha256Hex } = require('../src/util');
const PASSWORD = 'teacher-pass-1234';
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };

async function setup(t) {
  const s = await startServer();
  t.after(() => s.close());
  const rq = s.request;
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const make = async (username) => ok(await rq('POST', '/api/users', { token: admin,
    body: { username, name: username, role: 'director', academyName: username, password: PASSWORD, mustChangePassword: false } })).user;
  const director = await make('director-a');
  const other = await make('director-b');
  const dir = await s.login('director-a', PASSWORD);
  const otherToken = await s.login('director-b', PASSWORD);
  const invite = async (token = dir, extra = {}) => ok(await rq('POST', '/api/teacher-invites', { token, body: { name: '초대 선생님', allowedApps: ['mago-navi'], ...extra } }));
  return { ...s, rq, admin, director, other, dir, otherToken, invite, db: s.app.deps.db };
}

test('선생님 초대: 가입·세션·해시 보관·1회 사용·기록', async (t) => {
  const s = await setup(t);
  const i = await s.invite();
  const row = s.db.get('SELECT * FROM teacher_invites WHERE id = ?', i.invite.id);
  assert.equal(row.code_hash, sha256Hex(i.code));
  assert.equal(row.expires_at - row.created_at, 7 * 86400000);
  assert.deepEqual(ok(await s.rq('GET', `/api/auth/codes/${i.code}`)), { valid: true, role: 'teacher', academyName: 'director-a', teacherName: '초대 선생님' });
  const joined = ok(await s.rq('POST', '/api/auth/signup', { body: { code: i.code, username: 'new-teacher', password: PASSWORD, name: '무시', allowedApps: null } }));
  assert.deepEqual(Object.keys(joined).sort(), ['server', 'token', 'user']);
  assert.equal(joined.user.role, 'teacher');
  assert.equal(joined.user.name, '초대 선생님');
  assert.equal(joined.user.academy.id, s.director.academy.id);
  assert.deepEqual(joined.user.allowedApps, ['mago-navi']);
  assert.equal(joined.user.mustChangePassword, false);
  ok(await s.rq('GET', '/api/me', { token: joined.token }));
  assert.equal(s.db.get('SELECT must_change_password FROM users WHERE username = ?', 'new-teacher').must_change_password, 0);
  assert.equal(s.db.get('SELECT * FROM teacher_invites WHERE id = ?', i.invite.id), undefined);
  assert.equal((await s.rq('POST', '/api/auth/signup', { body: { code: i.code, username: 'reuse', password: PASSWORD } })).status, 400);
  assert.equal((await s.rq('POST', '/api/teacher-invites', { token: joined.token, body: { name: '금지' } })).status, 403);
  const actions = s.db.all('SELECT * FROM audit');
  for (const action of ['teacher.invite.create', 'teacher.join']) {
    const a = actions.find((a) => a.action === action);
    assert.ok(a.actor_id); assert.equal(a.academy_id, s.director.academy.id); assert.equal(a.target, '초대 선생님');
  }
  assert.ok(!JSON.stringify(actions).includes(i.code));
});

test('선생님 초대: 범위·재발급·만료·취소·권한·목록', async (t) => {
  const s = await setup(t);
  const i = await s.invite();
  const path = `/api/teacher-invites/${i.invite.id}`;
  for (const [method, suffix] of [['POST', '/renew'], ['DELETE', '']]) assert.equal((await s.rq(method, path + suffix, { token: s.otherToken })).status, 404);
  assert.deepEqual(ok(await s.rq('GET', '/api/teacher-invites', { token: s.otherToken })).invites, []);
  const list = ok(await s.rq('GET', '/api/teacher-invites', { token: s.dir })).invites;
  assert.equal(list.length, 1); assert.equal(list[0].createdBy, 'director-a');
  assert.ok(!JSON.stringify(list).includes(i.code)); assert.ok(!JSON.stringify(list).includes('code_hash')); assert.ok(!('code' in list[0]));
  const renewed = ok(await s.rq('POST', path + '/renew', { token: s.dir }));
  assert.notEqual(renewed.code, i.code);
  const rejected = async (code) => {
    assert.equal((await s.rq('GET', `/api/auth/codes/${code}`)).status, 404);
    assert.equal((await s.rq('POST', '/api/auth/signup', { body: { code, username: 'invalid', password: PASSWORD } })).status, 400);
  };
  await rejected(i.code);
  s.db.run('UPDATE teacher_invites SET expires_at = ? WHERE id = ?', Date.now() - 1, i.invite.id);
  await rejected(renewed.code);
  assert.equal(ok(await s.rq('GET', '/api/teacher-invites', { token: s.dir })).invites[0].expired, true);
  const again = ok(await s.rq('POST', path + '/renew', { token: s.dir }));
  ok(await s.rq('DELETE', path, { token: s.dir })); await rejected(again.code);
  await s.invite(s.admin, { academyId: s.other.academy.id });
  ok(await s.rq('POST', `/api/teacher-invites?academy=${s.director.academy.id}`, { token: s.admin, body: { name: '운영자 초대' } }));
  s.db.run('UPDATE users SET allowed_apps = ? WHERE username = ?', '[]', 'director-a');
  assert.equal((await s.rq('POST', '/api/teacher-invites', { token: s.dir, body: { name: '금지', allowedApps: ['mago-navi'] } })).status, 403);
  const session = s.db.get('SELECT * FROM sessions WHERE token_hash = ?', sha256Hex(s.dir));
  s.db.run('UPDATE sessions SET app_id = ? WHERE id = ?', 'mago-navi', session.id);
  assert.equal((await s.rq('POST', '/api/teacher-invites', { token: s.dir, body: { name: '금지' } })).status, 403);
  for (const action of ['teacher.invite.renew', 'teacher.invite.revoke']) assert.ok(s.db.get('SELECT * FROM audit WHERE action = ? AND academy_id = ? AND target = ?', action, s.director.academy.id, '초대 선생님'));
});

test('선생님 초대: 원장·학원 완전 삭제', async (t) => {
  const s = await setup(t);
  const i = await s.invite();
  ok(await s.rq('DELETE', `/api/users/${s.director.id}`, { token: s.admin }));
  assert.equal(s.db.get('SELECT * FROM teacher_invites WHERE id = ?', i.invite.id), undefined);
  const a = await s.invite(s.admin, { academyId: s.other.academy.id });
  ok(await s.rq('DELETE', `/api/academies/${s.other.academy.id}`, { token: s.admin }));
  assert.equal(s.db.get('SELECT * FROM teacher_invites WHERE id = ?', a.invite.id), undefined);
  assert.ok(s.db.all('PRAGMA foreign_key_list(teacher_invites)').some((r) => r.table === 'academies' && r.on_delete === 'CASCADE'));
});

test('선생님 초대: 원장 가입 유지·학생과 같은 실패 한도', async (t) => {
  const s = await setup(t);
  const c = ok(await s.rq('POST', '/api/codes', { token: s.admin, body: { academyName: '새 학원' } })).code;
  const joined = ok(await s.rq('POST', '/api/auth/signup', { body: { code: c.code, username: 'new-director', password: PASSWORD, name: '새 원장' } }));
  assert.equal(joined.user.role, 'director'); ok(await s.rq('GET', '/api/me', { token: joined.token }));
  for (let n = 0; n < 20; n++) {
    const r = n % 3 === 0 ? await s.rq('GET', '/api/auth/codes/bad') : n % 3 === 1 ? await s.rq('GET', '/api/join/bad') : await s.rq('POST', '/api/auth/signup', { body: { code: 'bad' } });
    assert.equal(r.data.error.code, 'invalid_code');
  }
  const i = await s.invite();
  for (const url of [`/api/auth/codes/${i.code}`, '/api/join/bad']) assert.equal((await s.rq('GET', url)).status, 429);
});
