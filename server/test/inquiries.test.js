'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { startServer, ADMIN_PASSWORD } = require('./helpers');
const { openEvents } = require('./event-helpers');
const { hashPassword } = require('../src/security');
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
async function setup(t, overrides = {}) {
  const s = await startServer(overrides); t.after(() => s.close());
  s.admin = await s.login('admin', ADMIN_PASSWORD);
  for (const [username, role, academyName] of [['director', 'director', '시험학원'], ['teacher', 'teacher', '시험학원'], ['outsider', 'teacher', '다른학원']]) {
    const r = await s.request('POST', '/api/users', { token: s.admin, body: { username, name: username, role, academyName, password: 'pass1234', mustChangePassword: false } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    s[username] = await s.login(username, 'pass1234');
  }
  const db = s.app.deps.db;
  const aca = db.get("SELECT academy_id FROM users WHERE username = 'director'").academy_id;
  db.run("INSERT INTO students(id, academy_id, name, created_at, updated_at) VALUES ('student-test', ?, '학생이름', 1, 1)", aca);
  db.run("INSERT INTO users(uid, username, name, role, academy_id, student_id, password_hash, created_at, updated_at) VALUES ('student-test', 'student', '학생이름', 'student', ?, 'student-test', ?, 1, 1)", aca, hashPassword('pass1234'));
  const r = await s.request('POST', '/api/auth/login', { body: { username: 'student', password: 'pass1234', device: { id: 'web-test', platform: 'web' } } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); s.student = r.data.token;
  s.send = (token, body = {}) => s.request('POST', '/api/inquiries', { token, body: { title: '제목', body: '본문', ...body } });
  s.upload = (token, raw = PNG) => s.request('POST', '/api/inquiries/photos', { token, raw });
  return s;
}
test('inquiries: roles, status, read markers, filtering, limits and private access', async t => {
  const s = await setup(t); const rq = s.request;
  for (const token of [s.director, s.teacher, s.student]) {
    const made = await s.send(token); assert.equal(made.status, 200, JSON.stringify(made.data));
    const id = made.data.inquiry.id;
    assert.equal(made.data.inquiry.status, 'open');
    const msg = (who, body) => rq('POST', `/api/inquiries/${id}/messages`, { token: who, body: { body } });
    const get = who => rq('GET', `/api/inquiries/${id}`, { token: who });
    for (const stranger of [s.outsider, ...[s.director, s.teacher, s.student].filter(x => x !== token)]) {
      assert.equal((await get(stranger)).status, 404);
      assert.equal((await msg(stranger, '남의 글')).status, 404);
      assert.equal((await rq('GET', `/api/inquiries/${id}/photos/unknown`, { token: stranger })).status, 404);
    }
    assert.equal((await rq('POST', `/api/inquiries/${id}/close`, { token })).status, 403);
    assert.equal((await rq('POST', `/api/inquiries/${id}/reopen`, { token })).status, 403);
    assert.equal((await msg(s.admin, '답변')).status, 200);
    assert.ok((await rq('GET', '/api/inquiries/unread', { token })).data.count > 0);
    assert.equal((await get(token)).data.inquiry.status, 'answered');
    assert.equal((await rq('GET', '/api/inquiries/unread', { token })).data.count, 0);
    await msg(token, '다시 문의'); assert.equal((await get(token)).data.inquiry.status, 'open');
    await rq('POST', `/api/inquiries/${id}/close`, { token: s.admin }); assert.equal((await get(token)).data.inquiry.status, 'closed');
    await rq('POST', `/api/inquiries/${id}/reopen`, { token: s.admin }); assert.equal((await get(token)).data.inquiry.status, 'open');
    await rq('POST', `/api/inquiries/${id}/close`, { token: s.admin });
    await msg(token, '다시 열기'); assert.equal((await get(token)).data.inquiry.status, 'open');
    assert.equal((await rq('GET', '/api/inquiries', { token })).data.inquiries.length, 1);
  }
  const all = (await rq('GET', '/api/inquiries?status=open', { token: s.admin })).data.inquiries;
  assert.equal(all.length, 3); assert.ok(all.every(i => i.senderName && i.client));
  assert.ok(all[0].lastMessageAt >= all[1].lastMessageAt);
  await rq('GET', `/api/inquiries/${all[0].id}`, { token: s.admin });
  const sorted = (await rq('GET', '/api/inquiries', { token: s.admin })).data.inquiries;
  assert.equal(sorted.at(-1).id, all[0].id, 'unread open threads come before read ones');
  const db = s.app.deps.db;
  const student = db.get("SELECT * FROM users WHERE username = 'student'");
  const appToken = s.app.deps.svc.createSession(student, { id: 'app-test', platform: 'web-app' }, '', { appId: 'mago-navi' });
  assert.equal((await rq('GET', '/api/inquiries', { token: appToken })).status, 403);
  db.run('UPDATE users SET must_change_password = 1 WHERE id = ?', student.id);
  assert.equal((await rq('GET', '/api/inquiries', { token: s.student })).data.error.code, 'password_change_required');
  assert.equal((await s.send(s.outsider, { title: 'x'.repeat(101) })).status, 400);
  assert.equal((await s.send(s.outsider, { body: 'x'.repeat(2001) })).status, 400);
  for (let n = 0; n < 5; n++) assert.equal((await s.send(s.outsider)).status, 200);
  const sixth = await s.send(s.outsider); assert.equal(sixth.status, 429); assert.equal(sixth.data.error.code, 'too_many');
});
test('inquiries: photo validation, ownership, headers, quotas, expiry and orphan cleanup', async t => {
  const s = await setup(t); const rq = s.request;
  for (const raw of [Buffer.alloc(0), Buffer.from('text.png'), Buffer.from('GIF89a')]) assert.equal((await s.upload(s.teacher, raw)).status, 400);
  assert.equal((await s.upload(s.teacher, Buffer.alloc(5 * 1024 * 1024 + 1))).status, 413);
  const ids = [];
  for (const bytes of [PNG, Buffer.from('ffd8ff', 'hex'), Buffer.from('RIFF1234WEBP')]) {
    const r = await s.upload(s.teacher, bytes); assert.equal(r.status, 200); ids.push(r.data.photo.id);
  }
  assert.equal((await s.send(s.director, { photoIds: [ids[0]] })).status, 400);
  assert.equal((await s.send(s.teacher, { photoIds: [...ids, 'fourth'] })).status, 400);
  const made = await s.send(s.teacher, { photoIds: ids }); assert.equal(made.status, 200);
  const id = made.data.inquiry.id;
  for (let n = 0; n < ids.length; n++) {
    const r = await rq('GET', `/api/inquiries/${id}/photos/${ids[n]}`, { token: s.teacher });
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), ['image/png', 'image/jpeg', 'image/webp'][n]);
    assert.equal(r.headers.get('cache-control'), 'private, no-store'); assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(r.headers.get('content-disposition'), 'inline');
  }
  assert.equal((await s.send(s.teacher, { photoIds: [ids[0]] })).status, 400);
  const db = s.app.deps.db;
  db.run('UPDATE inquiries SET closed_at = ? WHERE id = ?', Date.now() - 31 * 86400000, id);
  await rq('POST', `/api/inquiries/${id}/reopen`, { token: s.admin });
  s.app.deps.inquiries.cleanup();
  assert.ok(db.get('SELECT 1 FROM inquiry_photos WHERE id = ?', ids[0]));
  await rq('POST', `/api/inquiries/${id}/close`, { token: s.admin });
  s.app.deps.inquiries.cleanup();
  assert.ok(db.get('SELECT 1 FROM inquiry_photos WHERE id = ?', ids[0]));
  db.run('UPDATE inquiries SET closed_at = ? WHERE id = ?', Date.now() - 31 * 86400000, id);
  const pending = (await s.upload(s.student)).data.photo.id;
  db.run('UPDATE inquiry_photos SET created_at = 1 WHERE id = ?', pending);
  s.app.deps.jobs.runAll();
  for (const p of [...ids, pending]) { assert.equal(db.get('SELECT 1 FROM inquiry_photos WHERE id = ?', p), undefined); assert.equal(fs.existsSync(path.join(s.app.deps.inquiries.dir, p)), false); }
  assert.equal((await rq('GET', `/api/inquiries/${id}`, { token: s.teacher })).data.messages[0].photosExpired, true);
  const orphan = 'a'.repeat(48); const file = path.join(s.app.deps.inquiries.dir, orphan); fs.writeFileSync(file, PNG); fs.utimesSync(file, 1, 1);
  s.app.deps.inquiries.cleanup(); assert.equal(fs.existsSync(file), false);
  for (let n = 0; n < 9; n++) assert.equal((await s.upload(s.outsider)).status, 200);
  assert.equal((await s.upload(s.outsider)).status, 400);
  const waiting = db.all('SELECT id FROM inquiry_photos WHERE user_id = (SELECT id FROM users WHERE username = ?)', 'outsider').map(p => p.id);
  for (let n = 0; n < 3; n++) assert.equal((await s.send(s.outsider, { photoIds: waiting.slice(n * 3, n * 3 + 3) })).status, 200);
  // The quota-rejected attempt also counts toward abuse protection.
  for (let n = 0; n < 5; n++) assert.equal((await s.upload(s.outsider)).status, 200);
  assert.equal((await s.upload(s.outsider)).status, 429);
});
test('inquiries: SSE recipients, inquiry-only isolation and student recheck lifetime', async t => {
  const s = await setup(t, { eventPingMs: 20, eventRecheckMs: 30 });
  const streams = [];
  for (const token of [s.admin, s.student, s.outsider]) streams.push(await openEvents(s.base, token, token === s.student ? '?apps=does-not-exist' : '?only=inquiry'));
  t.after(() => streams.forEach(x => x.close()));
  await new Promise(r => setTimeout(r, 100)); assert.equal(streams[1].ended, false);
  const { inquiry } = (await s.send(s.student)).data;
  for (const stream of streams.slice(0, 2)) assert.deepEqual((await stream.next('inquiry')).data, { id: inquiry.id, kind: 'created', fromAdmin: false });
  const db = s.app.deps.db; const uid = db.get("SELECT id FROM users WHERE username = 'student'").id;
  s.app.deps.events.publish(uid, 'ohdapnote', 1); s.app.deps.events.publishAcademyInfo(1, 'students');
  s.app.deps.events.publish(db.get("SELECT id FROM users WHERE role = 'admin'").id, 'ohdapnote', 2);
  await new Promise(r => setTimeout(r, 70));
  assert.equal(streams[2].events.some(e => e.event === 'inquiry'), false);
  assert.equal(streams[1].events.some(e => ['change', 'academy'].includes(e.event)), false);
  assert.equal(streams[0].events.some(e => ['change', 'academy'].includes(e.event)), false);
});
test('inquiries: local-only Discord, safe payload, URL validation and secret-free audit/logs', async t => {
  const received = [];
  const receiver = http.createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; received.push(JSON.parse(body)); res.writeHead(500); res.end(); });
  await new Promise(r => receiver.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => receiver.close(r)));
  const s = await setup(t, { inquiryWebhookAllowLocal: true }); const rq = s.request;
  const tokenText = 'local_test_secret'; const url = `http://127.0.0.1:${receiver.address().port}/api/webhooks/123/${tokenText}`;
  const logs = []; s.app.deps.log.warn = (...args) => logs.push(args.join(' '));
  for (const invalid of ['http://discord.com/api/webhooks/1/test', 'https://example.invalid/api/webhooks/1/test', 'https://discord.com.evil.com/api/webhooks/1/test', 'https://user@discord.com/api/webhooks/1/test', 'https://discord.com/else']) assert.equal((await rq('PUT', '/api/admin/inquiry-webhook', { token: s.admin, body: { url: invalid } })).status, 400);
  assert.equal((await rq('PUT', '/api/admin/inquiry-webhook', { token: s.admin, body: { url } })).status, 200);
  assert.equal(JSON.stringify((await rq('GET', '/api/admin/inquiry-webhook', { token: s.admin })).data).includes(tokenText), false);
  const made = await s.send(s.student, { title: '질문 @everyone', body: '비밀본문' }); assert.equal(made.status, 200);
  for (let n = 0; n < 100 && !received.length; n++) await new Promise(r => setTimeout(r, 10));
  assert.equal(received.length, 1); assert.deepEqual(received[0].allowed_mentions, { parse: [] });
  assert.match(received[0].content, /^새 문의 #\d+ · 학생 · 시험학원\n제목: 질문/);
  for (const secret of ['비밀본문', '학생이름', 'student-test', '@everyone']) assert.equal(received[0].content.includes(secret), false);
  await rq('POST', `/api/inquiries/${made.data.inquiry.id}/messages`, { token: s.admin, body: { body: '답' } });
  await new Promise(r => setTimeout(r, 40)); assert.equal(received.length, 1);
  const audit = JSON.stringify(s.app.deps.db.all('SELECT * FROM audit'));
  assert.equal(audit.includes(tokenText), false); assert.equal(audit.includes(url), false); assert.equal(logs.join(' ').includes(tokenText), false);
  await new Promise(r => receiver.close(r));
  assert.equal((await s.send(s.teacher)).status, 200);
  await rq('DELETE', '/api/admin/inquiry-webhook', { token: s.admin });
  assert.equal((await rq('GET', '/api/admin/inquiry-webhook', { token: s.admin })).data.set, false);
});

