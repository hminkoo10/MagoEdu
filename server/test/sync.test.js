'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, ADMIN_PASSWORD } = require('./helpers');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DAY = 24 * 60 * 60 * 1000;

test('동기화: 같은 아이디는 어느 컴퓨터에서든 같은 데이터', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { request: rq } = s;
  const admin = await s.login('admin', ADMIN_PASSWORD);
  await rq('POST', '/api/users', {
    token: admin,
    body: { role: 'teacher', name: '선생', username: 'teach', password: 'pass1234', academyName: '학원', mustChangePassword: false },
  });
  const pc1 = await s.login('teach', 'pass1234', 'pc-1');
  const pc2 = await s.login('teach', 'pass1234', 'pc-2');

  const put = (token, p, buf, baseRev, extra = {}) =>
    rq('PUT', `/api/sync/ohdapnote/file?path=${encodeURIComponent(p)}&baseRev=${baseRev}${extra.group ? `&group=${encodeURIComponent(extra.group)}` : ''}`, {
      token,
      raw: buf,
      headers: { 'x-sha256': extra.sha || sha(buf), ...(extra.headers || {}) },
    });

  await t.test('올리고 다른 컴퓨터에서 받기', async () => {
    const body = Buffer.from('{"name":"쎈 수학"}');
    const up = await put(pc1, 'data/projects/p1/project.json', body, 0, { group: 'data/projects/p1' });
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assert.equal(up.data.entry.rev, 1);
    assert.equal(up.data.entry.group, 'data/projects/p1');

    const list = await rq('GET', '/api/sync/ohdapnote', { token: pc2 });
    assert.equal(list.data.entries.length, 1);
    assert.equal(list.data.entries[0].sha256, sha(body));
    const dl = await rq('GET', `/api/sync/ohdapnote/file?path=${encodeURIComponent('data/projects/p1/project.json')}`, { token: pc2 });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('x-rev'), '1');
    assert.deepEqual(dl.data, body);
  });

  await t.test('먼저 바뀐 파일은 덮어쓰지 않음 (409)', async () => {
    const p = 'data/projects/p1/project.json';
    const a = await put(pc1, p, Buffer.from('v2 from pc1'), 1, { group: 'data/projects/p1' });
    assert.equal(a.data.entry.rev, 2);
    const b = await put(pc2, p, Buffer.from('v2 from pc2'), 1, { group: 'data/projects/p1' });
    assert.equal(b.status, 409);
    assert.equal(b.data.error.entry.rev, 2);
  });

  await t.test('이어서 받기(since)와 지우기', async () => {
    const first = await rq('GET', '/api/sync/ohdapnote', { token: pc2 });
    const cursor = first.data.seq;
    await put(pc1, 'data/settings.json', Buffer.from('{}'), 0);
    const inc = await rq('GET', `/api/sync/ohdapnote?since=${cursor}`, { token: pc2 });
    assert.deepEqual(inc.data.entries.map((e) => e.path), ['data/settings.json']);
    const del = await rq('DELETE', `/api/sync/ohdapnote/file?path=data/settings.json&baseRev=1`, { token: pc2 });
    assert.equal(del.data.entry.deleted, true);
    assert.equal(del.data.entry.rev, 2);
    const gone = await rq('GET', '/api/sync/ohdapnote/file?path=data/settings.json', { token: pc1 });
    assert.equal(gone.status, 404);
    const again = await put(pc1, 'data/settings.json', Buffer.from('{"a":1}'), 2);
    assert.equal(again.data.entry.rev, 3, '지운 뒤 다시 만들 수 있음');
  });

  await t.test('같은 내용은 다시 보내지 않고 연결(x-link)', async () => {
    const body = Buffer.from('same content');
    await put(pc1, 'data/a.bin', body, 0);
    const link = await rq('PUT', `/api/sync/ohdapnote/file?path=data/b.bin&baseRev=0`, {
      token: pc2,
      raw: Buffer.alloc(0),
      headers: { 'x-sha256': sha(body), 'x-link': '1' },
    });
    assert.equal(link.status, 200, JSON.stringify(link.data));
    assert.equal(link.data.entry.size, body.length);
    const dl = await rq('GET', '/api/sync/ohdapnote/file?path=data/b.bin', { token: pc2 });
    assert.deepEqual(dl.data, body);
  });

  await t.test('잘못된 경로와 내용 불일치는 거절', async () => {
    for (const p of ['../x', '/abs', 'a//b', 'a/./b', 'C:/x', 'a\\b', 'dir/']) {
      const r = await put(pc1, p, Buffer.from('x'), 0);
      assert.equal(r.status, 400, p);
    }
    const r = await put(pc1, 'data/x.bin', Buffer.from('abc'), 0, { sha: sha(Buffer.from('other')) });
    assert.equal(r.data.error.code, 'checksum_mismatch');
    const g = await put(pc1, 'data/y.bin', Buffer.from('abc'), 0, { group: 'data/projects/p9' });
    assert.equal(g.data.error.code, 'invalid_group');
  });

  await t.test('다른 계정의 데이터는 보이지 않음', async () => {
    await rq('POST', '/api/users', {
      token: admin,
      body: { role: 'teacher', name: '다른', username: 'other', password: 'pass1234', academyName: '학원2', mustChangePassword: false },
    });
    const o = await s.login('other', 'pass1234');
    const list = await rq('GET', '/api/sync/ohdapnote', { token: o });
    assert.equal(list.data.entries.length, 0);
    const dl = await rq('GET', '/api/sync/ohdapnote/file?path=data/a.bin', { token: o });
    assert.equal(dl.status, 404);
  });

  await t.test('저장 공간 한도', async () => {
    const list = await rq('GET', '/api/users?q=teach', { token: admin });
    const id = list.data.users.find((u) => u.username === 'teach').id;
    await rq('PATCH', `/api/users/${id}`, { token: admin, body: { quotaMb: 1 } });
    const big = Buffer.alloc(1024 * 1024 + 10, 7);
    const r = await put(pc1, 'data/big.bin', big, 0);
    assert.equal(r.status, 507);
    assert.equal(r.data.error.code, 'quota_exceeded');
    const sum = await rq('GET', '/api/sync', { token: pc1 });
    assert.equal(sum.data.quotaBytes, 1024 * 1024);
    assert.ok(sum.data.usageBytes > 0);
    await rq('PATCH', `/api/users/${id}`, { token: admin, body: { quotaMb: null } });
  });
});

