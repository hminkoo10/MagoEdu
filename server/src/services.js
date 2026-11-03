'use strict';

// 여러 라우트가 함께 쓰는 기능: 설정, 활동 기록, 로그인 세션, 계정 도우미

const { DAY, HttpError, forbidden, notFound, randomToken, sha256Hex, jsonParse, intOr } = require('./util');

const DEFAULT_SETTINGS = {
  defaultQuotaMb: 2048, // 계정마다 서버에 둘 수 있는 기본 용량
  defaultAcademyQuotaMb: 10240, // 학원마다 학원 공간에 둘 수 있는 기본 용량 (같은 학원 사람들이 함께 씀)
  ticketDays: 7, // 인터넷이 끊겨도 프로그램을 켤 수 있는 기간
  sessionDays: 60, // 이 기간 동안 쓰지 않으면 자동 로그아웃
  auditKeepDays: 365,
};

const ROLE_LABEL = { admin: '운영자', director: '원장', teacher: '선생님' };

function createServices({ db, config, log }) {
  // ---------------- 설정 ----------------
  function getSettings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const row of db.all('SELECT key, value FROM settings')) {
      if (row.key in DEFAULT_SETTINGS) out[row.key] = jsonParse(row.value, out[row.key]);
    }
    return out;
  }

  function setSettings(patch) {
    const cur = getSettings();
    const next = { ...cur };
    if ('defaultQuotaMb' in patch) next.defaultQuotaMb = intOr(patch.defaultQuotaMb, cur.defaultQuotaMb, 0, 1024 * 1024);
    if ('defaultAcademyQuotaMb' in patch) next.defaultAcademyQuotaMb = intOr(patch.defaultAcademyQuotaMb, cur.defaultAcademyQuotaMb, 0, 1024 * 1024);
    if ('ticketDays' in patch) next.ticketDays = intOr(patch.ticketDays, cur.ticketDays, 1, 90);
    if ('sessionDays' in patch) next.sessionDays = intOr(patch.sessionDays, cur.sessionDays, 1, 365);
    if ('auditKeepDays' in patch) next.auditKeepDays = intOr(patch.auditKeepDays, cur.auditKeepDays, 30, 3650);
    db.tx(() => {
      for (const [k, v] of Object.entries(next)) {
        db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
      }
    });
    return next;
  }

  // ---------------- 메타 ----------------
  function meta(key, fallback = null) {
    const row = db.get('SELECT value FROM meta WHERE key = ?', key);
    return row ? row.value : fallback;
  }
  function setMeta(key, value) {
    db.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  }

  // ---------------- 활동 기록 ----------------
  function audit(ctx, action, target = '', detail = null, academyId = null) {
    const actor = ctx?.auth?.user || null;
    db.run(
      'INSERT INTO audit(at, actor_id, actor, action, target, detail, ip, academy_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      Date.now(),
      actor ? actor.id : null,
      actor ? `${actor.name} (${actor.username})` : ctx?.actorLabel || null,
      action,
      target || '',
      detail ? JSON.stringify(detail) : null,
      ctx?.ip || null,
      academyId ?? (actor ? actor.academy_id : null),
    );
  }

  // ---------------- 계정 ----------------
  function academyName(id) {
    if (!id) return null;
    return db.get('SELECT name FROM academies WHERE id = ?', id)?.name || null;
  }

  function usageBytes(userId) {
    return db.get('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE user_id = ? AND deleted = 0 AND evicted = 0', userId).n;
  }

  function quotaBytes(user) {
    const mb = user.quota_mb ?? getSettings().defaultQuotaMb;
    return mb > 0 ? mb * 1024 * 1024 : 0; // 0 = 제한 없음
  }

  // 학원 공간: 같은 학원 사람들이 함께 쓰는 파일 (routes/shared.js). 계정 용량과 따로 센다
  function academyUsageBytes(academyId) {
    return db.get('SELECT COALESCE(SUM(size), 0) AS n FROM shared_files WHERE academy_id = ? AND deleted = 0', academyId).n;
  }

  function academyQuotaBytes(academyId) {
    const a = db.get('SELECT quota_mb FROM academies WHERE id = ?', academyId);
    const mb = a?.quota_mb ?? getSettings().defaultAcademyQuotaMb;
    return mb > 0 ? mb * 1024 * 1024 : 0; // 0 = 제한 없음
  }

  function allowedApps(user) {
    return jsonParse(user.allowed_apps, null); // null = 모든 프로그램
  }

  function canUseApp(user, appId) {
    const list = allowedApps(user);
    return list === null || list.includes(appId);
  }

  function publicUser(u, { withUsage = false } = {}) {
    const out = {
      id: u.uid,
      username: u.username,
      name: u.name,
      role: u.role,
      roleLabel: ROLE_LABEL[u.role],
      academy: u.academy_id ? { id: u.academy_id, name: academyName(u.academy_id) } : null,
      status: u.status,
      suspendedReason: u.suspended_reason || null,
      mustChangePassword: !!u.must_change_password,
      allowedApps: allowedApps(u),
      quotaMb: u.quota_mb ?? null,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at || null,
    };
    if (withUsage) {
      out.usageBytes = usageBytes(u.id);
      out.quotaBytes = quotaBytes(u);
      if (u.academy_id) {
        out.academyUsageBytes = academyUsageBytes(u.academy_id);
        out.academyQuotaBytes = academyQuotaBytes(u.academy_id);
      }
    }
    return out;
  }

  function userByUid(uid) {
    const u = db.get('SELECT * FROM users WHERE uid = ?', String(uid));
    if (!u) throw notFound('계정을 찾을 수 없어요.');
    return u;
  }

  /** actor 가 target 계정을 관리(수정·삭제·초기화)할 수 있는지 */
  function canManage(actor, target) {
    if (!actor || !target || actor.id === target.id) return false;
    if (actor.role === 'admin') return true;
    if (actor.role === 'director') {
      return target.role === 'teacher' && !!actor.academy_id && target.academy_id === actor.academy_id;
    }
    return false;
  }

  function assertManage(actor, target) {
    if (!canManage(actor, target)) throw forbidden('이 계정을 관리할 권한이 없어요.');
  }

  function activeAdminCount() {
    return db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").n;
  }

  // ---------------- 세션 ----------------
  function createSession(user, device, ip) {
    const token = `mgc_${randomToken(32)}`;
    const now = Date.now();
    const days = getSettings().sessionDays;
    const deviceId = String(device?.id || '').slice(0, 80) || `unknown-${randomToken(6)}`;
    db.tx(() => {
      // 같은 기기에서 다시 로그인하면 예전 세션은 정리
      db.run('DELETE FROM sessions WHERE user_id = ? AND device_id = ?', user.id, deviceId);
      db.run(
        `INSERT INTO sessions(token_hash, user_id, device_id, device_name, platform, client_version, ip, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sha256Hex(token),
        user.id,
        deviceId,
        String(device?.name || '').slice(0, 80) || null,
        String(device?.platform || '').slice(0, 40) || null,
        String(device?.version || '').slice(0, 40) || null,
        ip || null,
        now,
        now,
        now + days * DAY,
      );
      db.run('UPDATE users SET last_login_at = ? WHERE id = ?', now, user.id);
    });
    return token;
  }

  function authenticate(ctx) {
    const header = String(ctx.req.headers.authorization || '');
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m) throw new HttpError(401, '로그인이 필요해요.', 'auth_required');
    const session = db.get('SELECT * FROM sessions WHERE token_hash = ?', sha256Hex(m[1]));
    const now = Date.now();
    if (!session || session.expires_at < now) {
      if (session) db.run('DELETE FROM sessions WHERE id = ?', session.id);
      throw new HttpError(401, '로그인이 끝났어요. 다시 로그인해 주세요.', 'session_invalid');
    }
    const user = db.get('SELECT * FROM users WHERE id = ?', session.user_id);
    if (!user) throw new HttpError(401, '계정이 삭제되었어요.', 'session_invalid');
    if (user.status !== 'active') {
      // 세션은 이때 지운다 (사용 중지할 때 바로 지우면 그 기기는 왜 로그아웃됐는지 알 수 없음)
      db.run('DELETE FROM sessions WHERE id = ?', session.id);
      throw new HttpError(401, '사용이 중지된 계정이에요. 원장님이나 운영자에게 문의해 주세요.', 'account_suspended');
    }
    // 마지막 사용 시각은 1분에 한 번만 기록 (쓸 때마다 만료 기간도 늘어남)
    if (now - session.last_seen_at > 60 * 1000) {
      const days = getSettings().sessionDays;
      db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ?, ip = ? WHERE id = ?', now, now + days * DAY, ctx.ip, session.id);
    }
    ctx.auth = { user, session };
    return ctx.auth;
  }

  function requireRole(ctx, ...roles) {
    const { user } = ctx.auth || authenticate(ctx);
    if (!roles.includes(user.role)) throw forbidden();
    return user;
  }

  function revokeSessions(userId, exceptSessionId = null) {
    if (exceptSessionId) db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, exceptSessionId);
    else db.run('DELETE FROM sessions WHERE user_id = ?', userId);
  }

  function publicSession(s, currentId) {
    return {
      id: s.id,
      deviceId: s.device_id,
      deviceName: s.device_name || '이름 없는 컴퓨터',
      platform: s.platform || '',
      clientVersion: s.client_version || '',
      ip: s.ip || '',
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      current: s.id === currentId,
    };
  }

  return {
    config,
    log,
    getSettings,
    setSettings,
    meta,
    setMeta,
    audit,
    academyName,
    usageBytes,
    quotaBytes,
    academyUsageBytes,
    academyQuotaBytes,
    allowedApps,
    canUseApp,
    publicUser,
    userByUid,
    canManage,
    assertManage,
    activeAdminCount,
    createSession,
    authenticate,
    requireRole,
    revokeSessions,
    publicSession,
    ROLE_LABEL,
  };
}

module.exports = { createServices, DEFAULT_SETTINGS, ROLE_LABEL };