test('inquiries: account, academy and student hard deletion removes files; admin replies survive', async t => {
  const s = await setup(t); const rq = s.request; const db = s.app.deps.db;
  async function conversation(token) {
    const pending = (await s.upload(token)).data.photo.id;
    const attached = (await s.upload(token)).data.photo.id;
    const made = await s.send(token, { photoIds: [attached] });
    assert.equal(made.status, 200);
    await rq('POST', `/api/inquiries/${made.data.inquiry.id}/messages`, { token: s.admin, body: { body: '답변 유지' } });
    return { id: made.data.inquiry.id, photos: [pending, attached] };
  }
  function gone(c) {
    assert.equal(db.get('SELECT 1 FROM inquiries WHERE id = ?', c.id), undefined);
    assert.equal(db.get('SELECT 1 FROM inquiry_messages WHERE inquiry_id = ?', c.id), undefined);
    for (const p of c.photos) { assert.equal(db.get('SELECT 1 FROM inquiry_photos WHERE id = ?', p), undefined); assert.equal(fs.existsSync(path.join(s.app.deps.inquiries.dir, p)), false); }
  }
  const teacher = await conversation(s.teacher);
  const uid = db.get("SELECT uid FROM users WHERE username = 'teacher'").uid;
  assert.equal((await rq('DELETE', `/api/users/${uid}`, { token: s.admin })).status, 200); gone(teacher);
  const student = await conversation(s.student);
  const aca = db.get("SELECT academy_id FROM users WHERE username = 'student'").academy_id;
  db.run("UPDATE students SET deleted_at = 1 WHERE id = 'student-test'");
  s.app.deps.students.purge(aca, ['student-test']); gone(student);
  const outsider = await conversation(s.outsider);
  const otherAca = db.get("SELECT academy_id FROM users WHERE username = 'outsider'").academy_id;
  assert.equal((await rq('DELETE', `/api/academies/${otherAca}`, { token: s.admin })).status, 200); gone(outsider);
  const remaining = await conversation(s.director);
  const adminId = db.get("SELECT id FROM users WHERE username = 'admin'").id;
  const { deleteUser } = require('../src/hard-delete');
  db.tx(() => deleteUser(db, db.get('SELECT * FROM users WHERE id = ?', adminId), s.app.deps.nextSeq));
  const reply = db.get('SELECT * FROM inquiry_messages WHERE inquiry_id = ? AND from_admin = 1', remaining.id);
  assert.equal(reply.author_id, null); assert.equal(reply.body, '답변 유지');
});

