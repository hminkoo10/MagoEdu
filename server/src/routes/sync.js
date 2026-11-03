'use strict';

// 데이터 동기화: 같은 계정(아이디)이면 어느 컴퓨터에서든 같은 데이터를 쓴다.
//
// 파일 단위로 저장하고, 파일마다 rev(고친 횟수)를 둔다. 올릴 때는 "내가 마지막으로 본 rev"(baseRev)를 같이
// 보내고, 그 사이에 다른 컴퓨터가 먼저 고쳤으면 409 로 알려 준다.
//
// 오래 쓰지 않은 큰 데이터(예: 오답노트 문제집)는 group 단위로 서버에서 지운다(evicted).
// 지운 뒤에도 목록에는 남겨 두어, 그 파일을 가진 컴퓨터가 "서버에서만 지워졌다"는 것을 알고
// 자기 파일은 그대로 두게 한다. 그 컴퓨터에서 다시 쓰면 다시 올라온다.

const { readJson } = require('../http');
const { HttpError, bad, forbidden, notFound, intOr } = require('../util');
const { SHA_RE } = require('../storage');

const MAX_PATH = 400;
const BAD_CHARS = /[\u0000-\u001f\\:*?"<>|]/;

function validPath(value, { allowEmpty = false } = {}) {
  const p = String(value ?? '');
  if (!p) {
    if (allowEmpty) return '';
    throw bad('파일 경로가 없어요.', 'invalid_path');
  }
  if (p.length > MAX_PATH || p.startsWith('/') || p.endsWith('/') || BAD_CHARS.test(p)) {
    throw bad('파일 경로가 올바르지 않아요.', 'invalid_path');
  }
  for (const seg of p.split('/')) {
    if (!seg || seg === '.' || seg === '..' || /[ .]$/.test(seg)) throw bad('파일 경로가 올바르지 않아요.', 'invalid_path');
  }
  return p;
}

function publicEntry(f) {
  if (!f) return null;
  return {
    path: f.path,
    rev: f.rev,
    seq: f.seq,
    sha256: f.sha256 || null,
    size: f.size,
    mtime: f.mtime || null,
    group: f.grp || '',
    deleted: !!f.deleted,
    evicted: !!f.evicted,
    deviceId: f.device_id || null,
    updatedAt: f.updated_at,
  };
}

function register(router, deps) {
  const { db, svc, blobs, config } = deps;

  function requireApp(appId, user) {
    const app = db.get('SELECT * FROM apps WHERE id = ?', String(appId));
    if (!app) throw notFound('프로그램을 찾을 수 없어요.');
    if (!svc.canUseApp(user, app.id)) throw forbidden('이 프로그램을 쓸 권한이 없어요.');
    return app;
  }

  function current(user, appId, p) {
    return db.get('SELECT * FROM files WHERE user_id = ? AND app_id = ? AND path = ?', user.id, appId, p);
  }

  function conflict(entry) {
    return new HttpError(409, '다른 컴퓨터에서 먼저 바뀌었어요.', 'conflict', { entry: publicEntry(entry) });
  }

  function checkQuota(user, cur, newSize) {
    const quota = svc.quotaBytes(user);
    if (!quota) return;
    const used = svc.usageBytes(user.id) - (cur && !cur.deleted && !cur.evicted ? cur.size : 0);
    if (used + newSize > quota) {
      throw new HttpError(507, '서버 저장 공간이 꽉 찼어요. 쓰지 않는 데이터를 지우거나 운영자에게 용량을 늘려 달라고 해 주세요.', 'quota_exceeded', {
        usageBytes: used,
        quotaBytes: quota,
      });
    }
  }

  function touchGroup(user, appId, grp, now) {
    if (!grp) return;
    db.run(
      `INSERT INTO group_activity(user_id, app_id, grp, last_used_at, evicted_at) VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(user_id, app_id, grp) DO UPDATE SET last_used_at = excluded.last_used_at, evicted_at = NULL`,
      user.id,
      appId,
      grp,
      now,
    );
  }

  // ---------------- 목록 ----------------
  router.get('/api/sync', (ctx) => {
    const { user } = svc.authenticate(ctx);
    const rows = db.all(
      `SELECT app_id,
              SUM(CASE WHEN deleted = 0 AND evicted = 0 THEN 1 ELSE 0 END) AS files,
              SUM(CASE WHEN deleted = 0 AND evicted = 0 THEN size ELSE 0 END) AS bytes,
              COUNT(DISTINCT CASE WHEN deleted = 0 AND evicted = 1 AND grp != '' THEN grp END) AS evicted_groups,
              MAX(updated_at) AS last_change
       FROM files WHERE user_id = ? GROUP BY app_id`,
      user.id,
    );
    // 학원 공간 (같은 학원 사람들이 함께 쓰는 파일, 예: 오답노트 교재) — 계정 용량과 따로 센다
    let academy = null;
    if (user.academy_id) {
      const shared = db.all(
        `SELECT app_id, COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes, MAX(updated_at) AS last_change
         FROM shared_files WHERE academy_id = ? AND deleted = 0 GROUP BY app_id`,
        user.academy_id,
      );
      academy = {
        id: user.academy_id,
        name: svc.academyName(user.academy_id),
        usageBytes: svc.academyUsageBytes(user.academy_id),
        quotaBytes: svc.academyQuotaBytes(user.academy_id),
        apps: shared.map((r) => ({ appId: r.app_id, files: r.files, bytes: r.bytes, lastChange: r.last_change })),
      };
    }
    return {
      usageBytes: svc.usageBytes(user.id),
      quotaBytes: svc.quotaBytes(user),
      apps: rows.map((r) => ({
        appId: r.app_id,
        files: r.files,
        bytes: r.bytes,
        evictedGroups: r.evicted_groups,
        lastChange: r.last_change,
      })),
      academy,
    };
  });

  // ---------------- 실시간 알림 (/api/sync/:appId 보다 먼저) ----------------
  //   ?apps=a,b 로 받을 프로그램을 고를 수 있다 (없으면 쓸 수 있는 모든 프로그램)
  router.get('/api/sync/events', (ctx) => {
    const { user, session } = svc.authenticate(ctx);
    let apps = null;
    const want = ctx.query.get('apps');
    if (want) {
      const ids = [...new Set(want.split(',').map((x) => x.trim()).filter(Boolean))];
      if (ids.length > 50) throw bad('프로그램을 너무 많이 골랐어요.', 'too_many_apps');
      for (const id of ids) requireApp(id, user);
      if (ids.length) apps = new Set(ids);
    }
    deps.events.open(ctx, { user, session, apps });
    return undefined;
  });

  router.get('/api/sync/:appId', (ctx) => {
    const { user } = svc.authenticate(ctx);
    const app = requireApp(ctx.params.appId, user);
    const since = intOr(ctx.query.get('since'), 0, 0);
    const rows = db.all('SELECT * FROM files WHERE user_id = ? AND app_id = ? AND seq > ? ORDER BY seq', user.id, app.id, since);
    const seq = db.get('SELECT COALESCE(MAX(seq), 0) AS n FROM files WHERE user_id = ? AND app_id = ?', user.id, app.id).n;
    return {
      appId: app.id,
      seq: Math.max(seq, since),
      full: since === 0,
      entries: rows.map(publicEntry),
      coldStorage: { enabled: !!app.cold_enabled, days: app.cold_days },
      usageBytes: svc.usageBytes(user.id),
      quotaBytes: svc.quotaBytes(user),
    };
  });

  // ---------------- 내려받기 ----------------
  router.get('/api/sync/:appId/file', (ctx) => {
    const { user } = svc.authenticate(ctx);
    const app = requireApp(ctx.params.appId, user);
    const p = validPath(ctx.query.get('path'));
    const f = current(user, app.id, p);
    if (!f || f.deleted) throw notFound('파일이 없어요.', 'no_file');
    if (f.evicted) throw new HttpError(410, '오래 쓰지 않아 서버에서 지운 파일이에요.', 'evicted', { entry: publicEntry(f) });
    if (!blobs.has(f.sha256)) throw notFound('서버에 파일 내용이 없어요.', 'no_blob');
    ctx.res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': f.size,
      'x-rev': String(f.rev),
      'x-sha256': f.sha256,
      'cache-control': 'no-store',
    });
    if (ctx.req.method === 'HEAD') {
      ctx.res.end();
      return undefined;
    }
    blobs.createReadStream(f.sha256).pipe(ctx.res);
    return undefined;
  });

  // ---------------- 올리기 ----------------
  router.put('/api/sync/:appId/file', async (ctx) => {
    const { user, session } = svc.authenticate(ctx);
    const app = requireApp(ctx.params.appId, user);
    const p = validPath(ctx.query.get('path'));
    const group = validPath(ctx.query.get('group'), { allowEmpty: true });
    if (group && !(p === group || p.startsWith(`${group}/`))) throw bad('묶음 경로가 파일 경로와 맞지 않아요.', 'invalid_group');
    const baseRev = intOr(ctx.query.get('baseRev'), 0, 0);
    const mtime = intOr(ctx.query.get('mtime'), null, 0);
    const wantSha = String(ctx.req.headers['x-sha256'] || '').toLowerCase();
    if (wantSha && !SHA_RE.test(wantSha)) throw bad('파일 확인 값이 올바르지 않아요.', 'invalid_sha');

    let cur = current(user, app.id, p);
    if ((cur ? cur.rev : 0) !== baseRev) throw conflict(cur);

    let sha;
    let size;
    let tmp = null;
    if (ctx.req.headers['x-link'] === '1') {
      // 같은 내용이 이미 서버에 있으면 다시 보내지 않는다
      if (!wantSha) throw bad('파일 확인 값이 필요해요.', 'invalid_sha');
      const same = db.get(
        'SELECT size FROM files WHERE user_id = ? AND sha256 = ? AND deleted = 0 AND evicted = 0 LIMIT 1',
        user.id,
        wantSha,
      );
      if (!same || !blobs.has(wantSha)) throw notFound('서버에 같은 내용이 없어요.', 'no_blob');
      sha = wantSha;
      size = same.size;
      checkQuota(user, cur, size);
    } else {
      // 스트림으로 올리면 content-length 가 없을 수 있어 x-content-size 도 본다 (미리 용량 확인용)
      const declared = Number(ctx.req.headers['content-length'] ?? ctx.req.headers['x-content-size']);
      if (Number.isFinite(declared)) checkQuota(user, cur, declared);
      const got = await blobs.receive(ctx.req, config.maxFileBytes);
      tmp = got.file;
      sha = got.sha256;
      size = got.size;
      if (wantSha && wantSha !== sha) {
        await blobs.discard(tmp);
        throw bad('받은 파일이 보낸 파일과 달라요. 다시 보내 주세요.', 'checksum_mismatch');
      }
    }

    blobs.protect(sha);
    try {
      if (tmp) {
        // 받는 동안 다른 요청이 먼저 바꿨는지 다시 확인
        cur = current(user, app.id, p);
        if ((cur ? cur.rev : 0) !== baseRev) {
          await blobs.discard(tmp);
          throw conflict(cur);
        }
        try {
          checkQuota(user, cur, size);
        } catch (err) {
          await blobs.discard(tmp);
          throw err;
        }
        await blobs.commit(tmp, sha);
      }
      const now = Date.now();
      const entry = db.tx(() => {
        cur = current(user, app.id, p);
        if ((cur ? cur.rev : 0) !== baseRev) throw conflict(cur);
        const seq = deps.nextSeq();
        if (cur) {
          db.run(
            `UPDATE files SET rev = ?, seq = ?, sha256 = ?, size = ?, mtime = ?, grp = ?, deleted = 0, evicted = 0,
                              device_id = ?, updated_at = ? WHERE id = ?`,
            cur.rev + 1,
            seq,
            sha,
            size,
            mtime,
            group,
            session.device_id,
            now,
            cur.id,
          );
        } else {
          db.run(
            `INSERT INTO files(user_id, app_id, path, grp, rev, seq, sha256, size, mtime, deleted, evicted, device_id, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 0, 0, ?, ?)`,
            user.id,
            app.id,
            p,
            group,
            seq,
            sha,
            size,
            mtime,
            session.device_id,
            now,
          );
        }
        touchGroup(user, app.id, group, now);
        return current(user, app.id, p);
      });
      deps.events.publish(user.id, app.id, entry.seq, session.device_id);
      if (cur && cur.sha256 && cur.sha256 !== sha) blobs.scheduleGc();
      return { entry: publicEntry(entry) };
    } finally {
      blobs.unprotect(sha);
    }
  });

  // ---------------- 지우기 ----------------
  router.delete('/api/sync/:appId/file', (ctx) => {
    const { user, session } = svc.authenticate(ctx);
    const app = requireApp(ctx.params.appId, user);
    const p = validPath(ctx.query.get('path'));
    const baseRev = intOr(ctx.query.get('baseRev'), 0, 0);
    let changed = false;
    const entry = db.tx(() => {
      const cur = current(user, app.id, p);
      if (!cur) return null;
      if (cur.rev !== baseRev) throw conflict(cur);
      if (cur.deleted) return cur;
      changed = true;
      db.run(
        'UPDATE files SET rev = ?, seq = ?, sha256 = NULL, size = 0, deleted = 1, evicted = 0, device_id = ?, updated_at = ? WHERE id = ?',
        cur.rev + 1,
        deps.nextSeq(),
        session.device_id,
        Date.now(),
        cur.id,
      );
      return current(user, app.id, p);
    });
    if (changed) deps.events.publish(user.id, app.id, entry.seq, session.device_id);
    blobs.scheduleGc();
    return { entry: publicEntry(entry) };
  });

  // ---------------- 사용 표시 (오래 안 쓴 데이터 정리 기준) ----------------
  router.post('/api/sync/:appId/touch', async (ctx) => {
    const { user } = svc.authenticate(ctx);
    const app = requireApp(ctx.params.appId, user);
    const body = await readJson(ctx.req);
    const groups = Array.isArray(body.groups) ? body.groups.slice(0, 500) : [];
    const now = Date.now();
    let touched = 0;
    db.tx(() => {
      for (const g of groups) {
        let grp;
        try {
          grp = validPath(g);
        } catch {
          continue;
        }
        const live = db.get(
          'SELECT 1 FROM files WHERE user_id = ? AND app_id = ? AND grp = ? AND deleted = 0 AND evicted = 0 LIMIT 1',
          user.id,
          app.id,
          grp,
        );
        if (!live) continue;
        touchGroup(user, app.id, grp, now);
        touched += 1;
      }
    });
    return { touched };
  });
}

module.exports = { register, validPath, publicEntry };
