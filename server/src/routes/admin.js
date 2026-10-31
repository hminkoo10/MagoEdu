'use strict';

// 공지사항, 활동 기록, 서버 설정, 서버 현황

const { readJson } = require('../http');
const { bad, forbidden, notFound, intOr, str, jsonParse, DAY } = require('../util');

function register(router, deps) {
  const { db, svc } = deps;

  // ---------------- 공지사항 ----------------
  function publicNotice(n, viewer) {
    return {
      id: n.id,
      title: n.title,
      body: n.body,
      pinned: !!n.pinned,
      academy: n.academy_id ? { id: n.academy_id, name: svc.academyName(n.academy_id) } : null,
      authorName: n.author_name || '',
      createdAt: n.created_at,
      updatedAt: n.updated_at,
      expiresAt: n.expires_at,
      editable: canEditNotice(viewer, n),
    };
  }

  function canEditNotice(user, n) {
    if (user.role === 'admin') return true;
    return user.role === 'director' && !!n.academy_id && n.academy_id === user.academy_id;
  }

  router.get('/api/notices', (ctx) => {
    const { user } = svc.authenticate(ctx);
    const now = Date.now();
    const all = ctx.query.get('all') === '1' && user.role === 'admin';
    const rows = all
      ? db.all('SELECT * FROM notices ORDER BY pinned DESC, created_at DESC LIMIT 200')
      : db.all(
          `SELECT * FROM notices
           WHERE (academy_id IS NULL OR academy_id = ?) AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY pinned DESC, created_at DESC LIMIT 100`,
          user.academy_id ?? -1,
          now,
        );
    return { notices: rows.map((n) => publicNotice(n, user)) };
  });

  function noticeFields(user, body, existing) {
    const title = str(body.title ?? existing?.title, 100);
    const text = str(body.body ?? existing?.body, 5000);
    if (!title) throw bad('제목을 입력해 주세요.');
    if (!text) throw bad('내용을 입력해 주세요.');
    let academyId = existing ? existing.academy_id : null;
    if (user.role === 'director') {
      academyId = user.academy_id;
    } else if (body.academyId !== undefined) {
      academyId = body.academyId === null ? null : Number(body.academyId);
      if (academyId !== null && !db.get('SELECT 1 FROM academies WHERE id = ?', academyId)) throw bad('학원을 찾을 수 없어요.');
    }
    let expiresAt = existing ? existing.expires_at : null;
    if (body.expiresInDays !== undefined) {
      const d = intOr(body.expiresInDays, 0, 0, 365);
      expiresAt = d ? Date.now() + d * DAY : null;
    }
    const pinned = body.pinned === undefined ? existing?.pinned || 0 : body.pinned ? 1 : 0;
    return { title, text, academyId, expiresAt, pinned };
  }

  router.post('/api/notices', async (ctx) => {
    const user = svc.requireRole(ctx, 'admin', 'director');
    if (user.role === 'director' && !user.academy_id) throw forbidden('학원에 속한 원장만 공지를 올릴 수 있어요.');
    const f = noticeFields(user, await readJson(ctx.req));
    const now = Date.now();
    const id = db.run(
      `INSERT INTO notices(author_id, author_name, academy_id, title, body, pinned, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      user.id,
      user.name,
      f.academyId,
      f.title,
      f.text,
      f.pinned,
      now,
      now,
      f.expiresAt,
    ).lastInsertRowid;
    svc.audit(ctx, 'notice.create', f.title, { academyId: f.academyId }, f.academyId);
    return { notice: publicNotice(db.get('SELECT * FROM notices WHERE id = ?', id), user) };
  });

  router.patch('/api/notices/:id', async (ctx) => {
    const user = svc.requireRole(ctx, 'admin', 'director');
    const n = db.get('SELECT * FROM notices WHERE id = ?', Number(ctx.params.id));
    if (!n) throw notFound('공지를 찾을 수 없어요.');
    if (!canEditNotice(user, n)) throw forbidden();
    const f = noticeFields(user, await readJson(ctx.req), n);
    db.run(
      'UPDATE notices SET title = ?, body = ?, academy_id = ?, pinned = ?, expires_at = ?, updated_at = ? WHERE id = ?',
      f.title,
      f.text,
      f.academyId,
      f.pinned,
      f.expiresAt,
      Date.now(),
      n.id,
    );
    svc.audit(ctx, 'notice.update', f.title, null, f.academyId);
    return { notice: publicNotice(db.get('SELECT * FROM notices WHERE id = ?', n.id), user) };
  });

  router.delete('/api/notices/:id', (ctx) => {
    const user = svc.requireRole(ctx, 'admin', 'director');
    const n = db.get('SELECT * FROM notices WHERE id = ?', Number(ctx.params.id));
    if (!n) throw notFound('공지를 찾을 수 없어요.');
    if (!canEditNotice(user, n)) throw forbidden();
    db.run('DELETE FROM notices WHERE id = ?', n.id);
    svc.audit(ctx, 'notice.delete', n.title, null, n.academy_id);
    return { ok: true };
  });

  // ---------------- 활동 기록 (운영자) ----------------
  router.get('/api/audit', (ctx) => {
    svc.requireRole(ctx, 'admin');
    const limit = intOr(ctx.query.get('limit'), 100, 1, 500);
    const before = intOr(ctx.query.get('before'), 0, 0);
    const q = str(ctx.query.get('q'), 60);
    const action = str(ctx.query.get('action'), 40);
    const where = [];
    const args = [];
    if (before) {
      where.push('id < ?');
      args.push(before);
    }
    if (q) {
      where.push('(actor LIKE ? OR target LIKE ?)');
      args.push(`%${q}%`, `%${q}%`);
    }
    if (action) {
      where.push('action LIKE ?');
      args.push(`${action}%`);
    }
    const rows = db.all(
      `SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
      ...args,
      limit,
    );
    return {
      entries: rows.map((r) => ({
        id: r.id,
        at: r.at,
        actor: r.actor || '',
        action: r.action,
        target: r.target || '',
        detail: jsonParse(r.detail, null),
        ip: r.ip || '',
        academy: r.academy_id ? svc.academyName(r.academy_id) : null,
      })),
      more: rows.length === limit,
    };
  });

  // ---------------- 서버 설정 (운영자) ----------------
  router.get('/api/admin/settings', (ctx) => {
    svc.requireRole(ctx, 'admin');
    return { settings: svc.getSettings() };
  });

  router.patch('/api/admin/settings', async (ctx) => {
    svc.requireRole(ctx, 'admin');
    const body = await readJson(ctx.req);
    const settings = svc.setSettings(body);
    svc.audit(ctx, 'settings.update', '', body);
    return { settings };
  });

  router.get('/api/admin/stats', (ctx) => {
    svc.requireRole(ctx, 'admin');
    const count = (sql, ...a) => db.get(sql, ...a).n;
    return {
      users: {
        total: count('SELECT COUNT(*) AS n FROM users'),
        admin: count("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
        director: count("SELECT COUNT(*) AS n FROM users WHERE role = 'director'"),
        teacher: count("SELECT COUNT(*) AS n FROM users WHERE role = 'teacher'"),
        suspended: count("SELECT COUNT(*) AS n FROM users WHERE status = 'suspended'"),
      },
      academies: count('SELECT COUNT(*) AS n FROM academies'),
      devices: count('SELECT COUNT(*) AS n FROM sessions'),
      storage: {
        bytes: count('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE deleted = 0 AND evicted = 0'),
        files: count('SELECT COUNT(*) AS n FROM files WHERE deleted = 0 AND evicted = 0'),
        evictedFiles: count('SELECT COUNT(*) AS n FROM files WHERE deleted = 0 AND evicted = 1'),
        diskBytes: deps.blobs.diskUsage(),
      },
      server: { version: deps.version, build: deps.build, startedAt: deps.startedAt },
    };
  });

  router.post('/api/admin/cold-storage/run', (ctx) => {
    svc.requireRole(ctx, 'admin');
    const result = deps.jobs.runColdStorage();
    svc.audit(ctx, 'storage.cold_run', '', result);
    return result;
  });
}

module.exports = { register };
