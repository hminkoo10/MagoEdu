'use strict';

// 주기 작업
//  - 오래 쓰지 않은 큰 데이터 정리: 프로그램마다 정한 기간(예: 오답노트 30일) 동안 쓰지 않은 묶음(group)은
//    서버에서만 지운다. 그 데이터를 가진 컴퓨터에는 그대로 남고, 다시 쓰면 다시 올라온다.
//  - 지운 파일 기록(180일 지난 것), 만료된 로그인, 오래된 활동 기록 정리
//  - 지운 지 정한 날짜(기본 30일)가 지난 학생 완전히 지우기, 예전 오답노트 노트를 학생별 폴더로 옮기기(매시간)

const { DAY } = require('./util');

const TOMBSTONE_KEEP_DAYS = 180;

function createJobs({ db, svc, blobs, catalog, log, nextSeq, events = null, students = null, inquiries = null }) {
  let timer = null;
  let hourly = null;

  function runColdStorage(now = Date.now()) {
    let groups = 0;
    let files = 0;
    let bytes = 0;
    for (const app of catalog.list({ includeDisabled: true })) {
      if (!app.coldStorage.enabled) continue;
      const cutoff = now - app.coldStorage.days * DAY;
      const candidates = db.all(
        `SELECT f.user_id, f.grp, MAX(f.updated_at) AS last_change, COUNT(*) AS n, SUM(f.size) AS bytes,
                ga.last_used_at AS last_used
         FROM files f
         LEFT JOIN group_activity ga ON ga.user_id = f.user_id AND ga.app_id = f.app_id AND ga.grp = f.grp
         WHERE f.app_id = ? AND f.grp != '' AND f.deleted = 0 AND f.evicted = 0
         GROUP BY f.user_id, f.grp`,
        app.id,
      );
      for (const c of candidates) {
        const last = Math.max(c.last_change || 0, c.last_used || 0);
        if (last >= cutoff) continue;
        const seq = db.tx(() => {
          const n = nextSeq();
          db.run(
            'UPDATE files SET evicted = 1, seq = ? WHERE user_id = ? AND app_id = ? AND grp = ? AND deleted = 0 AND evicted = 0',
            n,
            c.user_id,
            app.id,
            c.grp,
          );
          db.run(
            `INSERT INTO group_activity(user_id, app_id, grp, last_used_at, evicted_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(user_id, app_id, grp) DO UPDATE SET evicted_at = excluded.evicted_at`,
            c.user_id,
            app.id,
            c.grp,
            last,
            now,
          );
          return n;
        });
        events?.publish(c.user_id, app.id, seq, null); // 서버가 정리함 (기기 없음)
        groups += 1;
        files += c.n;
        bytes += c.bytes || 0;
      }
    }
    if (groups) {
      log.info(`[보관 기간] 오래 쓰지 않은 데이터 ${groups}묶음(${files}개 파일, ${(bytes / 1024 / 1024).toFixed(1)}MB)을 서버에서 정리했어요.`);
      svc.audit({ actorLabel: '서버' }, 'storage.cold_evict', '', { groups, files, bytes });
      blobs.gc();
    }
    return { groups, files, bytes };
  }

  function runCleanup(now = Date.now()) {
    const tomb =
      db.run('DELETE FROM files WHERE deleted = 1 AND updated_at < ?', now - TOMBSTONE_KEEP_DAYS * DAY).changes +
      db.run('DELETE FROM shared_files WHERE deleted = 1 AND updated_at < ?', now - TOMBSTONE_KEEP_DAYS * DAY).changes;
    const sess = db.run('DELETE FROM sessions WHERE expires_at < ?', now).changes;
    const keep = svc.getSettings().auditKeepDays;
    const aud = db.run('DELETE FROM audit WHERE at < ?', now - keep * DAY).changes;
    blobs.gc();
    inquiries?.cleanup(now);
    return { tombstones: tomb, sessions: sess, audit: aud };
  }

  function runAll() {
    try {
      runColdStorage();
    } catch (err) {
      log.warn('[보관 기간] 정리 실패', err.message);
    }
    try {
      students?.purgeExpired();
    } catch (err) {
      log.warn('[학생 명단] 완전 삭제 실패', err.message);
    }
    try {
      runCleanup();
    } catch (err) {
      log.warn('[정리] 실패', err.message);
    }
    runMoveNotes();
  }

  function runMoveNotes() {
    try {
      students?.moveLegacyNotes();
    } catch (err) {
      log.warn('[오답노트] 노트 옮기기 실패', err.message);
    }
  }

  function start() {
    const first = setTimeout(runAll, 30 * 1000);
    first.unref?.();
    timer = setInterval(runAll, 6 * 60 * 60 * 1000);
    timer.unref?.();
    hourly = setInterval(runMoveNotes, 60 * 60 * 1000);
    hourly.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (hourly) clearInterval(hourly);
    timer = null;
    hourly = null;
  }

  return { runAll, runColdStorage, runCleanup, start, stop };
}

module.exports = { createJobs };
