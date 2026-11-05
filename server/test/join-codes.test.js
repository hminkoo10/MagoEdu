'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ADMIN_PASSWORD } = require('./helpers');
const { sha256Hex } = require('../src/util');

async function setup(t, config = {}) {
  const s = await startServer(config);
  t.after(() => s.close());
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const rq = async (method, url, body, token) => s.request(method, url, { body, token });
  const made = await rq('POST', '/api/users', { role: 'director', name: '시험 원장', username: 'code-director', password: 'test-pass-1234', academyName: '시험 학원' }, admin);
  assert.equal(made.status, 200);
  const director = await s.login('code-director', 'test-pass-1234');
  const student = (await rq('POST', '/api/students', { name: '시험 학생' }, director)).data.student;
  const owner = (await rq('POST', '/api/codes', { academyName: '새 학원' }, admin)).data.code;
  const invite = (await rq('POST', `/api/students/${student.id}/invite`, {}, director)).data;
  const check = (code) => rq('GET', `/api/auth/codes/${encodeURIComponent(code)}`);
  return { ...s, rq, check, owner, invite, student };
}

test('통합 가입 코드: 원장·학생 판별, 기존 주소와 가입 유지', async (t) => {
  const s = await setup(t);
  assert.deepEqual((await s.check(s.owner.code.toLowerCase())).data, { valid: true, role: 'director', academyName: '새 학원' });
  assert.deepEqual((await s.check(s.invite.code)).data, { valid: true, role: 'student', academyName: '시험 학원', studentName: '시험 학생' });
  assert.deepEqual((await s.rq('GET', `/api/join/${s.invite.code}`)).data, { academyName: '시험 학원', studentName: '시험 학생' });
  const owner = await s.rq('POST', '/api/auth/signup', { code: s.owner.code, name: '새 원장', username: 'new-owner', password: 'test-pass-1234' });
  assert.equal(owner.status, 200);
  assert.equal(owner.data.user.role, 'director');
  const student = await s.rq('POST', '/api/join', { code: s.invite.code, username: 'new-student', password: 'test-pass-1234' });
  assert.equal(student.status, 200);
  assert.equal(student.data.user.role, 'student');
});

test('통합 가입 코드: 형식으로 추측하지 않고 겹치면 유효한 원장 우선', async (t) => {
  const s = await setup(t);
  const db = s.app.deps.db;
  // 현재 생성 형식은 다르지만 기존/수동 발급 데이터의 충돌도 처리한다.
  db.run('UPDATE student_invites SET code_hash = ? WHERE student_id = ?', sha256Hex(s.owner.code), s.student.id);
  assert.equal((await s.check(s.owner.code)).data.role, 'director');
  db.run('UPDATE signup_codes SET revoked = 1 WHERE id = ?', s.owner.id);
  assert.equal((await s.check(s.owner.code)).data.role, 'student', '원장 형태여도 유효한 학생 코드면 학생 가입');
  db.run('UPDATE signup_codes SET revoked = 0, code = ? WHERE id = ?', s.invite.code.toUpperCase(), s.owner.id);
  assert.equal((await s.check(s.invite.code)).data.role, 'director', '학생 형태여도 원장 코드 조회');
});

test('통합 가입 코드: 없는·만료·취소·소진·사용·삭제·계정 보유 코드는 같은 오류', async (t) => {
  const s = await setup(t);
  const db = s.app.deps.db;
  const invalid = async (code) => {
    const r = await s.check(code);
    assert.equal(r.status, 404);
    assert.deepEqual(r.data, { error: { code: 'invalid_code', message: '코드를 다시 확인해 주세요' } });
  };
  await invalid('MAGO-NONE-NONE');
  await invalid('student-code-missing');
  for (const [column, value] of [['expires_at', Date.now() - 1], ['revoked', 1], ['uses', 1]]) {
    db.run(`UPDATE signup_codes SET expires_at = NULL, revoked = 0, uses = 0, ${column} = ? WHERE id = ?`, value, s.owner.id);
    await invalid(s.owner.code);
  }
  for (const [column, value] of [['expires_at', 1], ['used_at', Date.now()]]) {
    db.run(`UPDATE student_invites SET expires_at = ?, used_at = NULL, ${column} = ? WHERE student_id = ?`, Date.now() + 60000, value, s.student.id);
    await invalid(s.invite.code);
  }
  db.run('UPDATE student_invites SET expires_at = ?, used_at = NULL WHERE student_id = ?', Date.now() + 60000, s.student.id);
  db.run('UPDATE students SET deleted_at = ? WHERE id = ?', Date.now(), s.student.id);
  await invalid(s.invite.code);
  db.run('UPDATE students SET deleted_at = NULL, purged_at = ? WHERE id = ?', Date.now(), s.student.id);
  await invalid(s.invite.code);
  db.run('UPDATE students SET purged_at = NULL WHERE id = ?', s.student.id);
  db.run("UPDATE users SET role = 'student', student_id = ?, ai_mode = 'academy' WHERE username = 'code-director'", s.student.id);
  await invalid(s.invite.code);
});

test('가입 코드 제한: 통합·기존 조회·가입이 IP별 20회/10분 공유, 성공해도 초기화 안 됨', async (t) => {
  const s = await setup(t);
  const attempts = [
    () => s.check('wrong'),
    () => s.rq('GET', '/api/join/wrong'),
    () => s.rq('POST', '/api/auth/signup', { code: 'wrong' }),
    () => s.rq('POST', '/api/join', { code: 'wrong' }),
  ];
  for (let i = 0; i < 20; i++) {
    if (i === 10) assert.equal((await s.check(s.invite.code)).status, 200);
    const r = await attempts[i % attempts.length]();
    assert.equal(r.data.error.code, 'invalid_code', `실패 ${i + 1}`);
  }
  for (const attempt of [...attempts, () => s.check(s.owner.code), () => s.check(s.invite.code)]) {
    const r = await attempt();
    assert.equal(r.status, 429);
    assert.equal(r.data.error.code, 'rate_limited');
    assert.ok(r.data.error.retryAfter > 0 && r.data.error.retryAfter <= 600);
  }
});

test('통합 가입 코드: 단독으로도 20회 제한, 다른 IP는 독립·10분 뒤 재시도', async (t) => {
  const s = await setup(t, { trustProxy: true });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const request = (code, ip = '192.0.2.13') => s.request('GET', `/api/auth/codes/${code}`, { headers: { 'x-forwarded-for': ip } });
  for (let i = 0; i < 20; i++) assert.equal((await request('wrong')).status, 404);
  assert.equal((await request(s.owner.code)).status, 429);
  assert.equal((await request(s.owner.code, '192.0.2.14')).status, 200);
  t.mock.timers.tick(10 * 60 * 1000 + 1);
  assert.equal((await request(s.owner.code)).status, 200);
});
