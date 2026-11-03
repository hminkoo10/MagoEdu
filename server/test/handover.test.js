'use strict';

// 계정 삭제: 학원 공간에 남긴 것(members/<계정>/ 파일, 만든 공유 자료, 담당 학생)은 같은 학원 원장에게 넘김

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ADMIN_PASSWORD } = require('./helpers');

test('계정 삭제: 학원 공간 자료를 원장에게 넘기고, 원장에게 같은 경로가 있으면 원래 자리에 둠', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const rq = s.request;
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const mk = async (token, body) => {
    const r = await rq('POST', '/api/users', { token, body: { password: 'pass1234', mustChangePassword: false, ...body } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.user;
  };
  const d1 = await mk(admin, { role: 'director', name: 'A원장', username: 'dira', academyName: 'A학원' });
  const dirA = await s.login('dira', 'pass1234');
  const academyId = (await rq('GET', '/api/academies', { token: dirA })).data.academies[0].id;
  const d2 = await mk(admin, { role: 'director', name: 'A부원장', username: 'dira2', academyId });
  await mk(admin, { role: 'director', name: 'B원장', username: 'dirb', academyName: 'B학원' });
  const dirA2 = await s.login('dira2', 'pass1234');
  const u1 = await mk(dirA, { name: '김선생', username: 'teach1' });
  const u2 = await mk(dirA, { name: '이선생', username: 'teach2' });
  const t1 = await s.login('teach1', 'pass1234');
  const t2 = await s.login('teach2', 'pass1234', 'dev-2');

  const q = (p) => encodeURIComponent(p);
  const put = (token, p, body) => rq('PUT', `/api/sync/ohdapnote/academy/file?path=${q(p)}&baseRev=0`, { token, raw: Buffer.from(body) });
  const get = (token, p) => rq('GET', `/api/sync/ohdapnote/academy/file?path=${q(p)}`, { token });
  const live = async (token) =>
    (await rq('GET', '/api/sync/ohdapnote/academy?since=0', { token })).data.entries.filter((e) => !e.deleted).map((e) => e.path).sort();
  const mine = (u, rest) => `members/${u.id}/${rest}`;

  assert.equal((await put(t1, mine(u1, 'books/x1/book.json'), '{"name":"나만 보기"}')).status, 200);
  assert.equal((await put(t1, mine(u1, 'transcripts/b1.json'), '{"p":"선생님"}')).status, 200);
  assert.equal((await put(dirA2, mine(d2, 'transcripts/b1.json'), '{"p":"원장"}')).status, 200);
  assert.equal((await put(t1, mine(u1, 'profile.json'), '{"name":"김선생"}')).status, 200);
  assert.equal((await put(t1, 'books/b1/book.json', '{"name":"공유 교재"}')).status, 200);
  assert.equal((await put(t2, mine(u2, 'books/y1/book.json'), '{"name":"이선생 교재"}')).status, 200);
  const st = await rq('POST', '/api/students', { token: t1, body: { name: '홍길동', teacherId: u1.id } });
  assert.equal(st.status, 200, JSON.stringify(st.data));

  await t.test('지우기 전에 넘길 것과 넘겨받을 수 있는 원장을 보여 줌', async () => {
    const r = await rq('GET', `/api/users/${u1.id}/handover`, { token: dirA });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.files, 2);
    assert.equal(r.data.bytes, Buffer.byteLength('{"name":"나만 보기"}') + Buffer.byteLength('{"p":"선생님"}'), '바로 아래 profile.json 은 빼고');
    assert.equal(r.data.items, 1);
    assert.equal(r.data.students, 1);
    assert.deepEqual(r.data.to.map((x) => x.id), [d1.id, d2.id], '같은 학원 원장만');
    assert.equal(r.data.defaultTo, d1.id, '지우는 원장이 기본');
    assert.equal((await rq('GET', `/api/users/${u1.id}/handover`, { token: t2 })).status, 403);
  });

  await t.test('다른 학원 원장에게는 넘기지 못하고, 그때는 아무것도 지우지 않음', async () => {
    const dirB = (await rq('GET', '/api/users?role=director', { token: admin })).data.users.find((x) => x.username === 'dirb');
    const r = await rq('DELETE', `/api/users/${u1.id}?to=${dirB.id}`, { token: dirA });
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'invalid_receiver');
    assert.equal((await rq('GET', `/api/users/${u1.id}/handover`, { token: dirA })).data.files, 2);
  });

  await t.test('고른 원장에게 넘김: 파일은 그 원장 폴더로, 공유 자료 주인과 담당 학생도', async () => {
    const r = await rq('DELETE', `/api/users/${u1.id}?to=${d2.id}`, { token: dirA });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.handedTo, { id: d2.id, name: 'A부원장', files: 1, kept: 1, items: 1, students: 1 });

    const expected = [
      'books/b1/book.json',
      mine(d2, 'books/x1/book.json'),
      mine(d2, 'transcripts/b1.json'),
      mine(u1, 'profile.json'), // 그 사람 이름이라 옮기지 않음 (넘겨받은 원장 이름이 바뀌지 않게)
      mine(u1, 'transcripts/b1.json'), // 원장에게 이미 있어서 원래 자리에 (원장은 볼 수 있음)
      mine(u2, 'books/y1/book.json'),
    ];
    assert.deepEqual(await live(dirA2), expected.sort());
    const g = await get(dirA2, mine(d2, 'books/x1/book.json'));
    assert.equal(g.status, 200);
    assert.equal(g.data.toString(), '{"name":"나만 보기"}');
    assert.equal((await get(dirA2, mine(d2, 'transcripts/b1.json'))).data.toString(), '{"p":"원장"}', '원장 것은 그대로');
    // 넘겨받은 원장은 자기 폴더라 고칠 수 있음
    const edit = await rq('PUT', `/api/sync/ohdapnote/academy/file?path=${q(mine(d2, 'books/x1/book.json'))}&baseRev=1`, {
      token: dirA2,
      raw: Buffer.from('{"name":"고침"}'),
    });
    assert.equal(edit.status, 200, JSON.stringify(edit.data));
    // 옛 자리는 지운 것으로 알림 (다른 기기가 지우게)
    const old = (await rq('GET', '/api/sync/ohdapnote/academy?since=0', { token: dirA2 })).data.entries.find((e) => e.path === mine(u1, 'books/x1/book.json'));
    assert.equal(old.deleted, true);

    assert.equal((await rq('GET', `/api/users/${d2.id}/handover`, { token: admin })).data.items, 1, '공유 교재 주인');
    const s1 = (await rq('GET', '/api/students', { token: dirA })).data.students[0];
    assert.deepEqual(s1.teacher, { id: d2.id, name: 'A부원장' });

    const audit = (await rq('GET', '/api/audit?action=user.delete', { token: admin })).data.entries[0];
    assert.equal(audit.detail.to, 'A부원장 (dira2)');
    assert.equal(audit.detail.files, 1);
  });

  await t.test('원장을 고르지 않으면 지우는 원장에게', async () => {
    const r = await rq('DELETE', `/api/users/${u2.id}`, { token: dirA });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.handedTo.id, d1.id);
    assert.ok((await live(dirA)).includes(mine(d1, 'books/y1/book.json')));
  });
});
