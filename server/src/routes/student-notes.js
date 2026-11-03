'use strict';

const fs = require('node:fs/promises');
const { forbidden, notFound } = require('../util');
const { validPath } = require('./sync');
const { buildNotesPdf } = require('../notes-pdf');

const APP = 'ohdapnote';
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const noNote = () => notFound('오답노트를 찾을 수 없어요.', 'no_note');

function requireStudent(user) {
  if (user?.role !== 'student' || !user.student_id) throw forbidden('학생 계정만 볼 수 있어요.', 'student_only');
  if (!user.academy_id || !ID_RE.test(user.student_id)) throw noNote();
  return user;
}

// 파일 이름이 아닌 학원·앱·경로로 먼저 조회한다. 내용 주소(sha)는 저장소에서만 쓴다.
function academyFileReader({ db, blobs }, academyId) {
  const readFile = async (p) => {
    validPath(p);
    const f = db.get('SELECT * FROM shared_files WHERE academy_id = ? AND app_id = ? AND path = ? AND deleted = 0', academyId, APP, p);
    if (!f || !blobs.has(f.sha256)) throw notFound('원본 파일이 없어요.', 'no_file');
    return fs.readFile(blobs.pathFor(f.sha256));
  };
  // 계정 삭제로 다른 선생님에게 옮긴 개인 교재도 찾는다. 같은 ID가 여러 곳이면 추측하지 않는다.
  readFile.findBook = (id) => {
    if (!ID_RE.test(id)) return null;
    const rows = db.all(
      'SELECT path FROM shared_files WHERE academy_id = ? AND app_id = ? AND deleted = 0 AND path GLOB ?',
      academyId, APP, `members/*/books/${id}/book.json`,
    ).filter((r) => /^members\/[A-Za-z0-9-]{1,64}\/books\/[A-Za-z0-9-]{1,64}\/book\.json$/.test(r.path));
    return rows.length === 1 ? rows[0].path.slice(0, -10) : null;
  };
  return readFile;
}

function createStudentNotes(deps, user) {
  requireStudent(user);
  const prefix = `students/${user.student_id}/notes/`;
  const readFile = academyFileReader(deps, user.academy_id);

  async function get(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw noNote();
    let note;
    try {
      note = JSON.parse(await readFile(`${prefix}${id}.json`));
    } catch (err) {
      if (err instanceof SyntaxError || err.status === 404 || err.code === 'ENOENT') throw noNote();
      throw err;
    }
    // 예전 노트는 studentId가 비어 있다. 소유 학생은 폴더로 판단한다.
    if (!note || note.id !== id || note.deleted || note.deletedAt) throw noNote();
    return note;
  }

  async function list() {
    const rows = deps.db.all(
      'SELECT path, updated_at FROM shared_files WHERE academy_id = ? AND app_id = ? AND deleted = 0 AND path GLOB ? ORDER BY updated_at DESC, path',
      user.academy_id, APP, `${prefix}*.json`,
    );
    const notes = [];
    for (const row of rows) {
      const id = row.path.slice(prefix.length, -5);
      if (!ID_RE.test(id)) continue;
      try {
        const note = await get(id);
        notes.push({
          id,
          title: typeof note.title === 'string' && note.title.trim() ? note.title : '오답노트',
          updatedAt: Number.isFinite(note.updatedAt) ? note.updatedAt : row.updated_at,
          problemCount: Object.values(note.selected || {}).reduce((n, ids) => n + (Array.isArray(ids) ? ids.length : 0), 0),
          answersAllowed: note.answersForStudent === true,
        });
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    return notes.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  return { get, list, readFile };
}

function register(router, deps) {
  const open = (ctx) => createStudentNotes(deps, deps.svc.authenticate(ctx).user);
  router.get('/api/me/notes', (ctx) => open(ctx).list());
  router.get('/api/me/notes/:id/pdf', async (ctx) => {
    const notes = open(ctx);
    const note = await notes.get(ctx.params.id);
    const bytes = Buffer.from(await buildNotesPdf(note, notes.readFile));
    const title = String(note.title || '오답노트').replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '_').slice(0, 120);
    const filename = encodeURIComponent(`${title}.pdf`).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    ctx.res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': bytes.length,
      'content-disposition': `inline; filename="note.pdf"; filename*=UTF-8''${filename}`,
      'cache-control': 'no-store',
    });
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : bytes);
  });
}

module.exports = { register, requireStudent, academyFileReader, createStudentNotes };
