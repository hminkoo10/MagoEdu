'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { openEvents, until } = require('./event-helpers');
const { startServer, ADMIN_PASSWORD } = require('./helpers');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DAY = 24 * 60 * 60 * 1000;

test('실시간 알림: 계정의 파일이 바뀌면 바로 알려 줌', async (t) => {
  // 예전의 450ms 고정 대기보다 늦게 갱신해도 알림을 놓치지 않아야 한다.
  const s = await startServer({ eventPingMs: 150, eventRecheckMs: 1200 });
  t.after(() => s.close());
  const { request: rq } = s;
  const admin = await s.login('admin', ADMIN_PASSWORD, 'admin-pc');
  for (const [username, academyName] of [
    ['teach', '학원'],
    ['other', '다른 학원'],
  ]) {
    await rq('POST', '/api/users', {
      token: admin,
      body: { role: 'teacher', name: username, username, password: 'pass1234', academyName, mustChangePassword: false },
    });
  }
  const pc1 = await s.login('teach', 'pass1234', 'pc-1');
  const pc2 = await s.login('teach', 'pass1234', 'pc-2');
  const other = await s.login('other', 'pass1234', 'other-pc');
  const streams = [];
  const open = async (...a) => {
    const st = await openEvents(s.base, ...a);
    streams.push(st);
    return st;
  };
  t.after(() => streams.forEach((st) => st.close()));

  const put = (token, app, p, buf, baseRev = 0) =>
    rq('PUT', `/api/sync/${app}/file?path=${encodeURIComponent(p)}&baseRev=${baseRev}`, { token, raw: buf, headers: { 'x-sha256': sha(buf) } });

  await t.test('연결하면 hello', async () => {
    const st = await open(pc1);
    assert.equal(st.status, 200);
    assert.equal(st.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(st.headers['cache-control'], 'no-cache, no-transform');
    assert.equal(st.headers['x-accel-buffering'], 'no');
    const hello = st.hello;
    assert.match(hello.data.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    st.close();
  });

  await t.test('로그인하지 않으면 401', async () => {
    const none = await open(null);
    assert.equal(none.status, 401);
    assert.equal(none.body.error.code, 'auth_required');
    const bad = await open('mgc_nope');
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'session_invalid');
  });

  await t.test('다른 기기가 올리고 지우면 change', async () => {
    const st = await open(pc1);
    const up = await put(pc2, 'ohdapnote', 'data/a.json', Buffer.from('{"a":1}'));
    assert.equal(up.status, 200);
    const c1 = await st.next('change');
    assert.deepEqual(c1.data, { appId: 'ohdapnote', seq: up.data.entry.seq, deviceId: 'pc-2' });
    const del = await rq('DELETE', '/api/sync/ohdapnote/file?path=data/a.json&baseRev=1', { token: pc2 });
    assert.equal(del.data.entry.deleted, true);
    const c2 = await st.next('change');
    assert.deepEqual(c2.data, { appId: 'ohdapnote', seq: del.data.entry.seq, deviceId: 'pc-2' });
    // 이미 지운 파일을 다시 지우면 바뀐 게 없으니 알리지 않음 → 다음 알림은 그 뒤에 올린 것
    await rq('DELETE', '/api/sync/ohdapnote/file?path=data/a.json&baseRev=2', { token: pc2 });
    const again = await put(pc1, 'ohdapnote', 'data/b.json', Buffer.from('b'));
    const c3 = await st.next('change');
    assert.deepEqual(c3.data, { appId: 'ohdapnote', seq: again.data.entry.seq, deviceId: 'pc-1' }, '내 기기가 올린 것도 기기 ID와 함께 옴');
    st.close();
  });

  await t.test('apps 로 고른 프로그램만', async () => {
    const st = await open(pc1, '?apps=tajong');
    await put(pc2, 'ohdapnote', 'data/c.json', Buffer.from('c'));
    const tj = await put(pc2, 'tajong', 'config.json', Buffer.from('{}'));
    const c = await st.next('change');
    assert.deepEqual(c.data, { appId: 'tajong', seq: tj.data.entry.seq, deviceId: 'pc-2' }, 'ohdapnote 는 건너뜀');
    st.close();
    assert.equal((await open(pc1, '?apps=nope')).status, 404);
  });

  await t.test('권한이 없는 프로그램은 고를 수 없고, 바뀐 권한은 다시 확인할 때 반영', async () => {
    const users = await rq('GET', '/api/users?q=teach', { token: admin });
    const id = users.data.users.find((u) => u.username === 'teach').id;
    await rq('PATCH', `/api/users/${id}`, { token: admin, body: { allowedApps: ['ohdapnote'] } });
    const denied = await open(pc1, '?apps=tajong');
    assert.equal(denied.status, 403);
    const st = await open(pc1);
    // 정해진 시간을 재지 않고, 이 구독에 새 권한이 반영된 뒤에 파일을 올린다.
    const { events, svc } = s.app.deps;
    const subscription = [...events.streams].findLast((stream) => stream.authorization === `Bearer ${pc1}`);
    assert.ok(subscription);
    assert.equal(svc.canUseApp(subscription.user, 'tajong'), false);
    await rq('PATCH', `/api/users/${id}`, { token: admin, body: { allowedApps: ['ohdapnote', 'tajong'] } });
    await until(() => svc.canUseApp(subscription.user, 'tajong'), '프로그램 권한 재확인');
    const tj = await put(pc2, 'tajong', 'state.json', Buffer.from('{}'));
    const c = await st.next('change');
    assert.equal(c.data.seq, tj.data.entry.seq);
    st.close();
  });

  await t.test('다른 계정에는 가지 않음', async () => {
    const mine = await open(other);
    await put(pc1, 'ohdapnote', 'data/secret.json', Buffer.from('secret'));
    const own = await put(other, 'ohdapnote', 'data/mine.json', Buffer.from('mine'));
    const c = await mine.next('change');
    assert.deepEqual(c.data, { appId: 'ohdapnote', seq: own.data.entry.seq, deviceId: 'other-pc' }, '첫 알림이 내 것');
    mine.close();
  });

  await t.test('서버가 오래된 데이터를 정리해도 알림 (기기 없음)', async () => {
    const st = await open(pc1, '?apps=ohdapnote');
    const buf = Buffer.from('old');
    const up = await rq('PUT', `/api/sync/ohdapnote/file?path=data/projects/old/p.pdf&baseRev=0&group=data/projects/old`, {
      token: pc2,
      raw: buf,
      headers: { 'x-sha256': sha(buf) },
    });
    assert.equal((await st.next('change')).data.seq, up.data.entry.seq);
    const db = s.app.deps.db;
    db.run("UPDATE files SET updated_at = ? WHERE path LIKE 'data/projects/old/%'", Date.now() - 40 * DAY);
    db.run("UPDATE group_activity SET last_used_at = ? WHERE grp = 'data/projects/old'", Date.now() - 40 * DAY);
    assert.equal(s.app.deps.jobs.runColdStorage().groups, 1);
    const c = await st.next('change');
    assert.equal(c.data.appId, 'ohdapnote');
    assert.equal(c.data.deviceId, null);
    assert.ok(c.data.seq > up.data.entry.seq);
    st.close();
  });

  await t.test('연결을 살려 두는 ping', async () => {
    const st = await open(pc1);
    const ping = await st.next('comment');
    assert.equal(ping.data, 'ping');
    st.close();
  });

  await t.test('세션 하나에 연결은 5개까지 (넘으면 오래된 것부터 끊음)', async () => {
    const list = [];
    for (let i = 0; i < 6; i += 1) {
      const st = await open(pc2);
      list.push(st);
    }
    await list[0].waitEnd();
    assert.equal(list[1].ended, false);
    assert.equal(list[5].ended, false);
    list.forEach((st) => st.close());
  });

  await t.test('로그아웃하면 연결도 끊김', async () => {
    const tmp = await s.login('teach', 'pass1234', 'pc-tmp');
    const st = await open(tmp);
    await rq('POST', '/api/auth/logout', { token: tmp });
    await st.waitEnd();
  });

  await t.test('닫은 연결은 정리됨', async () => {
    for (const st of streams) st.close();
    const hub = s.app.deps.events;
    await until(() => hub.size === 0, '닫은 연결 정리');
    assert.equal(hub.size, 0);
    assert.equal(hub.timers, null, '연결이 없으면 타이머도 멈춤');
  });
});

test('실시간 알림: 연결이 열려 있어도 서버는 바로 꺼짐', async (t) => {
  const s = await startServer();
  let closing;
  const close = () => (closing ||= s.close());
  t.after(close);
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const st = await openEvents(s.base, admin);
  t.after(() => st.close());

  const started = Date.now();
  await close();
  assert.ok(Date.now() - started < 2000, `${Date.now() - started}ms`);
  await st.waitEnd();
});
