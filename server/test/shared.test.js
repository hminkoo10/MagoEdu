'use strict';

// 학원 공간: 같은 학원 사람들이 함께 쓰는 파일 (routes/shared.js, sharing.js)

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { startServer, ADMIN_PASSWORD } = require('./helpers');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** 실시간 알림에서 change 만 모은다 */
function listen(base, token) {
  return new Promise((resolve, reject) => {
    const changes = [];
    const req = http.get(`${base}/api/sync/events?apps=ohdapnote`, { headers: { authorization: `Bearer ${token}` } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!block.startsWith('event: change')) continue;
          changes.push(JSON.parse(block.split('\n').find((l) => l.startsWith('data:')).slice(5)));
        }
      });
      resolve({ changes, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('시간 안에 되지 않았어요');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('학원 공간: 교재는 학원 모두가 보고, 만든 사람과 원장만 고침', async (t) => {
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
  await mk(admin, { role: 'director', name: 'B원장', username: 'dirb', academyName: 'B학원' });
  const dirA = await s.login('dira', 'pass1234');
  const dirB = await s.login('dirb', 'pass1234');
  const u1 = await mk(dirA, { name: '김선생', username: 'teach1' });
  const u2 = await mk(dirA, { name: '이선생', username: 'teach2' });
  const t1 = await s.login('teach1', 'pass1234');
  const t2 = await s.login('teach2', 'pass1234', 'dev-2');

  const q = (p) => encodeURIComponent(p);
  const put = (token, p, body, baseRev = 0, headers = {}) =>
    rq('PUT', `/api/sync/ohdapnote/academy/file?path=${q(p)}&baseRev=${baseRev}`, { token, raw: Buffer.from(body), headers });
  const get = (token, p) => rq('GET', `/api/sync/ohdapnote/academy/file?path=${q(p)}`, { token });
  const del = (token, p, baseRev) => rq('DELETE', `/api/sync/ohdapnote/academy/file?path=${q(p)}&baseRev=${baseRev}`, { token });
  const list = async (token, since = 0) => (await rq('GET', `/api/sync/ohdapnote/academy?since=${since}`, { token })).data;
  const paths = async (token) => (await list(token)).entries.filter((e) => !e.deleted).map((e) => e.path).sort();

  await t.test('교재: 만든 사람이 주인, 같은 학원 선생님은 보기만', async () => {
    const r = await put(t1, 'books/b1/book.json', '{"name":"쎈 수학"}');
    assert.equal(r.status, 200);
    assert.equal(r.data.entry.rev, 1);
    assert.equal(r.data.entry.updatedBy, u1.id);
    assert.equal((await put(t1, 'books/b1/problem-1.pdf', 'PDF1')).status, 200, '자기 교재에는 파일을 더 넣을 수 있음');

    assert.deepEqual(await paths(t2), ['books/b1/book.json', 'books/b1/problem-1.pdf']);
    const g = await get(t2, 'books/b1/book.json');
    assert.equal(g.status, 200);
    assert.equal(g.data.toString(), '{"name":"쎈 수학"}');

    const no = await put(t2, 'books/b1/book.json', '{"name":"바꿈"}', 1);
    assert.equal(no.status, 403);
    assert.equal(no.data.error.code, 'not_owner');
    assert.equal((await put(t2, 'books/b1/extra.pdf', 'X')).status, 403, '남의 교재에 파일 추가도 안 됨');
    assert.equal((await del(t2, 'books/b1/book.json', 1)).status, 403);

    const byDir = await put(dirA, 'books/b1/book.json', '{"name":"원장이 고침"}', 1);
    assert.equal(byDir.status, 200, '원장은 고칠 수 있음');
    assert.equal(byDir.data.entry.rev, 2);
    assert.equal((await put(t1, 'books/b1/book.json', '{"name":"주인"}', 2)).status, 200, '원장이 고쳐도 주인은 그대로');

    assert.equal((await put(t2, 'books/b2/book.json', '{"name":"내 교재"}')).status, 200, '새 교재는 누구나');
    assert.equal((await put(t1, 'books/b2/book.json', '{}', 1)).status, 403);
  });

  await t.test('충돌과 같은 내용 다시 보내지 않기', async () => {
    const c = await put(t1, 'books/b1/book.json', '{}', 0);
    assert.equal(c.status, 409);
    assert.equal(c.data.error.code, 'conflict');
    assert.equal(c.data.error.entry.rev, 3);
    // 공유 교재를 복사할 때: 같은 PDF 는 확인 값만 보냄
    const link = await put(t2, 'books/b2/problem-1.pdf', '', 0, { 'x-link': '1', 'x-sha256': sha('PDF1') });
    assert.equal(link.status, 200);
    assert.equal(link.data.entry.size, 4);
    assert.equal((await get(t2, 'books/b2/problem-1.pdf')).data.toString(), 'PDF1');
    const none = await put(t2, 'books/b2/other.pdf', '', 0, { 'x-link': '1', 'x-sha256': sha('없는 내용') });
    assert.equal(none.status, 404);
  });

  await t.test('학원 공용 파일(한 단계 경로)은 원장만', async () => {
    assert.equal((await put(t1, 'academy.json', '{"ai":{"key":"x"}}')).status, 403);
    assert.equal((await put(dirA, 'academy.json', '{"ai":{"key":"k"}}')).status, 200);
    assert.equal((await get(t1, 'academy.json')).data.toString(), '{"ai":{"key":"k"}}');
  });

  await t.test('members/<계정>: 본인과 원장만 보고, 본인만 고침', async () => {
    const mine = `members/${u1.id}/notes/n1.json`;
    assert.equal((await put(t1, mine, '{"student":"철수"}')).status, 200);
    assert.ok(!(await paths(t2)).includes(mine), '다른 선생님 목록에는 없음');
    assert.equal((await get(t2, mine)).status, 403);
    assert.ok((await paths(dirA)).includes(mine), '원장 목록에는 있음');
    assert.equal((await get(dirA, mine)).data.toString(), '{"student":"철수"}');
    assert.equal((await put(dirA, mine, '{}', 1)).status, 403, '원장도 남의 노트는 못 고침');
    assert.equal((await put(t2, `members/${u1.id}/notes/n2.json`, '{}')).status, 403);
    assert.equal((await put(t2, `members/${u2.id}/profile.json`, '{"name":"이선생"}')).status, 200);
    assert.equal((await put(t1, 'members/a.b/x.json', '{}')).status, 400);
    assert.equal((await put(t1, 'members/someone/x.json', '{}')).status, 403);
    assert.equal((await put(t1, `members/${u1.id}`, '{}')).status, 400);
  });

  await t.test('다른 학원·학원 없는 계정', async () => {
    assert.deepEqual(await paths(dirB), [], '다른 학원 공간은 비어 있음');
    assert.equal((await get(dirB, 'books/b1/book.json')).status, 404);
    assert.equal((await put(dirB, 'books/b1/book.json', '{"name":"B학원 교재"}')).status, 200, '같은 경로라도 학원마다 따로');
    assert.equal((await get(t1, 'books/b1/book.json')).data.toString(), '{"name":"주인"}');
    const r = await rq('GET', '/api/sync/ohdapnote/academy', { token: admin });
    assert.equal(r.status, 404);
    assert.equal(r.data.error.code, 'no_academy');
  });

  await t.test('지우기·이어 받기', async () => {
    const before = await list(t2);
    assert.equal((await del(t1, 'books/b1/problem-1.pdf', 1)).status, 200);
    const after = await list(t2, before.seq);
    assert.deepEqual(
      after.entries.map((e) => [e.path, e.deleted]),
      [['books/b1/problem-1.pdf', true]],
    );
    assert.equal((await get(t2, 'books/b1/problem-1.pdf')).status, 404);
    // 내용은 b2 가 아직 써서 남아 있음
    s.app.deps.blobs.gc();
    assert.ok(s.app.deps.blobs.has(sha('PDF1')));
  });

  await t.test('실시간: 같은 학원 사람에게만 바로 알림', async () => {
    const a2 = await listen(s.base, t2);
    const b = await listen(s.base, dirB);
    t.after(() => {
      a2.close();
      b.close();
    });
    await new Promise((r) => setTimeout(r, 100));
    const r = await put(t1, 'books/b3/book.json', '{"name":"새 교재"}');
    await until(() => a2.changes.length > 0);
    assert.deepEqual(a2.changes[0], { appId: 'ohdapnote', seq: r.data.entry.seq, deviceId: 'dev-1', scope: 'academy' });
    await new Promise((r2) => setTimeout(r2, 150));
    assert.equal(b.changes.length, 0, '다른 학원에는 알리지 않음');
  });
});

test('학원 공간: 서버를 다시 켜도 seq 가 뒤로 가지 않음 (개인 파일과 같은 번호 줄)', async (t) => {
  const s = await startServer();
  const admin = await s.login('admin', ADMIN_PASSWORD);
  await s.request('POST', '/api/users', {
    token: admin,
    body: { role: 'director', name: '원장', username: 'dir', academyName: '학원', password: 'pass1234', mustChangePassword: false },
  });
  const dir = await s.login('dir', 'pass1234');
  const a = await s.request('PUT', '/api/sync/ohdapnote/academy/file?path=academy.json&baseRev=0', { token: dir, raw: Buffer.from('1') });
  assert.equal(a.status, 200);
  await s.app.close();

  // 같은 데이터 폴더로 다시 켬: 마지막 변경이 학원 공간이어도 그다음 번호부터
  const { createCloudServer, loadConfig } = require('../src/app');
  const again = createCloudServer(loadConfig({}, { dataDir: s.dataDir, adminPassword: ADMIN_PASSWORD, launcherRepo: '', background: false, quiet: true }));
  const addr = await again.listen(0, '127.0.0.1');
  try {
    const p = await fetch(`http://127.0.0.1:${addr.port}/api/sync/ohdapnote/file?path=settings.json&baseRev=0`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${dir}` },
      body: '2',
    }).then((r) => r.json());
    assert.ok(p.entry.seq > a.data.entry.seq, `${p.entry.seq} > ${a.data.entry.seq}`);
  } finally {
    await again.close();
    require('node:fs').rmSync(s.dataDir, { recursive: true, force: true });
  }
});
