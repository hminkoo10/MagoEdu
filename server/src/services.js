'use strict';

// 여러 라우트가 함께 쓰는 기능: 설정, 활동 기록, 로그인 세션, 계정 도우미

const { DAY, HttpError, forbidden, notFound, randomToken, sha256Hex, jsonParse, intOr, parseSubjects } = require('./util');

const DEFAULT_SETTINGS = {
  defaultQuotaMb: 2048, // 계정마다 서버에 둘 수 있는 기본 용량
  defaultAcademyQuotaMb: 10240, // 학원마다 학원 공간에 둘 수 있는 기본 용량 (같은 학원 사람들이 함께 씀)
  ticketDays: 7, // 인터넷이 끊겨도 프로그램을 켤 수 있는 기간
  sessionDays: 60, // 이 기간 동안 쓰지 않으면 자동 로그아웃
  auditKeepDays: 365,
};

const ROLE_LABEL = { admin: '운영자', director: '원장', teacher: '선생님', student: '학생', guardian: '보호자' };

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

  function academyInfo(id) {
    if (!id) return null;
    const a = db.get('SELECT id, name, subjects FROM academies WHERE id = ?', id);
    return a ? { id: a.id, name: a.name, subjects: parseSubjects(a.subjects) } : null;
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
    if (user.role === 'guardian') {
      const a = db.get('SELECT guardian_enabled, enabled, platform FROM apps WHERE id = ?', appId);
      if (!a?.guardian_enabled || !a.enabled || a.platform !== 'web') return false;
    }
    const list = allowedApps(user);
    if (list !== null && !list.includes(appId)) return false;
    if (user.role === 'student') {
      return db.all("SELECT allowed_apps FROM users WHERE academy_id = ? AND role = 'director' AND status = 'active'", user.academy_id)
        .some((u) => allowedApps(u) === null || allowedApps(u).includes(appId));
    }
    return true;
  }

  function publicUser(u, { withUsage = false } = {}) {
    const out = {
      id: u.uid,
      username: u.username,
      name: u.name,
      role: u.role,
      roleLabel: ROLE_LABEL[u.role],
      academy: academyInfo(u.academy_id),
      status: u.status,
      suspendedReason: u.suspended_reason || null,
      mustChangePassword: !!u.must_change_password,
      allowedApps: allowedApps(u),
      quotaMb: u.quota_mb ?? null,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at || null,
    };
    if (u.role === 'student') {
      const s = db.get(`SELECT s.id, s.name, s.school, s.school_office, s.school_code, s.teacher_uid, t.name AS teacher_name FROM students s
                        LEFT JOIN users t ON t.uid = s.teacher_uid AND t.academy_id = s.academy_id
                        WHERE s.id = ? AND s.academy_id = ?`, u.student_id, u.academy_id);
      out.student = s ? { id: s.id, name: s.name, school: s.school, schoolOffice: s.school_office, schoolCode: s.school_code,
        teacherUid: s.teacher_uid, teacherName: s.teacher_name || null } : null;
      out.aiMode = u.ai_mode;
      if (s) out.name = s.name;
    }
    if (u.role === 'guardian') out.children = db.all(`SELECT s.id AS studentId, s.name, g.id AS guardianId FROM guardians g JOIN students s ON s.id = g.student_id AND s.academy_id = g.academy_id WHERE g.user_id = ? AND g.academy_id = ? AND s.deleted_at IS NULL AND s.purged_at IS NULL`, u.id, u.academy_id);
    if (withUsage && u.role !== 'guardian') {
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
    if (['student', 'guardian'].includes(target.role)) return false; // 학생 계정은 명단에 연결한 전용 경로에서만 관리
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
  /** appId: 웹 프로그램(예: 마고 과목내비) 서버가 받는 그 프로그램 전용 세션 (authenticate 에서 허용한 곳만 씀) */
  function createSession(user, device, ip, { appId = null } = {}) {
    if (user.role === 'guardian' && device?.platform !== 'web' && !(appId && device?.platform === 'web-app')) throw forbidden('보호자는 웹에서만 로그인할 수 있어요.', 'guardian_web_only');
    if (user.role === 'student') {
      if (device?.platform !== 'web' && !(appId && device?.platform === 'web-app')) {
        throw forbidden('학생 계정은 웹(mago.milky.kr)에서만 써요.', 'student_web_only');
      }
      if (appId && user.must_change_password) throw forbidden('먼저 임시 비밀번호를 바꿔야 해요.', 'password_change_required');
      assertStudentActive(user);
    }
    const token = `mgc_${randomToken(32)}`;
    const now = Date.now();
    const days = getSettings().sessionDays;
    const deviceId = String(device?.id || '').slice(0, 80) || `unknown-${randomToken(6)}`;
    db.tx(() => {
      // 같은 기기에서 다시 로그인하면 예전 세션은 정리
      db.run('DELETE FROM sessions WHERE user_id = ? AND device_id = ?', user.id, deviceId);
      db.run(
        `INSERT INTO sessions(token_hash, user_id, device_id, device_name, platform, client_version, ip, created_at, last_seen_at, expires_at, app_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        appId,
      );
      db.run('UPDATE users SET last_login_at = ? WHERE id = ?', now, user.id);
    });
    return token;
  }

  function assertStudentActive(user) {
    if (!db.get('SELECT 1 FROM students WHERE id = ? AND academy_id = ? AND deleted_at IS NULL AND purged_at IS NULL', user.student_id, user.academy_id)) {
      throw new HttpError(403, '사용할 수 없는 학생 계정이에요.', 'account_suspended');
    }
  }

  function assertStudentAccess(ctx, user, session) {
    if (user.role !== 'student') return;
    assertStudentActive(user);
    if (session.platform !== 'web' && !(session.app_id && session.platform === 'web-app')) {
      throw forbidden('학생 계정은 웹(mago.milky.kr)에서만 써요.', 'student_web_only');
    }
    const path = String(ctx.path || '').replace(/\/$/, '');
    const method = ctx.req.method === 'HEAD' ? 'GET' : ctx.req.method;
    if (/^\/api\/sync\/[^/]+\/library(?:\/file)?$/.test(path)) {
      throw forbidden('학생은 마고 공용 책장을 쓸 수 없어요.', 'library_forbidden');
    }
    const basic = (method === 'GET' && path === '/api/me')
      || (method === 'PATCH' && path === '/api/me/password')
      || (method === 'POST' && path === '/api/auth/logout');
    if (user.must_change_password && !basic) throw forbidden('먼저 임시 비밀번호를 바꿔야 해요.', 'password_change_required');
    const inquiry = (method === 'GET' && (/^\/api\/inquiries(?:\/(?:unread|[0-9]+(?:\/photos\/[A-Za-z0-9_-]+)?))?$/.test(path) || path === '/api/sync/events'))
      || (method === 'POST' && /^\/api\/inquiries(?:\/photos|\/[0-9]+\/messages)?$/.test(path));
    const allowed = basic || inquiry
      || (method === 'PATCH' && ['/api/me', '/api/me/username'].includes(path))
      || (method === 'GET' && (path === '/api/notices' || /^\/api\/me\/notes(?:\/[^/]+\/pdf)?$/.test(path)))
      || (method === 'POST' && path === '/api/sso/authorize')
      || (['GET', 'POST'].includes(method) && path.startsWith('/api/ai/relay/mago-navi/'))
      || (session.app_id && method === 'GET' && ['/api/students', '/api/academy/ai'].includes(path));
    if (!allowed) throw forbidden('학생 계정으로는 쓸 수 없는 기능이에요.', 'student_forbidden');
  }

  // 공개 API·아직 없는 경로도 학생 세션을 붙인 요청이면 같은 허용 목록을 적용한다.
  function guardStudentSession(ctx) {
    const token = /^Bearer\s+(\S+)$/i.exec(String(ctx.req.headers.authorization || ''))?.[1];
    if (!token) return;
    const student = db.get("SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND (u.role = 'guardian' OR (u.role = 'student' AND ?))", sha256Hex(token), ctx.path.startsWith('/api/') ? 1 : 0);
    if (student) authenticate({ ...ctx }, { app: true });
  }

  /** app: 웹 프로그램 전용 세션도 받을지. token: AI 중계처럼 다른 머리글로 받은 세션 토큰 */
  function authenticate(ctx, { app = false, token = null } = {}) {
    const header = String(ctx.req.headers.authorization || '');
    const m = token ? [null, token] : /^Bearer\s+(\S+)$/i.exec(header);
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
    if (user.role === 'guardian') {
      const path = String(ctx.path || '').replace(/\/$/, '');
      const method = ctx.req.method === 'HEAD' ? 'GET' : ctx.req.method;
      const read = method === 'GET' && ['/api/me', '/api/me/consents', ...(!session.app_id ? ['/api/me/guardians'] : [])].includes(path);
      const logout = method === 'POST' && path === '/api/auth/logout';
      const web = !session.app_id && ((method === 'POST' && ['/api/sso/authorize', '/api/join'].includes(path))
        || (method === 'GET' && /^\/api\/join\/[^/]+$/.test(path))
        || (method === 'PATCH' && path === '/api/me/password')
        || (method === 'POST' && /^\/api\/me\/consents\/[^/]+\/withdraw$/.test(path)));
      if (!read && !web && !logout) throw forbidden('보호자 계정으로는 쓸 수 없는 기능이에요.', 'guardian_forbidden');
      if (session.app_id && !canUseApp(user, session.app_id)) throw forbidden();
    }
    assertStudentAccess(ctx, user, session);
    if (session.app_id && !app) throw new HttpError(403, '이 로그인으로는 쓸 수 없는 기능이에요.', 'app_session');
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
    guardStudentSession,
    authenticate,
    requireRole,
    revokeSessions,
    publicSession,
    ROLE_LABEL,
  };
}

module.exports = { createServices, DEFAULT_SETTINGS, ROLE_LABEL };
