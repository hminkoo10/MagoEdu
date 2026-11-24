'use strict';

// 운영자가 ?academy=<학원 ID> 로 고른 학원의 자료를 원장과 같은 범위로 보고 고치기 + 그때마다 활동 기록

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ADMIN_PASSWORD } = require('./helpers');

const PASSWORD = 'pass-1234-abcd';

function ok(r) {
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

function error(r, status, code) {
  assert.equal(r.status, status, JSON.stringify(r.data));
  if (code) assert.equal(r.data.error.code, code);
}

async function setup(t) {
  const s = await startServer();
  t.after(() => s.close());
  const rq = s.request;
  const db = s.app.deps.db;
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const mk = async (token, body) => ok(await rq('POST', '/api/users', { token, body: { password: PASSWORD, mustChangePassword: false, ...body } })).user;
  const da = await mk(admin, { role: 'director', name: 'A원장', username: 'dira', academyName: 'A학원' });
  const dbB = await mk(admin, { role: 'director', name: 'B원장', username: 'dirb', academyName: 'B학원' });
  const dirA = await s.login('dira', PASSWORD);
  const dirB = await s.login('dirb', PASSWORD);
  const u1 = await mk(dirA, { name: '김선생', username: 'teach1' });
  const t1 = await s.login('teach1', PASSWORD);
  const A = da.academy.id;
  const B = dbB.academy.id;
  const student = ok(await rq('POST', '/api/students', { token: dirA, body: { name: '홍길동' } })).student;

  const q = encodeURIComponent;
  const file = (p, aca) => `/api/sync/ohdapnote/academy/file?path=${q(p)}${aca ? `&academy=${aca}` : ''}`;
  const put = (token, p, body, baseRev = 0, aca = null) => rq('PUT', `${file(p, aca)}&baseRev=${baseRev}`, { token, raw: Buffer.from(body) });
  const get = (token, p, aca = null) => rq('GET', file(p, aca), { token });
  const del = (token, p, baseRev, aca = null) => rq('DELETE', `${file(p, aca)}&baseRev=${baseRev}`, { token });
  const list = (token, aca = null) => rq('GET', `/api/sync/ohdapnote/academy?since=0${aca ? `&academy=${aca}` : ''}`, { token });
  const paths = (r) => ok(r).entries.filter((e) => !e.deleted).map((e) => e.path).sort();

  ok(await put(t1, 'books/b1/book.json', '{"name":"A교재"}'));
  ok(await put(t1, `members/${u1.id}/x.json`, '{"mine":1}'));
  ok(await put(t1, `students/${student.id}/notes/n.json`, '{"n":1}'));
  ok(await put(dirA, 'academy.json', '{"a":1}'));
  ok(await put(dirB, 'books/bb/book.json', '{"name":"B교재"}'));

  const operatorRows = () => db.all("SELECT * FROM audit WHERE action LIKE 'operator.%' ORDER BY id");
  return { s, rq, db, admin, dirA, dirB, t1, u1, A, B, student, put, get, del, list, paths, operatorRows };
}

test('운영자: 학원을 고르면 그 학원 자료를 원장과 같은 범위로', async (t) => {
  const c = await setup(t);
  const { rq, admin, A, B } = c;

  await t.test('학원 공간 목록·내려받기·HEAD', async () => {
    assert.deepEqual(c.paths(await c.list(admin, A)), ['academy.json', 'books/b1/book.json', `members/${c.u1.id}/x.json`, `students/${c.student.id}/notes/n.json`]);
    assert.deepEqual(c.paths(await c.list(admin, B)), ['books/bb/book.json'], '다른 학원 것은 섞이지 않음');
    const g = await c.get(admin, 'books/b1/book.json', A);
    assert.equal(g.status, 200);
    assert.equal(g.data.toString(), '{"name":"A교재"}');
    assert.equal((await c.get(admin, `members/${c.u1.id}/x.json`, A)).status, 200, '원장처럼 선생님 개인 자료도 봄');
    const h = await rq('HEAD', `/api/sync/ohdapnote/academy/file?path=academy.json&academy=${A}`, { token: admin });
    assert.equal(h.status, 200);
    assert.equal(h.headers.get('x-rev'), '1');
  });

  await t.test('학원 공간 PUT·DELETE 차단, POST·PATCH 미지원, 원본 유지', async () => {
    error(await c.put(admin, 'books/b1/book.json', '{}', 1, A), 403, 'operator_read_only');
    error(await c.del(admin, 'books/b1/book.json', 1, A), 403, 'operator_read_only');
    for (const method of ['POST', 'PATCH']) {
      error(await rq(method, `/api/sync/ohdapnote/academy/file?path=books/b1/book.json&academy=${A}`, { token: admin, body: {} }), 405);
    }
    assert.equal((await c.get(c.t1, 'books/b1/book.json')).data.toString(), '{"name":"A교재"}');
    assert.equal((await c.get(admin, 'books/b1/book.json', A)).headers.get('x-rev'), '1');
  });

  await t.test('학원 공간 요약: 프로그램별 자료 수', async () => {
    const r = ok(await rq('GET', `/api/sync?academy=${A}`, { token: admin }));
    assert.equal(r.academy.id, A);
    assert.ok(r.academy.apps.some((a) => a.appId === 'ohdapnote' && a.files >= 4));
    assert.equal(ok(await rq('GET', '/api/sync', { token: admin })).academy, null, '학원을 안 고르면 지금처럼 없음');
  });

  await t.test('학생 명단·학생 계정·학원 정보·학원 AI·학원 사람', async () => {
    const st = ok(await rq('GET', `/api/students?academy=${A}`, { token: admin }));
    assert.deepEqual(st.students.map((x) => x.name), ['홍길동']);
    assert.deepEqual(ok(await rq('GET', `/api/students?academy=${B}`, { token: admin })).students, []);
    const added = ok(await rq('POST', `/api/students?academy=${A}`, { token: admin, body: { name: '김철수' } })).student;
    ok(await rq('PATCH', `/api/students/${added.id}?academy=${A}`, { token: admin, body: { name: '김철수2' } }));
    error(await rq('PATCH', `/api/students/${added.id}?academy=${B}`, { token: admin, body: { name: 'x' } }), 404);
    ok(await rq('POST', `/api/students/${added.id}/account?academy=${A}`, { token: admin, body: { username: 'kimcs', password: PASSWORD } }));
    assert.equal(ok(await rq('GET', `/api/academy?academy=${A}`, { token: admin })).academy.id, A);
    ok(await rq('GET', `/api/academy/ai/all?academy=${A}`, { token: admin }));
    const members = ok(await rq('GET', `/api/academy/members?academy=${A}`, { token: admin })).members;
    assert.ok(members.some((m) => m.name === '김선생'));
  });
});

test('운영자: 학원을 고르지 않은 요청은 지금처럼 막힘', async (t) => {
  const c = await setup(t);
  const { rq, admin } = c;
  const before = c.operatorRows().length;
  error(await c.list(admin), 404, 'no_academy');
  error(await c.get(admin, 'academy.json'), 404, 'no_academy');
  error(await rq('GET', '/api/students', { token: admin }), 400, 'academy_required');
  error(await rq('POST', `/api/students/${c.student.id}/account`, { token: admin, body: { username: 'nobody', password: PASSWORD } }), 400, 'academy_required');
  error(await rq('GET', '/api/students?academy=abc', { token: admin }), 400, 'academy_required');
  error(await c.list(admin, 'abc'), 400, 'academy_required');
  error(await rq('GET', '/api/students?academy=99999', { token: admin }), 404);
  error(await c.list(admin, 99999), 404);
  assert.equal(c.operatorRows().length, before, '학원이 정해지지 않았으면 운영자 기록도 없음');
});

test('회귀: 원장·선생님은 ?academy= 를 무시하고 자기 학원만', async (t) => {
  const c = await setup(t);
  const { rq, dirA, dirB, t1, A, B } = c;
  assert.deepEqual(c.paths(await c.list(dirA, B)), c.paths(await c.list(dirA)), 'A 원장이 B 를 붙여도 A 자료');
  assert.ok(!c.paths(await c.list(dirA, B)).includes('books/bb/book.json'));
  assert.ok(!c.paths(await c.list(t1, B)).includes('books/bb/book.json'));
  error(await c.get(dirA, 'books/bb/book.json', B), 404, 'no_file');
  ok(await c.put(dirA, 'books/b9/book.json', '{}', 0, B));
  assert.ok(c.paths(await c.list(dirA)).includes('books/b9/book.json'), 'A 학원에 들어감');
  assert.ok(!c.paths(await c.list(dirB)).includes('books/b9/book.json'), 'B 학원에는 안 들어감');
  assert.deepEqual(ok(await rq('GET', `/api/students?academy=${B}`, { token: dirA })).students.map((x) => x.name), ['홍길동'], '원장 학생 명단도 자기 학원');
  assert.equal(ok(await rq('GET', `/api/academy?academy=${B}`, { token: dirA })).academy.id, A);
  assert.equal(ok(await rq('GET', `/api/sync?academy=${B}`, { token: dirA })).academy.id, A);
  assert.equal(c.paths(await c.list(dirB)).includes(`students/${c.student.id}/notes/n.json`), false, 'B 원장은 A 자료를 못 봄');
  assert.equal(c.operatorRows().length, 0, '원장·선생님 요청은 운영자 기록을 남기지 않음');
});

test('감사: 운영자 열람·변경마다 학원 ID·상태가 남고, 다른 query 값은 안 남음', async (t) => {
  const c = await setup(t);
  const { rq, admin, A, B } = c;
  ok(await c.list(admin, A));
  ok(await c.get(admin, 'books/b1/book.json', A));
  error(await c.put(admin, 'books/b1/book.json', '{"v":2}', 1, A), 403, 'operator_read_only');
  error(await c.put(admin, `members/${c.u1.id}/x.json`, '{}', 1, A), 403, 'operator_read_only');
  error(await c.del(admin, 'books/b1/book.json', 1, A), 403, 'operator_read_only');
  ok(await rq('GET', `/api/students?academy=${A}&q=${encodeURIComponent('홍길동')}`, { token: admin }));
  ok(await c.list(admin, B));

  const rows = c.operatorRows();
  const view = (r) => ({ action: r.action, academy: r.academy_id, target: r.target, detail: JSON.parse(r.detail) });
  assert.deepEqual(rows.map(view), [
    { action: 'operator.view', academy: A, target: 'GET /api/sync/ohdapnote/academy', detail: { status: 200, app: 'ohdapnote' } },
    { action: 'operator.view', academy: A, target: 'GET /api/sync/ohdapnote/academy/file', detail: { status: 200, file: 'books/b1/book.json', app: 'ohdapnote' } },
    { action: 'operator.change', academy: A, target: 'PUT /api/sync/ohdapnote/academy/file', detail: { status: 403, file: 'books/b1/book.json', app: 'ohdapnote' } },
    { action: 'operator.change', academy: A, target: 'PUT /api/sync/ohdapnote/academy/file', detail: { status: 403, file: `members/${c.u1.id}/x.json`, app: 'ohdapnote' } },
    { action: 'operator.change', academy: A, target: 'DELETE /api/sync/ohdapnote/academy/file', detail: { status: 403, file: 'books/b1/book.json', app: 'ohdapnote' } },
    { action: 'operator.view', academy: A, target: 'GET /api/students', detail: { status: 200 } },
    { action: 'operator.view', academy: B, target: 'GET /api/sync/ohdapnote/academy', detail: { status: 200, app: 'ohdapnote' } },
  ]);
  for (const r of rows) {
    assert.ok(r.actor.includes('admin'));
    assert.ok(!r.detail.includes('홍길동') && !r.detail.includes('baseRev') && !r.detail.includes('since'), '검색어·since·baseRev 는 안 남김');
  }

  const onlyA = ok(await rq('GET', `/api/audit?academy=${A}&action=operator.&limit=500`, { token: admin })).entries;
  assert.equal(onlyA.length, 6);
  assert.ok(onlyA.every((e) => e.academy === 'A학원'));
  const all = ok(await rq('GET', '/api/audit?action=operator.&limit=500', { token: admin })).entries;
  assert.ok(all.length >= 7, '학원을 안 고르면 모든 학원');
  ok(await rq('GET', '/api/audit?academy=abc', { token: admin }));
});

test('보기 허가증: 운영자·학원·프로그램 검사, typ view·10분·운영자 기기·jti·서버 거절', async (t) => {
  const c = await setup(t);
  const ticket = (token, id, viewAcademy) => c.rq('POST', `/api/apps/${id}/ticket`, { token, body: { viewAcademy } });
  error(await ticket(c.dirA, 'ohdapnote', c.A), 403);
  error(await ticket(c.admin, 'ohdapnote', ''), 400);
  error(await ticket(c.admin, 'ohdapnote', 999999), 404);
  ok(await ticket(c.admin, 'tajong', c.A));
  ok(await c.rq('POST', '/api/admin/apps', { token: c.admin, body: { id: 'shared-app', name: '학원 프로그램', source: { type: 'local' } } }));
  ok(await ticket(c.admin, 'shared-app', c.A));
  ok(await c.rq('POST', '/api/admin/apps', { token: c.admin, body: { id: 'web-app', name: '웹 프로그램', platform: 'web', url: 'https://example.com' } }));
  error(await ticket(c.admin, 'web-app', c.A), 400);
  error(await ticket(c.dirA, 'web-app', c.A), 403);
  const r = ok(await ticket(c.admin, 'ohdapnote', c.A));
  const payload = require('../../sdk/node/magoedu-cloud').verifyTicket(r.ticket, c.s.app.deps.trustKeys(), { appId: 'ohdapnote' });
  assert.equal(payload.ro, 1); assert.equal(payload.aca, c.A); assert.equal(payload.rol, 'admin');
  assert.equal(payload.typ, 'view');
  assert.equal(payload.exp - payload.iat, 10 * 60);
  const user = ok(await c.rq('GET', '/api/me', { token: c.admin })).user;
  const session = c.db.get('SELECT device_id FROM sessions WHERE user_id = (SELECT id FROM users WHERE uid = ?)', user.id);
  assert.equal(payload.sub, user.id); assert.equal(payload.usr, user.username); assert.equal(payload.dev, session.device_id);
  assert.match(payload.jti, /^[A-Za-z0-9_-]{20,}$/);
  const second = ok(await ticket(c.admin, 'ohdapnote', c.A));
  assert.notEqual(JSON.parse(Buffer.from(second.ticket.split('.')[1], 'base64url')).jti, payload.jti);
  for (const url of ['/api/ai/relay/ohdapnote/v1/models', '/api/me', `/api/sync/ohdapnote/academy?academy=${c.A}`]) error(await c.rq('GET', url, { token: r.ticket }), 401);
  const opening = c.operatorRows().find((r) => r.action === 'operator.open' && JSON.parse(r.detail).jti === payload.jti);
  assert.deepEqual(JSON.parse(opening.detail), { app: 'ohdapnote', jti: payload.jti });
  assert.equal(c.operatorRows().filter((r) => r.action === 'operator.open' && r.target === 'ohdapnote').length, 2);
  const normal = ok(await c.rq('POST', '/api/apps/ohdapnote/ticket', { token: c.admin }));
  assert.equal(JSON.parse(Buffer.from(normal.ticket.split('.')[1], 'base64url')).ro, undefined);
});

test('학원 공간 open: GET·HEAD 외 모든 메서드는 operator_read_only', () => {
  let handler;
  const router = { get: (url, fn) => { if (url === '/api/sync/:appId/academy') handler = fn; }, put() {}, delete() {} };
  require('../src/routes/shared').register(router, { db: { get: () => ({ id: 'notes' }) }, svc: {
    authenticate: () => ({ user: { role: 'admin' }, session: {} }), canUseApp: () => true, operatorAcademy: () => 1,
  } });
  for (const method of ['PUT', 'DELETE', 'POST', 'PATCH', 'OPTIONS', 'TRACE']) assert.throws(() => handler({ req: { method }, query: new URLSearchParams({ academy: '1' }), params: { appId: 'notes' } }), (err) => err.status === 403 && err.code === 'operator_read_only');
});