test('inquiries: 남의 실제 사진은 문의 id 를 바꿔도 못 보고, 운영자는 문의를 만들지 않음', async t => {
  const s = await setup(t); const rq = s.request;
  const photo = (await s.upload(s.teacher)).data.photo.id;
  const theirs = (await s.send(s.teacher, { photoIds: [photo] })).data.inquiry.id;
  const mine = (await s.send(s.outsider)).data.inquiry.id;
  // 같은 학원 원장·다른 학원 사람·학생: 그 문의 id 로 그 사진
  for (const token of [s.director, s.outsider]) assert.equal((await rq('GET', `/api/inquiries/${theirs}/photos/${photo}`, { token })).status, 404);
  // 자기 문의 id 에 남의 사진 id 를 붙여도
  assert.equal((await rq('GET', `/api/inquiries/${mine}/photos/${photo}`, { token: s.outsider })).status, 404);
  assert.equal((await rq('GET', `/api/inquiries/${mine}/photos/${photo}`, { token: s.admin })).status, 404);
  assert.equal((await rq('GET', `/api/inquiries/${theirs}/photos/${photo}`, { token: s.admin })).status, 200);
  assert.equal((await rq('GET', `/api/inquiries/${theirs}/photos/${photo}`, { token: s.teacher })).status, 200);
  const made = await s.send(s.admin);
  assert.equal(made.status, 403);
  assert.equal(s.app.deps.db.get('SELECT COUNT(*) AS n FROM inquiries').n, 2);
});

test('inquiries: 원장이 학생 계정만 지워도 그 학생 문의·사진 파일이 바로 지워짐', async t => {
  const s = await setup(t); const rq = s.request; const db = s.app.deps.db;
  db.run("UPDATE users SET must_change_password = 0 WHERE username = 'student'");
  const photo = (await s.upload(s.student)).data.photo.id;
  const pending = (await s.upload(s.student)).data.photo.id;
  const made = await s.send(s.student, { photoIds: [photo] });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const r = await rq('DELETE', '/api/students/student-test/account', { token: s.director });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(db.get('SELECT 1 FROM inquiries WHERE id = ?', made.data.inquiry.id), undefined);
  for (const p of [photo, pending]) assert.equal(fs.existsSync(path.join(s.app.deps.inquiries.dir, p)), false);
});
