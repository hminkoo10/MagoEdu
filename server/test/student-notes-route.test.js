'use strict';

// 학생 계정과 학생 오답노트 PDF를 실제 서버 경로로 함께 확인

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument, StandardFonts } = require('../src/vendor/pdf-lib');
const { startServer, ADMIN_PASSWORD } = require('./helpers');

const PASSWORD = 'student-pass-1234';
const BID = 'book-0001';
const rect = { page: 0, x: 0.1, y: 0.2, w: 0.4, h: 0.25 };
const item = (id, number) => ({ id, number: String(number), num: number, page: 0, col: 0, rects: [{ ...rect }] });

async function sourcePdf(label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText(label, { x: 80, y: 600, size: 24, font });
  return Buffer.from(await doc.save());
}

function ok(r) {
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

function error(r, status, code) {
  assert.equal(r.status, status, JSON.stringify(r.data));
  assert.equal(r.data.error.code, code);
}

test('학생 오답노트: 학생 웹 세션만 자기 노트 목록·PDF를 받고 답지는 허락한 노트에만 들어가요', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { db, blobs, nextSeq } = s.app.deps;
  const rq = s.request;
  const admin = await s.login('admin', ADMIN_PASSWORD);
  ok(await rq('POST', '/api/users', { token: admin, body: { username: 'director-a', name: '가원장', role: 'director', academyName: '가학원', password: PASSWORD, mustChangePassword: false } }));
  const dir = await s.login('director-a', PASSWORD);
  const aca = db.get("SELECT academy_id FROM users WHERE username = 'director-a'").academy_id;
  const sky = ok(await rq('POST', '/api/students', { token: dir, body: { name: '김하늘' } })).student;
  const sea = ok(await rq('POST', '/api/students', { token: dir, body: { name: '이바다' } })).student;
  ok(await rq('POST', `/api/students/${sky.id}/account`, { token: dir, body: { username: 'sky01', password: PASSWORD } }));

  const put = (p, bytes) => {
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.mkdirSync(path.dirname(blobs.pathFor(sha)), { recursive: true });
    fs.writeFileSync(blobs.pathFor(sha), bytes);
    const now = Date.now();
    db.run(`INSERT INTO shared_files(academy_id, app_id, path, rev, seq, sha256, size, mtime, deleted, updated_by, updated_at)
            VALUES (?, 'ohdapnote', ?, 1, ?, ?, ?, ?, 0, 'test', ?)
            ON CONFLICT(academy_id, app_id, path) DO UPDATE SET rev = rev + 1, seq = excluded.seq, sha256 = excluded.sha256, size = excluded.size, updated_at = excluded.updated_at`,
    aca, p, nextSeq(), sha, bytes.length, now, now);
  };
  const book = {
    id: BID, name: '수학 교재',
    docs: {
      problem: { files: [{ name: 'problem-1.pdf', kind: 'pdf' }], items: [item('p1', 1)] },
      answer: { files: [{ name: 'answer-1.pdf', kind: 'pdf' }], items: [item('a1', 1)] },
    },
  };
  put(`books/${BID}/book.json`, Buffer.from(JSON.stringify(book)));
  put(`books/${BID}/problem-1.pdf`, await sourcePdf('PROBLEM 1'));
  put(`books/${BID}/answer-1.pdf`, await sourcePdf('ANSWER 1'));
  const note = (sid, id, extra = {}) => ({
    id, kind: 'note', version: 2, title: '하늘 기말', studentId: sid, bookIds: [BID], selected: { [BID]: ['p1'] },
    updatedAt: Date.now(), answersForStudent: false, ...extra,
  });
  put(`students/${sky.id}/notes/note-sky.json`, Buffer.from(JSON.stringify(note(sky.id, 'note-sky'))));
  put(`students/${sea.id}/notes/note-sea.json`, Buffer.from(JSON.stringify(note(sea.id, 'note-sea'))));

  // 학생은 웹에서만
  error(await rq('POST', '/api/auth/login', { body: { username: 'sky01', password: PASSWORD, device: { id: 'pc-1', platform: 'windows' } } }), 403, 'student_web_only');
  const student = ok(await rq('POST', '/api/auth/login', { body: { username: 'sky01', password: PASSWORD, device: { id: 'web-1', platform: 'web' } } })).token;

  const list = ok(await rq('GET', '/api/me/notes', { token: student }));
  assert.deepEqual(list.map((n) => [n.id, n.problemCount, n.answersAllowed]), [['note-sky', 1, false]]);

  const pages = async () => {
    const r = await rq('GET', '/api/me/notes/note-sky/pdf', { token: student });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    return (await PDFDocument.load(r.data)).getPageCount();
  };
  const without = await pages();
  put(`students/${sky.id}/notes/note-sky.json`, Buffer.from(JSON.stringify(note(sky.id, 'note-sky', { answersForStudent: true }))));
  assert.equal(ok(await rq('GET', '/api/me/notes', { token: student }))[0].answersAllowed, true);
  assert.ok(await pages() > without, '답지를 허락하면 해설 쪽이 더 들어가야 해요');

  // 다른 학생 노트·학생이 아닌 계정·학생이 못 쓰는 경로
  error(await rq('GET', '/api/me/notes/note-sea/pdf', { token: student }), 404, 'no_note');
  error(await rq('GET', '/api/me/notes', { token: dir }), 403, 'student_only');
  error(await rq('GET', '/api/students', { token: student }), 403, 'student_forbidden');
  error(await rq('GET', '/api/sync', { token: student }), 403, 'student_forbidden');

  // 선생님이 계정을 끄면 세션이 끊겨요
  ok(await rq('PATCH', `/api/students/${sky.id}/account`, { token: dir, body: { status: 'disabled' } }));
  assert.equal((await rq('GET', '/api/me/notes', { token: student })).status, 401);
});
