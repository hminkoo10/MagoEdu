'use strict';

// 학원 AI 중계 (routes/ai-relay.js): 키는 서버에만 두고, 프로그램이 보낸 요청에 서버가 키를 붙여 대신 보낸다

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, ADMIN_PASSWORD } = require('./helpers');
const { privateHost } = require('../src/routes/ai-relay');

/** 가짜 AI 서버: 받은 요청을 기록하고 reply(req) 로 답한다 */
async function fakeAi() {
  const seen = [];
  let reply = () => ({ status: 200, body: { ok: true } });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const r = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(r);
      const out = reply(r);
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers || {}) });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    last: () => seen[seen.length - 1],
    reply: (fn) => (reply = fn),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 원장·선생님 둘(A학원), 학원 없는 선생님 */
async function setup(s) {
  const rq = s.request;
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const mk = async (token, body) => {
    const r = await rq('POST', '/api/users', { token, body: { password: 'pass1234', mustChangePassword: false, ...body } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.user;
  };
  const da = await mk(admin, { role: 'director', name: 'A원장', username: 'dira', academyName: 'A학원' });
  const dirA = await s.login('dira', 'pass1234');
  const u1 = await mk(dirA, { name: '김선생', username: 'teach1' });
  const u2 = await mk(dirA, { name: '이선생', username: 'teach2' });
  const t1 = await s.login('teach1', 'pass1234', 'pc-1');
  const t2 = await s.login('teach2', 'pass1234', 'pc-2');
  const ticket = async (token, app = 'ohdapnote') => {
    const r = await rq('POST', `/api/apps/${app}/ticket`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.ticket;
  };
  const setAi = async (app, config) => {
    const r = await rq('PUT', '/api/academy/ai', { token: dirA, body: { app, config } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  };
  return { admin, dirA, t1, t2, u1, u2, acaA: da.academy.id, ticket, setAi };
}

const relay = (s, app, rest, { headers = {}, body } = {}) =>
  s.request(body === undefined ? 'GET' : 'POST', `/api/ai/relay/${app}/${rest}`, { headers: { 'content-type': 'application/json', ...headers }, raw: body === undefined ? undefined : JSON.stringify(body) });

test('학원 AI 중계: 실행 허가증·웹 프로그램 세션으로, 서버가 키를 붙여 대신 보냄', async (t) => {
  const ai = await fakeAi();
  const s = await startServer({ aiRelayAllowPrivate: true }); // 가짜 AI 가 127.0.0.1 이라
  t.after(async () => {
    await s.close();
    await ai.close();
  });
  const { t1, t2, u1, acaA, ticket, setAi, dirA } = await setup(s);
  const tk = await ticket(t1);

  await t.test('학원 AI 가 없으면 404', async () => {
    const r = await relay(s, 'ohdapnote', 'v1beta/models', { headers: { 'x-goog-api-key': tk } });
    assert.equal(r.data.error.code, 'no_academy_ai');
  });

  await t.test('Gemini: x-goog-api-key 자리의 허가증 → 서버가 진짜 키로 바꿔 보냄 (주소의 key 는 버림)', async () => {
    await setAi('', { provider: 'gemini', apiKey: 'real-gem-key', model: 'gemini-x', baseUrl: ai.url });
    ai.reply((req) => ({ status: 200, body: { candidates: [{ got: req.body ? JSON.parse(req.body).q : null }] } }));
    const r = await relay(s, 'ohdapnote', 'v1beta/models/gemini-x:generateContent?key=leak&alt=json', { headers: { 'x-goog-api-key': tk }, body: { q: '안녕' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data, { candidates: [{ got: '안녕' }] });
    const up = ai.last();
    assert.equal(up.method, 'POST');
    assert.equal(up.url, '/v1beta/models/gemini-x:generateContent?alt=json');
    assert.equal(up.headers['x-goog-api-key'], 'real-gem-key');
    assert.equal(up.headers.authorization, undefined);
    assert.ok(!JSON.stringify(up.headers).includes(tk), '허가증은 AI 로 보내지 않음');

    const list = await relay(s, 'ohdapnote', 'v1beta/models?pageSize=200', { headers: { authorization: `Bearer ${tk}` } });
    assert.equal(list.status, 200);
    assert.equal(ai.last().method, 'GET');
    assert.equal(ai.last().url, '/v1beta/models?pageSize=200');
  });

  await t.test('Gemini 의 OpenAI 호환 주소는 Bearer 로', async () => {
    await relay(s, 'ohdapnote', 'v1beta/openai/chat/completions', { headers: { authorization: `Bearer ${tk}` }, body: { model: 'gemini-x' } });
    assert.equal(ai.last().headers.authorization, 'Bearer real-gem-key');
    assert.equal(ai.last().headers['x-goog-api-key'], undefined);
  });

  await t.test('프로그램마다 따로 정한 AI: OpenAI 호환 · Claude', async () => {
    await setAi('ohdapnote', { provider: 'openai', apiKey: 'sk-real', baseUrl: `${ai.url}/v1` });
    await relay(s, 'ohdapnote', 'chat/completions', { headers: { authorization: `Bearer ${tk}` }, body: { model: 'm' } });
    assert.equal(ai.last().url, '/v1/chat/completions');
    assert.equal(ai.last().headers.authorization, 'Bearer sk-real');

    await setAi('ohdapnote', { provider: 'anthropic', apiKey: 'sk-ant-real', baseUrl: ai.url });
    await relay(s, 'ohdapnote', 'v1/messages', { headers: { 'x-api-key': tk, 'anthropic-version': '2023-06-01' }, body: { model: 'claude-x' } });
    assert.equal(ai.last().url, '/v1/messages');
    assert.equal(ai.last().headers['x-api-key'], 'sk-ant-real');
    assert.equal(ai.last().headers['anthropic-version'], '2023-06-01');
    await setAi('ohdapnote', null);
  });

  await t.test('AI 의 오류 상태·retry-after 는 그대로', async () => {
    ai.reply(() => ({ status: 429, headers: { 'retry-after': '7' }, body: { error: { status: 'RESOURCE_EXHAUSTED' } } }));
    const r = await relay(s, 'ohdapnote', 'v1beta/models/gemini-x:generateContent', { headers: { 'x-goog-api-key': tk }, body: {} });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '7');
    assert.equal(r.data.error.status, 'RESOURCE_EXHAUSTED');
    ai.reply(() => ({ status: 200, body: { ok: true } }));
  });

  await t.test('키로 할 수 있는 일 중 생성·모델 목록만', async () => {
    const n = ai.seen.length;
    for (const rest of ['v1beta/files', 'v1beta/tunedModels', 'v1beta/models/x:embedContent', 'v1beta/models/gemini%2Fx:generateContent', 'v1beta/models/..', 'admin']) {
      const r = await relay(s, 'ohdapnote', rest, { headers: { 'x-goog-api-key': tk }, body: {} });
      assert.equal(r.status, 403, rest);
      assert.equal(r.data.error.code, 'relay_path', rest);
    }
    assert.equal(ai.seen.length, n, 'AI 로 가지 않음');
  });

  await t.test('허가증: 다른 프로그램 것·망가진 것·없으면 401', async () => {
    const other = await relay(s, 'tajong', 'v1beta/models', { headers: { 'x-goog-api-key': tk } });
    assert.deepEqual([other.status, other.data.error.code], [401, 'ticket_invalid']);
    const broken = await relay(s, 'ohdapnote', 'v1beta/models', { headers: { 'x-goog-api-key': `${tk.slice(0, -4)}AAAA` } });
    assert.equal(broken.status, 401);
    assert.equal((await relay(s, 'ohdapnote', 'v1beta/models')).data.error.code, 'auth_required');
    assert.equal((await relay(s, 'ohdapnote', 'v1beta/models', { headers: { authorization: 'Bearer nope' } })).status, 401);
  });

  await t.test('통합 클라우드 로그인이 끝나면(로그아웃·정지) 허가증으로도 못 씀', async () => {
    const tk2 = await ticket(t2);
    assert.equal((await relay(s, 'ohdapnote', 'v1beta/models', { headers: { 'x-goog-api-key': tk2 } })).status, 200);
    assert.equal((await s.request('POST', '/api/auth/logout', { token: t2 })).status, 200);
    const r = await relay(s, 'ohdapnote', 'v1beta/models', { headers: { 'x-goog-api-key': tk2 } });
    assert.deepEqual([r.status, r.data.error.code], [401, 'session_invalid']);

    const tk1 = await ticket(t1);
    assert.equal((await s.request('POST', `/api/users/${u1.id}/suspend`, { token: dirA, body: { reason: '시험' } })).status, 200);
    assert.equal((await relay(s, 'ohdapnote', 'v1beta/models', { headers: { 'x-goog-api-key': tk1 } })).data.error.code, 'account_suspended');
  });

  await t.test('웹 프로그램 전용 세션은 자기 프로그램으로만', async () => {
    s.app.deps.db.run("UPDATE apps SET enabled = 1 WHERE id = 'mago-navi'");
    const user = s.app.deps.db.get("SELECT * FROM users WHERE username = 'dira'");
    const web = s.app.deps.svc.createSession(user, { id: 'web-1' }, '127.0.0.1', { appId: 'mago-navi' });
    const r = await relay(s, 'mago-navi', 'v1beta/models/gemini-x:generateContent', { headers: { authorization: `Bearer ${web}` }, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(ai.last().headers['x-goog-api-key'], 'real-gem-key');
    const wrong = await relay(s, 'ohdapnote', 'v1beta/models', { headers: { authorization: `Bearer ${web}` } });
    assert.deepEqual([wrong.status, wrong.data.error.code], [403, 'app_session']);
  });

  await t.test('GET /api/academy/ai 에는 키가 없음', async () => {
    const g = await s.request('GET', '/api/academy/ai?app=ohdapnote', { token: dirA });
    assert.equal(g.data.ai.relay, true, '시험용 설정이면 학원 안 주소도 중계');
    assert.ok(!JSON.stringify(g.data).includes('real-gem-key'));
    assert.equal(s.app.deps.students.aiFor(acaA, 'ohdapnote').apiKey, 'real-gem-key');
  });
});

test('학원 AI 중계: 서버 안쪽·학원 안 주소로는 보내지 않고, 너무 많이 부르면 막음', async (t) => {
  const ai = await fakeAi();
  const s = await startServer({ aiRelayPerTenMinutes: 3 });
  t.after(async () => {
    await s.close();
    await ai.close();
  });
  const { t1, ticket, setAi } = await setup(s);
  const tk = await ticket(t1);
  const port = new URL(ai.url).port;

  await t.test('사설 IP·localhost 는 403 private_target, GET 은 direct (각 PC 에서 바로)', async () => {
    for (const base of [ai.url, `http://localhost:${port}`, 'http://169.254.169.254', 'http://[::1]:80']) {
      await setAi('', { provider: 'openai', baseUrl: `${base}/v1` });
      const r = await relay(s, 'ohdapnote', 'chat/completions', { headers: { authorization: `Bearer ${tk}` }, body: {} });
      assert.deepEqual([r.status, r.data.error?.code], [403, 'private_target'], base);
    }
    assert.equal(ai.seen.length, 0, 'AI 로 가지 않음');
    const g = (await s.request('GET', '/api/academy/ai?app=ohdapnote', { token: t1 })).data.ai;
    assert.deepEqual([g.direct, g.baseUrl, g.relay, g.hasKey], [true, 'http://[::1]:80/v1', undefined, false]);
  });

  await t.test('이름으로만 보는 학원 안 주소', () => {
    for (const h of ['localhost', 'nas.local', 'ai.lan', 'gpu', '192.168.0.10', '10.1.2.3', '[fd00::1]', '127.0.0.1']) assert.equal(privateHost(h), true, h);
    for (const h of ['api.openai.com', 'generativelanguage.googleapis.com', '8.8.8.8', 'ai.example.com']) assert.equal(privateHost(h), false, h);
  });
});

test('학원 AI 중계: 사람·프로그램마다 10분에 정한 횟수까지', async (t) => {
  const ai = await fakeAi();
  const s = await startServer({ aiRelayAllowPrivate: true, aiRelayPerTenMinutes: 3 });
  t.after(async () => {
    await s.close();
    await ai.close();
  });
  const { t1, t2, ticket, setAi } = await setup(s);
  await setAi('', { provider: 'gemini', apiKey: 'k', baseUrl: ai.url });
  const tk = await ticket(t1);
  const call = async (token) => (await relay(s, 'ohdapnote', 'v1beta/models', { headers: { 'x-goog-api-key': token } })).status;
  assert.deepEqual([await call(tk), await call(tk), await call(tk)], [200, 200, 200]);
  const r = await relay(s, 'ohdapnote', 'v1beta/models', { headers: { 'x-goog-api-key': tk } });
  assert.deepEqual([r.status, r.data.error.code], [429, 'rate_limited']);
  assert.ok(r.data.error.retryAfter > 0);
  assert.equal(await call(await ticket(t2)), 200, '다른 사람은 따로 셈');
  assert.equal(ai.seen.length, 4);
});
