'use strict';

// 웹 프로그램(마고 과목내비) 로그인: 일회용 코드 → 그 프로그램 전용 세션 (routes/sso.js), 'web' 프로그램

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ADMIN_PASSWORD } = require('./helpers');

const NAVI = 'https://magonavi.milky.kr';

test('웹 프로그램 로그인(SSO): 일회용 코드 → 그 프로그램 전용 세션', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const rq = s.request;
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const mk = async (token, body) => {
    const r = await rq('POST', '/api/users', { token, body: { password: 'pass1234', mustChangePassword: false, ...body } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.user;
  };
  await mk(admin, { role: 'director', name: 'A원장', username: 'dira', academyName: 'A학원' });
  const dirA = await s.login('dira', 'pass1234');
  const u1 = await mk(dirA, { name: '김선생', username: 'teach1' });
  const t1 = await s.login('teach1', 'pass1234');
  let secret;

  const authorize = (token, body = { appId: 'mago-navi', state: 'st-1' }) => rq('POST', '/api/sso/authorize', { token, body });
  const exchange = (code, sec = secret, appId = 'mago-navi') => rq('POST', '/api/sso/token', { body: { appId, secret: sec, code } });
  async function appToken(token = t1) {
    const a = await authorize(token);
    assert.equal(a.status, 200, JSON.stringify(a.data));
    const r = await exchange(a.data.code);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.token;
  }

  await t.test('처음에는 꺼져 있음 → 운영자가 켜고 앱 비밀값 만들기', async () => {
    assert.equal((await authorize(t1)).status, 404, '꺼진 프로그램');
    const on = await rq('PATCH', '/api/admin/apps/mago-navi', { token: admin, body: { enabled: true } });
    assert.equal(on.status, 200);
    assert.deepEqual([on.data.app.platform, on.data.app.url, on.data.app.hasSecret], ['web', NAVI, false]);

    assert.equal((await rq('POST', '/api/admin/apps/mago-navi/secret', { token: dirA })).status, 403);
    assert.equal((await rq('POST', '/api/admin/apps/tajong/secret', { token: admin })).data.error.code, 'wrong_platform');
    const r = await rq('POST', '/api/admin/apps/mago-navi/secret', { token: admin });
    assert.equal(r.status, 200);
    secret = r.data.secret;
    assert.match(secret, /^mgs_/);
    const list = (await rq('GET', '/api/admin/apps', { token: admin })).data.apps;
    const navi = list.find((a) => a.id === 'mago-navi');
    assert.equal(navi.hasSecret, true);
    assert.ok(!JSON.stringify(list).includes(secret), '비밀값은 한 번만 보여 줌');
  });

  await t.test('웹 프로그램 주소: https 만 (개발용 localhost 는 허용), 웹에서 다른 플랫폼으로 바꾸면 주소는 버림', async () => {
    const bad = await rq('PATCH', '/api/admin/apps/mago-navi', { token: admin, body: { url: 'http://evil.example.com' } });
    assert.equal(bad.data.error.code, 'invalid_url');
    const dev = await rq('PATCH', '/api/admin/apps/mago-navi', { token: admin, body: { url: 'http://localhost:5173/' } });
    assert.equal(dev.data.app.url, 'http://localhost:5173');
    assert.equal((await rq('PATCH', '/api/admin/apps/mago-navi', { token: admin, body: { url: `${NAVI}/` } })).data.app.url, NAVI);

    const made = await rq('POST', '/api/admin/apps', { token: admin, body: { id: 'web-x', name: '웹 X', platform: 'web', url: 'https://x.example.com' } });
    assert.equal(made.status, 200, JSON.stringify(made.data));
    assert.deepEqual(made.data.app.source, { type: 'web', url: 'https://x.example.com' });
    assert.equal(made.data.app.release, null, '릴리스 확인은 건너뜀');
    const pc = await rq('PATCH', '/api/admin/apps/web-x', { token: admin, body: { platform: 'windows' } });
    assert.deepEqual([pc.data.app.source, pc.data.app.url], [{ type: 'local' }, null]);
    assert.equal((await rq('PATCH', '/api/admin/apps/web-x', { token: admin, body: { platform: 'web' } })).data.error.code, 'invalid_url', '웹으로 바꿀 때는 주소가 있어야 함');
    await rq('DELETE', '/api/admin/apps/web-x', { token: admin });
  });

  await t.test('목록: 웹 프로그램은 1.2.0 이상 통합 클라우드와 웹 화면에만', async () => {
    const old = (await rq('GET', '/api/apps', { token: t1 })).data.apps.map((a) => a.id);
    assert.ok(!old.includes('mago-navi'), '예전 통합 클라우드는 설치하는 프로그램으로 착각하므로 숨김');
    const login = async (platform, version, id) =>
      (await rq('POST', '/api/auth/login', { body: { username: 'teach1', password: 'pass1234', device: { id, name: 'x', platform, version } } })).data.token;
    const newer = (await rq('GET', '/api/apps', { token: await login('windows', '1.2.0', 'dev-new') })).data.apps.find((a) => a.id === 'mago-navi');
    assert.deepEqual([newer.platform, newer.url, newer.allowed], ['web', NAVI, true]);
    const web = (await rq('GET', '/api/apps', { token: await login('web', '', 'web-1') })).data.apps;
    assert.ok(web.some((a) => a.id === 'mago-navi'));
    const ticket = await rq('POST', '/api/apps/mago-navi/ticket', { token: t1 });
    assert.equal(ticket.data.error.code, 'wrong_platform');
  });

  await t.test('authorize: 일회용 코드와 돌아갈 주소는 서버가 정함', async () => {
    const a = await authorize(t1, { appId: 'mago-navi', state: 'st-1', redirect: 'https://evil.example.com' });
    assert.equal(a.status, 200);
    assert.match(a.data.code, /^msc_/);
    const u = new URL(a.data.redirect);
    assert.equal(`${u.origin}${u.pathname}`, `${NAVI}/api/auth/mago/callback`);
    assert.deepEqual([u.searchParams.get('code'), u.searchParams.get('state')], [a.data.code, 'st-1']);
    assert.ok(a.data.expiresAt - Date.now() <= 60 * 1000);

    assert.equal((await authorize(null)).status, 401);
    assert.equal((await authorize(t1, { appId: 'tajong' })).data.error.code, 'no_app', '설치하는 프로그램은 아님');
    assert.equal((await authorize(t1, { appId: 'nope' })).status, 404);
  });

  await t.test('token: 앱 비밀값이 맞아야 하고, 코드는 한 번만', async () => {
    const a = await authorize(t1);
    const wrong = await exchange(a.data.code, 'mgs_wrong');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.data.error.code, 'invalid_client');
    assert.equal((await exchange(a.data.code, '')).status, 401);

    const r = await exchange(a.data.code);
    assert.equal(r.status, 200, '비밀값이 틀린 시도로는 코드가 없어지지 않음');
    assert.match(r.data.token, /^mgc_/);
    assert.deepEqual([r.data.user.id, r.data.user.username, r.data.user.role, r.data.user.academy.name], [u1.id, 'teach1', 'teacher', 'A학원']);

    const again = await exchange(a.data.code);
    assert.equal(again.status, 400);
    assert.equal(again.data.error.code, 'invalid_code');
    assert.equal((await exchange('msc_made_up')).data.error.code, 'invalid_code');

    const audit = (await rq('GET', '/api/audit?action=sso', { token: admin })).data.entries.map((e) => e.action);
    assert.ok(audit.includes('sso.authorize') && audit.includes('sso.login'));
  });

  await t.test('코드는 60초 뒤 못 씀', async () => {
    const a = await authorize(t1);
    const now = Date.now();
    t.mock.method(Date, 'now', () => now + 61 * 1000);
    try {
      assert.equal((await exchange(a.data.code)).data.error.code, 'invalid_code');
    } finally {
      Date.now.mock.restore();
    }
  });

  await t.test('전용 세션: 내 정보·학생 명단·학원 AI 만', async () => {
    const tok = await appToken();
    const ok = async (method, url, body) => {
      const r = await rq(method, url, { token: tok, body });
      assert.equal(r.status, 200, `${method} ${url} ${JSON.stringify(r.data)}`);
      return r.data;
    };
    assert.equal((await ok('GET', '/api/me')).user.username, 'teach1');
    const st = (await ok('POST', '/api/students', { name: '홍길동' })).student;
    await ok('PATCH', `/api/students/${st.id}`, { grade: '고1' });
    assert.equal((await ok('GET', '/api/students')).students.length, 1);
    await ok('GET', '/api/academy/members');
    await rq('PUT', '/api/academy/ai', { token: dirA, body: { app: 'mago-navi', config: { provider: 'gemini', apiKey: 'navi-key-1234' } } });
    await rq('PUT', '/api/academy/ai', { token: dirA, body: { app: 'ohdapnote', config: { provider: 'gemini', apiKey: 'ohdap-key-5678' } } });
    const ai = await ok('GET', '/api/academy/ai?app=ohdapnote');
    assert.deepEqual([ai.app, ai.ai.source, ai.ai.relay, ai.ai.apiKey], ['mago-navi', 'app', true, undefined], '자기 프로그램 것만 (키 없이)');

    for (const [method, url] of [
      ['GET', '/api/apps'],
      ['GET', '/api/sync/ohdapnote/academy'],
      ['GET', '/api/sync/ohdapnote?since=0'],
      ['GET', '/api/sync/events'],
      ['POST', '/api/sso/authorize'],
      ['POST', '/api/apps/ohdapnote/ticket'],
      ['GET', '/api/academy/ai/all'],
      ['PUT', '/api/academy/ai'],
      ['GET', '/api/users'],
      ['PATCH', '/api/me/password'],
      ['PATCH', '/api/me/name'],
      ['POST', '/api/me/devices/logout-others'],
    ]) {
      const r = await rq(method, url, { token: tok, body: method === 'GET' ? undefined : { appId: 'mago-navi' } });
      assert.equal(r.status, 403, `${method} ${url} → ${r.status}`);
    }
    const dirTok = await appToken(dirA);
    const put = await rq('PUT', '/api/academy/ai', { token: dirTok, body: { app: '', config: null } });
    assert.equal(put.status, 403, '원장도 전용 세션으로는 학원 AI 를 못 고침');
  });

  await t.test('로그인마다 따로, 로그아웃·사용 중지되면 끊김', async () => {
    const a = await appToken();
    const b = await appToken();
    assert.notEqual(a, b);
    assert.equal((await rq('POST', '/api/auth/logout', { token: a })).status, 200);
    assert.equal((await rq('GET', '/api/me', { token: a })).status, 401);
    assert.equal((await rq('GET', '/api/me', { token: b })).status, 200, '다른 로그인은 그대로');

    const devices = (await rq('GET', '/api/me/devices', { token: t1 })).data.devices || [];
    assert.ok(devices.some((d) => d.platform === 'web-app' && d.deviceName === '마고 과목내비'), '내 기기 목록에 보여서 끊을 수 있음');

    assert.equal((await rq('POST', `/api/users/${u1.id}/suspend`, { token: dirA, body: {} })).status, 200);
    assert.equal((await rq('GET', '/api/me', { token: b })).status, 401);
    await rq('POST', `/api/users/${u1.id}/activate`, { token: dirA });
  });

  await t.test('프로그램 권한이 없으면 로그인할 수 없음 (코드를 받은 뒤 빼앗겨도)', async () => {
    const t1b = await s.login('teach1', 'pass1234');
    const a = await authorize(t1b);
    assert.equal(a.status, 200);
    assert.equal((await rq('PATCH', `/api/users/${u1.id}`, { token: dirA, body: { allowedApps: ['ohdapnote'] } })).status, 200);
    assert.equal((await exchange(a.data.code)).status, 403);
    assert.equal((await authorize(t1b)).status, 403);
  });
});
