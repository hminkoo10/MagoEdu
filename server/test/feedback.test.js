'use strict';

// 아이디 바꾸기(같은 아이디), 공지 한도, 학원 공간 용량, 설정 서명 키

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, ADMIN_PASSWORD } = require('./helpers');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function setup(t) {
  const s = await startServer();
  t.after(() => s.close());
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const mk = async (token, body) => {
    const r = await s.request('POST', '/api/users', { token, body: { password: 'pass1234', mustChangePassword: false, ...body } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.user;
  };
  return { s, rq: s.request, admin, mk };
}

test('아이디 바꾸기: 지금 아이디를 넣으면 바꿨다고 하지 않고 알려 줌', async (t) => {
  const { s, rq, admin, mk } = await setup(t);
  const d = await mk(admin, { role: 'director', name: 'A원장', username: 'dira', academyName: 'A학원' });
  const dir = await s.login('dira', 'pass1234');
  const same = await rq('PATCH', '/api/me/username', { token: dir, body: { username: 'DIRA', password: 'pass1234' } });
  assert.equal(same.status, 400);
  assert.equal(same.data.error.code, 'same_username');
  const audit = await rq('GET', '/api/audit', { token: admin });
  assert.equal(audit.data.entries.some((e) => e.action === 'me.username'), false, '바꾼 기록도 남기지 않음');
  // 관리 화면은 이름과 아이디를 함께 보내므로, 아이디가 그대로면 이름만 바꿈
  const r = await rq('PATCH', `/api/users/${d.id}`, { token: admin, body: { name: '김원장', username: 'dira' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.name, '김원장');
});

test('공지: 한도를 넘으면 몰래 자르지 않고 알려 줌 (제목 100자, 내용 2000자·50줄)', async (t) => {
  const { rq, admin } = await setup(t);
  const post = (body) => rq('POST', '/api/notices', { token: admin, body: { title: '제목', body: '내용', ...body } });
  assert.equal((await post({ title: 'ㄱ'.repeat(101) })).data.error.code, 'too_long');
  assert.equal((await post({ body: 'ㄱ'.repeat(2001) })).data.error.code, 'too_long');
  assert.equal((await post({ body: Array(51).fill('줄').join('\r\n') })).data.error.code, 'too_long');
  const ok = await post({ title: 'ㄱ'.repeat(100), body: Array(50).fill('줄').join('\n') });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

test('학원 공간 용량: 운영자가 정하고, 넘으면 올리지 못함. 사용량은 학원 사람 모두에게 보임', async (t) => {
  const { s, rq, admin, mk } = await setup(t);
  const d = await mk(admin, { role: 'director', name: 'A원장', username: 'dira', academyName: 'A학원' });
  const dir = await s.login('dira', 'pass1234');
  await mk(dir, { name: '김선생', username: 'teach1' });
  const t1 = await s.login('teach1', 'pass1234');
  const aca = d.academy.id;

  const put = (token, p, body, baseRev = 0) =>
    rq('PUT', `/api/sync/ohdapnote/academy/file?path=${encodeURIComponent(p)}&baseRev=${baseRev}`, {
      token,
      raw: body,
      headers: { 'x-sha256': sha(body), 'content-type': 'application/octet-stream' },
    });

  // 기본 학원 용량 (서버 설정), 운영자만 학원마다 바꿈
  const set = await rq('GET', '/api/admin/settings', { token: admin });
  assert.equal(set.data.settings.defaultAcademyQuotaMb, 10240);
  assert.equal((await rq('PATCH', `/api/academies/${aca}`, { token: dir, body: { quotaMb: 1 } })).status, 403);
  const q = await rq('PATCH', `/api/academies/${aca}`, { token: admin, body: { quotaMb: 1 } });
  assert.equal(q.status, 200, JSON.stringify(q.data));
  assert.equal(q.data.academy.quotaMb, 1);
  assert.equal(q.data.academy.name, 'A학원', '이름은 그대로');

  const big = Buffer.alloc(700 * 1024, 1);
  assert.equal((await put(t1, 'books/b1/problem-1.pdf', big)).status, 200);
  const full = await put(dir, 'books/b2/problem-1.pdf', Buffer.alloc(400 * 1024, 2));
  assert.equal(full.status, 507);
  assert.equal(full.data.error.code, 'academy_quota_exceeded');
  // 같은 파일을 더 작게 바꾸는 것은 됨 (지금 크기는 빼고 셈)
  assert.equal((await put(t1, 'books/b1/problem-1.pdf', Buffer.alloc(600 * 1024, 3), 1)).status, 200);
  // 개인 공간 용량에는 들어가지 않음
  const mine = await rq('GET', '/api/sync', { token: t1 });
  assert.equal(mine.data.usageBytes, 0);
  assert.equal(mine.data.academy.usageBytes, 600 * 1024);
  assert.equal(mine.data.academy.quotaBytes, 1024 * 1024);
  assert.deepEqual(
    mine.data.academy.apps.map((a) => [a.appId, a.files, a.bytes]),
    [['ohdapnote', 1, 600 * 1024]],
  );
  const me = await rq('GET', '/api/me', { token: t1 });
  assert.equal(me.data.user.academyUsageBytes, 600 * 1024);
  const list = await rq('GET', '/api/academies', { token: admin });
  assert.equal(list.data.academies.find((a) => a.id === aca).usageBytes, 600 * 1024);
  const stats = await rq('GET', '/api/admin/stats', { token: admin });
  assert.equal(stats.data.storage.sharedBytes, 600 * 1024);

  // 비우면 기본값, 0 이면 제한 없음
  await rq('PATCH', `/api/academies/${aca}`, { token: admin, body: { quotaMb: 0 } });
  assert.equal((await put(dir, 'books/b2/problem-1.pdf', Buffer.alloc(400 * 1024, 2))).status, 200);
  const reset = await rq('PATCH', `/api/academies/${aca}`, { token: admin, body: { quotaMb: null } });
  assert.equal(reset.data.academy.quotaMb, null);
});

test('설정 서명 키: 서버마다 하나, 프로그램(PC·안드로이드)에만 주고 웹에는 주지 않음', async (t) => {
  const { s, rq, admin, mk } = await setup(t);
  await mk(admin, { role: 'director', name: 'A원장', username: 'dira', academyName: 'A학원' });
  const pc = await s.login('dira', 'pass1234');
  const a = await rq('GET', '/api/me/data-key', { token: pc });
  assert.equal(a.status, 200);
  assert.match(a.data.dataKey, /^[A-Za-z0-9_-]{43}$/);
  const b = await rq('GET', '/api/me/data-key', { token: admin });
  assert.equal(b.data.dataKey, a.data.dataKey, '같은 서버면 계정이 달라도 같음 (다른 계정 백업도 불러옴)');
  const web = await rq('POST', '/api/auth/login', { body: { username: 'dira', password: 'pass1234', device: { id: 'web-1', name: '브라우저', platform: 'web' } } });
  const w = await rq('GET', '/api/me/data-key', { token: web.data.token });
  assert.equal(w.status, 403);
  assert.equal(w.data.error.code, 'web_session');
  assert.equal((await rq('GET', '/api/me/data-key')).status, 401);
  const me = await rq('GET', '/api/me', { token: pc });
  assert.equal(JSON.stringify(me.data).includes(a.data.dataKey), false, '/api/me 에는 없음');
});

test('사용 중지: 로그인해 둔 기기는 다음 요청에서 사용 중지된 계정이라는 답을 받고 로그아웃됨', async (t) => {
  const { s, rq, admin, mk } = await setup(t);
  await mk(admin, { role: 'director', name: 'A원장', username: 'dira', academyName: 'A학원' });
  const dir = await s.login('dira', 'pass1234');
  const u = await mk(dir, { name: '김선생', username: 'teach1' });
  const pc = await s.login('teach1', 'pass1234');
  assert.equal((await rq('POST', `/api/users/${u.id}/suspend`, { token: dir, body: {} })).status, 200);
  const first = await rq('GET', '/api/me', { token: pc });
  assert.equal(first.status, 401);
  assert.equal(first.data.error.code, 'account_suspended');
  assert.equal((await rq('GET', '/api/me', { token: pc })).data.error.code, 'session_invalid', '그 세션은 지워짐');
  // 다시 쓰게 해도 사용 중지 전 로그인은 되살리지 않음
  const later = await s.request('POST', '/api/auth/login', { body: { username: 'teach1', password: 'pass1234', device: { id: 'dev-3' } } });
  assert.equal(later.data.error.code, 'account_suspended');
  assert.equal((await rq('POST', `/api/users/${u.id}/activate`, { token: dir, body: {} })).status, 200);
  assert.equal((await rq('GET', '/api/me', { token: (await s.login('teach1', 'pass1234', 'dev-4')) })).status, 200);
});
