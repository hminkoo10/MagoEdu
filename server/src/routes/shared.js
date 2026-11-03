'use strict';

// 학원 공간 동기화 (같은 학원 사람들이 함께 쓰는 파일)
//   GET  /api/sync/:appId/academy?since=seq           바뀐 것 목록 (볼 수 있는 것만)
//   GET|HEAD /api/sync/:appId/academy/file?path=       내려받기
//   PUT  /api/sync/:appId/academy/file?path=&baseRev=&mtime=   올리기
//   DELETE /api/sync/:appId/academy/file?path=&baseRev=        지우기
//
// 개인 동기화(routes/sync.js)와 같은 방식이다: 파일마다 rev, 올릴 때 baseRev 가 다르면 409.
// 누가 보고 쓰는지는 sharing.js 의 경로 규칙. 권한이 없으면 403.
// 학원 공간은 계정 용량과 따로 학원마다 용량 한도가 있다 (academies.quota_mb, 없으면 서버 설정의 기본 학원 용량).
// 오래 안 쓴 데이터 정리(콜드 스토리지)는 없다.

const { HttpError, bad, forbidden, notFound, intOr } = require('../util');
const { SHA_RE } = require('../storage');
const { validPath, publicEntry } = require('./sync');
const sharing = require('../sharing');

function sharedEntry(f) {
  if (!f) return null;
  return { ...publicEntry(f), updatedBy: f.updated_by ?? null }; // 마지막으로 고친 사람의 uid
}

