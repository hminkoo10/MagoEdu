'use strict';

const fs = require('node:fs');
const { Library } = require('../library');
const { forbidden, notFound, intOr, parseSubjects } = require('../util');
const { validPath, publicEntry } = require('./sync');

function register(router, { db, svc, config, log }) {
  const library = new Library(config.libraryDir, log);
  function open(ctx) {
    const { user } = svc.authenticate(ctx);
    const app = db.get('SELECT * FROM apps WHERE id = ?', String(ctx.params.appId));
    if (!app) throw notFound('프로그램을 찾을 수 없어요.');
    if (!svc.canUseApp(user, app.id)) throw forbidden('이 프로그램을 쓸 권한이 없어요.');
    if (!['admin', 'director', 'teacher'].includes(user.role)) throw forbidden('공용 책장을 볼 수 없어요.', 'library_forbidden');
    let subjects;
    const index = library.index(app.id);
    if (user.role === 'admin') subjects = [...new Set(index.entries.map((e) => e.subject))].sort();
    else {
      const academy = user.academy_id && db.get('SELECT subjects FROM academies WHERE id = ?', user.academy_id);
      if (!academy) throw notFound('소속 학원이 없어요.', 'no_academy');
      subjects = parseSubjects(academy.subjects);
    }
    return { app, index, subjects, canRead: (e) => user.role === 'admin' || subjects.includes(e.subject) };
  }
  router.get('/api/sync/:appId/library', (ctx) => {
    const { app, index, subjects, canRead } = open(ctx);
    const since = intOr(ctx.query.get('since'), 0, 0);
    return { appId: app.id, seq: Math.max(since, index.seq), full: since === 0, subjects,
      entries: index.entries.filter((e) => e.seq > since && canRead(e)).sort((a, b) => a.seq - b.seq)
        .map((e) => ({ ...publicEntry(e), updatedAt: e.mtime, subject: e.subject })) };
  });
  router.get('/api/sync/:appId/library/file', (ctx) => {
    const { index, canRead } = open(ctx);
    const p = validPath(ctx.query.get('path'));
    const e = index.entries.find((e) => e.path === p);
    if (!e || e.deleted) throw notFound('파일이 없어요.', 'no_file');
    if (!canRead(e)) throw forbidden('계약하지 않은 과목이에요.');
    let fd;
    try { fd = fs.openSync(library.blob(e.sha256), 'r'); }
    catch { throw notFound('파일 내용이 없어요.', 'no_blob'); }
    ctx.res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': e.size,
      'x-rev': String(e.rev), 'x-sha256': e.sha256, 'cache-control': 'no-store' });
    if (ctx.req.method === 'HEAD') { fs.closeSync(fd); ctx.res.end(); }
    else fs.createReadStream(null, { fd }).on('error', () => ctx.res.destroy()).pipe(ctx.res);
  });
}

module.exports = { register };