test('보관 기간: 오래 쓰지 않은 큰 데이터는 서버에서만 지움', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { request: rq } = s;
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const put = (p, buf, baseRev, group, app = 'ohdapnote') =>
    rq('PUT', `/api/sync/${app}/file?path=${encodeURIComponent(p)}&baseRev=${baseRev}&group=${encodeURIComponent(group)}`, {
      token: admin,
      raw: buf,
      headers: { 'x-sha256': sha(buf) },
    });

  const oldBook = Buffer.alloc(5000, 1);
  const newBook = Buffer.alloc(3000, 2);
  await put('data/projects/old/problem.pdf', oldBook, 0, 'data/projects/old');
  await put('data/projects/old/project.json', Buffer.from('{}'), 0, 'data/projects/old');
  await put('data/projects/new/problem.pdf', newBook, 0, 'data/projects/new');
  await put('sounds/bell.wav', Buffer.alloc(100, 3), 0, 'sounds', 'tajong');

  const db = s.app.deps.db;
  const blobFile = (h) => path.join(s.dataDir, 'blobs', h.slice(0, 2), h.slice(2, 4), h);
  // old 묶음은 40일 전에 마지막으로 바뀐 것으로
  db.run("UPDATE files SET updated_at = ? WHERE path LIKE 'data/projects/old/%'", Date.now() - 40 * DAY);
  db.run("UPDATE group_activity SET last_used_at = ? WHERE grp = 'data/projects/old'", Date.now() - 40 * DAY);
  db.run("UPDATE files SET updated_at = ? WHERE app_id = 'tajong'", Date.now() - 400 * DAY);

  await t.test('기간이 지난 묶음만 지우고, 보관 기간이 꺼진 프로그램은 그대로', async () => {
    const before = (await rq('GET', '/api/sync/ohdapnote', { token: admin })).data.seq;
    const r = await rq('POST', '/api/admin/cold-storage/run', { token: admin });
    assert.deepEqual([r.data.groups, r.data.files], [1, 2]);
    const list = await rq('GET', '/api/sync/ohdapnote', { token: admin });
    const byPath = Object.fromEntries(list.data.entries.map((e) => [e.path, e]));
    assert.equal(byPath['data/projects/old/problem.pdf'].evicted, true);
    assert.equal(byPath['data/projects/old/problem.pdf'].sha256, sha(oldBook), '목록에는 남아 있어 다른 컴퓨터가 알아봄');
    assert.equal(byPath['data/projects/new/problem.pdf'].evicted, false);
    assert.ok(list.data.seq > before, '바뀐 것으로 알려 줌');
    assert.equal(fs.existsSync(blobFile(sha(oldBook))), false, '서버에서 내용은 지움');
    assert.equal(fs.existsSync(blobFile(sha(newBook))), true);
    const dl = await rq('GET', '/api/sync/ohdapnote/file?path=data/projects/old/problem.pdf', { token: admin });
    assert.equal(dl.status, 410);
    const tj = await rq('GET', '/api/sync/tajong', { token: admin });
    assert.equal(tj.data.entries[0].evicted, false);
    const usage = await rq('GET', '/api/sync', { token: admin });
    assert.equal(usage.data.apps.find((a) => a.appId === 'ohdapnote').evictedGroups, 1);
  });

  await t.test('다시 쓰면 다시 올라옴', async () => {
    const list = await rq('GET', '/api/sync/ohdapnote', { token: admin });
    const e = list.data.entries.find((x) => x.path === 'data/projects/old/problem.pdf');
    const up = await put(e.path, oldBook, e.rev, 'data/projects/old');
    assert.equal(up.status, 200);
    assert.equal(up.data.entry.evicted, false);
    const dl = await rq('GET', '/api/sync/ohdapnote/file?path=data/projects/old/problem.pdf', { token: admin });
    assert.deepEqual(dl.data, oldBook);
  });

  await t.test('열어 보기만 해도(touch) 기간이 다시 시작', async () => {
    db.run("UPDATE files SET updated_at = ? WHERE path LIKE 'data/projects/new/%'", Date.now() - 40 * DAY);
    db.run("UPDATE group_activity SET last_used_at = ? WHERE grp = 'data/projects/new'", Date.now() - 40 * DAY);
    const touch = await rq('POST', '/api/sync/ohdapnote/touch', { token: admin, body: { groups: ['data/projects/new', '../bad'] } });
    assert.equal(touch.data.touched, 1);
    const r = await rq('POST', '/api/admin/cold-storage/run', { token: admin });
    assert.equal(r.data.groups, 0);
  });

  await t.test('보관 기간 바꾸기 (운영자)', async () => {
    const r = await rq('PATCH', '/api/admin/apps/ohdapnote', { token: admin, body: { coldStorage: { enabled: true, days: 90 } } });
    assert.deepEqual(r.data.app.coldStorage, { enabled: true, days: 90 });
  });
});