function register(router, deps) {
  const { db, svc, blobs, config } = deps;

  function open(ctx) {
    const { user, session } = svc.authenticate(ctx);
    const app = db.get('SELECT * FROM apps WHERE id = ?', String(ctx.params.appId));
    if (!app) throw notFound('프로그램을 찾을 수 없어요.');
    if (!svc.canUseApp(user, app.id)) throw forbidden('이 프로그램을 쓸 권한이 없어요.');
    if (!user.academy_id) throw notFound('학원에 속한 계정만 학원 공간을 쓸 수 있어요.', 'no_academy');
    return { user, session, app, aca: user.academy_id };
  }

  const current = (aca, appId, p) => db.get('SELECT * FROM shared_files WHERE academy_id = ? AND app_id = ? AND path = ?', aca, appId, p);

  function ownerOf(aca, appId, p) {
    const c = sharing.classify(p);
    if (!c || c.kind !== 'item') return null;
    const r = db.get('SELECT owner_id FROM shared_items WHERE academy_id = ? AND app_id = ? AND item = ?', aca, appId, c.item);
    return r ? r.owner_id : null;
  }

  function checkWrite(user, aca, appId, p) {
    if (!sharing.classify(p)) throw bad('학원 공간에 쓸 수 없는 경로예요.', 'invalid_path');
    if (!sharing.canWrite(user, p, ownerOf(aca, appId, p))) {
      throw forbidden('만든 사람이나 원장만 고칠 수 있어요.', 'not_owner');
    }
  }

  function conflict(entry) {
    return new HttpError(409, '다른 컴퓨터에서 먼저 바뀌었어요.', 'conflict', { entry: sharedEntry(entry) });
  }

  function checkQuota(aca, cur, newSize) {
    const quota = svc.academyQuotaBytes(aca);
    if (!quota) return;
    const used = svc.academyUsageBytes(aca) - (cur && !cur.deleted ? cur.size : 0);
    if (used + newSize > quota) {
      throw new HttpError(507, '학원 공간이 꽉 찼어요. 쓰지 않는 자료를 지우거나 운영자에게 학원 용량을 늘려 달라고 해 주세요.', 'academy_quota_exceeded', {
        usageBytes: used,
        quotaBytes: quota,
      });
    }
  }

  // ---------------- 목록 ----------------
  router.get('/api/sync/:appId/academy', (ctx) => {
    const { user, app, aca } = open(ctx);
    const since = intOr(ctx.query.get('since'), 0, 0);
    const rows = db.all('SELECT * FROM shared_files WHERE academy_id = ? AND app_id = ? AND seq > ? ORDER BY seq', aca, app.id, since);
    const seq = db.get('SELECT COALESCE(MAX(seq), 0) AS n FROM shared_files WHERE academy_id = ? AND app_id = ?', aca, app.id).n;
    return {
      appId: app.id,
      academyId: aca,
      seq: Math.max(seq, since),
      full: since === 0,
      entries: rows.filter((f) => sharing.canRead(user, f.path)).map(sharedEntry),
    };
  });

  // ---------------- 내려받기 ----------------
  router.get('/api/sync/:appId/academy/file', (ctx) => {
    const { user, app, aca } = open(ctx);
    const p = validPath(ctx.query.get('path'));
    if (!sharing.canRead(user, p)) throw forbidden('볼 수 없는 파일이에요.');
    const f = current(aca, app.id, p);
    if (!f || f.deleted) throw notFound('파일이 없어요.', 'no_file');
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
  router.put('/api/sync/:appId/academy/file', async (ctx) => {
    const { user, session, app, aca } = open(ctx);
    const p = validPath(ctx.query.get('path'));
    const baseRev = intOr(ctx.query.get('baseRev'), 0, 0);
    const mtime = intOr(ctx.query.get('mtime'), null, 0);
    const wantSha = String(ctx.req.headers['x-sha256'] || '').toLowerCase();
    if (wantSha && !SHA_RE.test(wantSha)) throw bad('파일 확인 값이 올바르지 않아요.', 'invalid_sha');
    checkWrite(user, aca, app.id, p);

    let cur = current(aca, app.id, p);
    if ((cur ? cur.rev : 0) !== baseRev) throw conflict(cur);

    let sha;
    let size;
    let tmp = null;
    if (ctx.req.headers['x-link'] === '1') {
      // 같은 내용이 학원 공간이나 내 파일에 이미 있으면 다시 보내지 않는다 (예: 공유 교재를 복사)
      if (!wantSha) throw bad('파일 확인 값이 필요해요.', 'invalid_sha');
      const same =
        db.get('SELECT size FROM shared_files WHERE academy_id = ? AND sha256 = ? AND deleted = 0 LIMIT 1', aca, wantSha) ||
        db.get('SELECT size FROM files WHERE user_id = ? AND sha256 = ? AND deleted = 0 AND evicted = 0 LIMIT 1', user.id, wantSha);
      if (!same || !blobs.has(wantSha)) throw notFound('서버에 같은 내용이 없어요.', 'no_blob');
      sha = wantSha;
      size = same.size;
      checkQuota(aca, cur, size);
    } else {
      const declared = Number(ctx.req.headers['content-length'] ?? ctx.req.headers['x-content-size']);
      if (Number.isFinite(declared)) checkQuota(aca, cur, declared);
      const got = await blobs.receive(ctx.req, config.maxFileBytes);
      tmp = got.file;
      sha = got.sha256;
      size = got.size;
      if (wantSha && wantSha !== sha) {
        await blobs.discard(tmp);
        throw bad('받은 파일이 보낸 파일과 달라요. 다시 보내 주세요.', 'checksum_mismatch');
      }
      try {
        checkQuota(aca, cur, size);
      } catch (err) {
        await blobs.discard(tmp);
        throw err;
      }
    }

    blobs.protect(sha);
    try {
      if (tmp) {
        cur = current(aca, app.id, p);
        if ((cur ? cur.rev : 0) !== baseRev) {
          await blobs.discard(tmp);
          throw conflict(cur);
        }
        await blobs.commit(tmp, sha);
      }
      const now = Date.now();
      const entry = db.tx(() => {
        // 받는 동안 다른 사람이 먼저 주인이 됐거나 바꿨는지 다시 확인
        checkWrite(user, aca, app.id, p);
        cur = current(aca, app.id, p);
        if ((cur ? cur.rev : 0) !== baseRev) throw conflict(cur);
        const seq = deps.nextSeq();
        if (cur) {
          db.run(
            `UPDATE shared_files SET rev = ?, seq = ?, sha256 = ?, size = ?, mtime = ?, deleted = 0, device_id = ?, updated_by = ?, updated_at = ?
             WHERE id = ?`,
            cur.rev + 1,
            seq,
            sha,
            size,
            mtime,
            session.device_id,
            user.uid,
            now,
            cur.id,
          );
        } else {
          db.run(
            `INSERT INTO shared_files(academy_id, app_id, path, rev, seq, sha256, size, mtime, deleted, device_id, updated_by, updated_at)
             VALUES (?, ?, ?, 1, ?, ?, ?, ?, 0, ?, ?, ?)`,
            aca,
            app.id,
            p,
            seq,
            sha,
            size,
            mtime,
            session.device_id,
            user.uid,
            now,
          );
        }
        const c = sharing.classify(p);
        if (c.kind === 'item') {
          db.run(
            'INSERT OR IGNORE INTO shared_items(academy_id, app_id, item, owner_id, created_at) VALUES (?, ?, ?, ?, ?)',
            aca,
            app.id,
            c.item,
            user.id,
            now,
          );
        }
        return current(aca, app.id, p);
      });
      deps.events.publishAcademy(aca, app.id, entry.seq, session.device_id);
      if (cur && cur.sha256 && cur.sha256 !== sha) blobs.scheduleGc();
      return { entry: sharedEntry(entry) };
    } finally {
      blobs.unprotect(sha);
    }
  });

  // ---------------- 지우기 ----------------
  router.delete('/api/sync/:appId/academy/file', (ctx) => {
    const { user, session, app, aca } = open(ctx);
    const p = validPath(ctx.query.get('path'));
    const baseRev = intOr(ctx.query.get('baseRev'), 0, 0);
    let changed = false;
    const entry = db.tx(() => {
      const cur = current(aca, app.id, p);
      if (!cur) return null;
      checkWrite(user, aca, app.id, p);
      if (cur.rev !== baseRev) throw conflict(cur);
      if (cur.deleted) return cur;
      changed = true;
      db.run(
        'UPDATE shared_files SET rev = ?, seq = ?, sha256 = NULL, size = 0, deleted = 1, device_id = ?, updated_by = ?, updated_at = ? WHERE id = ?',
        cur.rev + 1,
        deps.nextSeq(),
        session.device_id,
        user.uid,
        Date.now(),
        cur.id,
      );
      return current(aca, app.id, p);
    });
    if (changed) deps.events.publishAcademy(aca, app.id, entry.seq, session.device_id);
    blobs.scheduleGc();
    return { entry: sharedEntry(entry) };
  });
}

module.exports = { register, sharedEntry };
