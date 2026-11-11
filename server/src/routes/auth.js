'use strict';

// 로그인, 가입 코드로 원장 가입, 내 계정(아이디·비밀번호·이름 바꾸기), 로그인 기기

const crypto = require('node:crypto');
const { readJson } = require('../http');
const { HttpError, bad, notFound, normalizeUsername, validatePassword, validateName, str, parseSubjects } = require('../util');
const { hashPassword, verifyPassword, DUMMY_HASH, RateLimiter } = require('../security');

function register(router, deps) {
  const { db, svc, joinCodes } = deps;
  const loginLimit = new RateLimiter({ max: 8, windowMs: 10 * 60 * 1000 });
  const ipLimit = new RateLimiter({ max: 40, windowMs: 10 * 60 * 1000 });

  function limited(seconds) {
    const min = Math.max(1, Math.ceil(seconds / 60));
    return new HttpError(429, `너무 여러 번 시도했어요. ${min}분 뒤에 다시 해 주세요.`, 'rate_limited', { retryAfter: seconds });
  }

  function loginResponse(ctx, user, token) {
    return {
      token,
      user: svc.publicUser(user, { withUsage: true }),
      server: { id: svc.meta('server_id'), keys: deps.trustKeys() },
    };
  }

  // ---------------- 로그인 ----------------
  router.post('/api/auth/login', async (ctx) => {
    const body = await readJson(ctx.req);
    const username = str(body.username, 64).toLowerCase();
    const password = String(body.password || '');
    if (!username || !password) throw bad('아이디와 비밀번호를 입력해 주세요.');

    const key = `${ctx.ip}|${username}`;
    const wait = Math.max(loginLimit.blocked(key), ipLimit.blocked(ctx.ip));
    if (wait) throw limited(wait);

    const user = db.get('SELECT * FROM users WHERE username = ?', username);
    const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      loginLimit.hit(key);
      ipLimit.hit(ctx.ip);
      if (user) svc.audit({ ip: ctx.ip, actorLabel: username }, 'login.failed', `${user.name} (${user.username})`, null, user.academy_id);
      throw new HttpError(401, '아이디 또는 비밀번호가 맞지 않아요.', 'invalid_credentials');
    }
    if (user.status !== 'active') {
      throw new HttpError(403, '사용이 중지된 계정이에요. 원장님이나 운영자에게 문의해 주세요.', 'account_suspended', {
        reason: user.suspended_reason || null,
      });
    }
    loginLimit.reset(key);
    const token = svc.createSession(user, body.device, ctx.ip);
    ctx.auth = { user };
    svc.audit(ctx, 'login', body.device?.name ? String(body.device.name).slice(0, 80) : '');
    return loginResponse(ctx, db.get('SELECT * FROM users WHERE id = ?', user.id), token);
  });

  router.post('/api/auth/logout', (ctx) => {
    const { session } = svc.authenticate(ctx, { app: true });
    db.run('DELETE FROM sessions WHERE id = ?', session.id);
    return { ok: true };
  });

  // ---------------- 가입 코드 ----------------
  router.get('/api/auth/codes/:code', (ctx) => {
    joinCodes.check(ctx.ip);
    const director = joinCodes.director(ctx.params.code);
    const student = joinCodes.student(ctx.params.code);
    // 형식이 아니라 실제 유효성을 확인한다. 둘 다 유효하면 원장 코드 우선.
    if (director) return { valid: true, role: director.role, academyName: director.academy_name || '' };
    if (student) return { valid: true, role: 'student', academyName: student.academy_name, studentName: student.student_name };
    const guardian = joinCodes.guardian(ctx.params.code);
    if (guardian) return { valid: true, role: 'guardian', academyName: guardian.academy_name, studentName: guardian.student_name, consentVersion: require('./guardians').CONSENT_VERSION };
    const teacher = joinCodes.teacher(ctx.params.code);
    if (teacher) return { valid: true, role: 'teacher', academyName: teacher.academy_name, teacherName: teacher.name };
    joinCodes.invalid(ctx.ip);
  });

  router.post('/api/auth/signup', async (ctx) => {
    const body = await readJson(ctx.req);
    joinCodes.check(ctx.ip);
    const code = joinCodes.director(body.code);
    if (!code) {
      const invite = joinCodes.teacher(body.code);
      if (!invite) joinCodes.invalid(ctx.ip, 400);
      const username = normalizeUsername(body.username);
      const password = validatePassword(body.password, username);
      if (db.get('SELECT 1 FROM users WHERE username = ?', username)) throw bad('이미 있는 아이디예요.', 'username_taken');
      const now = Date.now();
      const user = db.tx(() => {
        const fresh = joinCodes.teacher(body.code);
        if (!fresh || fresh.id !== invite.id) joinCodes.invalid(ctx.ip, 400);
        const id = db.run(`INSERT INTO users(uid, username, name, role, academy_id, password_hash, must_change_password,
          allowed_apps, created_by, created_at, updated_at, password_changed_at) VALUES (?, ?, ?, 'teacher', ?, ?, 0, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(), username, fresh.name, fresh.academy_id, hashPassword(password), fresh.allowed_apps, fresh.created_by, now, now, now).lastInsertRowid;
        db.run('DELETE FROM teacher_invites WHERE id = ?', fresh.id);
        return db.get('SELECT * FROM users WHERE id = ?', id);
      });
      ctx.auth = { user };
      svc.audit(ctx, 'teacher.join', user.name, null, user.academy_id);
      return loginResponse(ctx, user, svc.createSession(user, body.device, ctx.ip));
    }
    const username = normalizeUsername(body.username);
    const password = validatePassword(body.password, username);
    const name = validateName(body.name);
    const academy = str(code.academy_name || body.academyName, 60);
    if (!academy) throw bad('학원 이름을 입력해 주세요.', 'invalid_academy');
    if (db.get('SELECT 1 FROM users WHERE username = ?', username)) throw bad('이미 있는 아이디예요.', 'username_taken');

    const now = Date.now();
    const user = db.tx(() => {
      // 다른 요청이 먼저 썼을 수 있으니 한 번 더 확인
      const fresh = db.get('SELECT uses, max_uses FROM signup_codes WHERE id = ?', code.id);
      if (fresh.uses >= fresh.max_uses) joinCodes.invalid(ctx.ip, 400);
      const academyId = db.run('INSERT INTO academies(name, subjects, created_at) VALUES (?, ?, ?)', academy, JSON.stringify(parseSubjects(code.subjects)), now).lastInsertRowid;
      const id = db.run(
        `INSERT INTO users(uid, username, name, role, academy_id, password_hash, created_by, created_at, updated_at, password_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        username,
        name,
        code.role,
        academyId,
        hashPassword(password),
        code.created_by,
        now,
        now,
        now,
      ).lastInsertRowid;
      db.run('UPDATE signup_codes SET uses = uses + 1 WHERE id = ?', code.id);
      return db.get('SELECT * FROM users WHERE id = ?', id);
    });
    ctx.auth = { user };
    svc.audit(ctx, 'signup', `${name} (${username})`, { code: code.code, academy }, user.academy_id);
    const token = svc.createSession(user, body.device, ctx.ip);
    return loginResponse(ctx, db.get('SELECT * FROM users WHERE id = ?', user.id), token);
  });

  // ---------------- 내 계정 ----------------
  router.get('/api/me', (ctx) => {
    const { user } = svc.authenticate(ctx, { app: true }); // 웹 프로그램이 역할·학원을 다시 확인할 때도
    return {
      user: svc.publicUser(user, { withUsage: true }),
      settings: { ticketDays: svc.getSettings().ticketDays },
      server: { id: svc.meta('server_id'), keys: deps.trustKeys() },
    };
  });

  // 프로그램이 설정 파일에 서명하는 키 (매니페스트 dataSigning, docs/INTEGRATION.md) — 손으로 고친 설정 파일을 거부하려고.
  // 서버마다 하나라서 같은 서버의 다른 계정 백업도 불러올 수 있다. 웹 화면에는 주지 않는다 (브라우저에서 바로 보이지 않게)
  router.get('/api/me/data-key', (ctx) => {
    const { session } = svc.authenticate(ctx);
    if (!session.platform || session.platform === 'web') throw new HttpError(403, '이 기기에서는 받을 수 없어요.', 'web_session');
    db.run('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)', 'data_key', crypto.randomBytes(32).toString('base64url'));
    return { dataKey: svc.meta('data_key') };
  });

  function checkCurrentPassword(user, password) {
    if (!verifyPassword(String(password || ''), user.password_hash)) {
      throw bad('지금 비밀번호가 맞지 않아요.', 'invalid_password');
    }
  }

  router.patch('/api/me/username', async (ctx) => {
    const { user } = svc.authenticate(ctx);
    const body = await readJson(ctx.req);
    checkCurrentPassword(user, body.password);
    const username = normalizeUsername(body.username);
    if (username === user.username) throw bad('지금 쓰는 아이디예요. 다른 아이디를 넣어 주세요.', 'same_username');
    if (db.get('SELECT 1 FROM users WHERE username = ? AND id != ?', username, user.id)) {
      throw bad('이미 있는 아이디예요.', 'username_taken');
    }
    db.run('UPDATE users SET username = ?, updated_at = ? WHERE id = ?', username, Date.now(), user.id);
    svc.audit(ctx, 'me.username', `${user.username} → ${username}`);
    if (user.role === 'student') deps.events.publishAcademyInfo(user.academy_id, 'students');
    return { user: svc.publicUser(svc.userByUid(user.uid), { withUsage: true }) };
  });

  router.patch('/api/me/password', async (ctx) => {
    const { user, session } = svc.authenticate(ctx);
    const body = await readJson(ctx.req);
    checkCurrentPassword(user, body.currentPassword);
    const password = validatePassword(body.newPassword, user.username);
    if (verifyPassword(password, user.password_hash)) throw bad('지금과 다른 비밀번호로 정해 주세요.', 'same_password');
    const now = Date.now();
    db.run(
      'UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ?, updated_at = ? WHERE id = ?',
      hashPassword(password),
      now,
      now,
      user.id,
    );
    if (body.logoutOthers !== false) svc.revokeSessions(user.id, session.id);
    svc.audit(ctx, 'me.password', '');
    if (user.role === 'student') deps.events.publishAcademyInfo(user.academy_id, 'students');
    deps.onPasswordChanged?.(user);
    return { user: svc.publicUser(svc.userByUid(user.uid), { withUsage: true }) };
  });

  router.patch('/api/me/name', async (ctx) => {
    const { user } = svc.authenticate(ctx);
    const body = await readJson(ctx.req);
    const name = validateName(body.name);
    db.run('UPDATE users SET name = ?, updated_at = ? WHERE id = ?', name, Date.now(), user.id);
    return { user: svc.publicUser(svc.userByUid(user.uid), { withUsage: true }) };
  });

  // ---------------- 로그인 기기 ----------------
  router.get('/api/me/devices', (ctx) => {
    const { user, session } = svc.authenticate(ctx);
    const rows = db.all('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC', user.id);
    return { devices: rows.map((s) => svc.publicSession(s, session.id)) };
  });

  router.patch('/api/me/devices/:id', async (ctx) => {
    const { user, session } = svc.authenticate(ctx);
    // 기기 ID는 요청 본문이 아니라 인증된 세션으로 결정한다. 다른 내 기기도 바꿀 수 없다.
    if (ctx.params.id !== 'current' && ctx.params.id !== String(session.id)) throw notFound('기기를 찾을 수 없어요.');
    const body = await readJson(ctx.req);
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(body.name)) {
      throw bad('기기 이름은 제어문자 없이 1~80자로 입력해 주세요.', 'invalid_device_name');
    }
    const name = body.name.trim();
    db.run('UPDATE sessions SET device_name = ? WHERE id = ? AND user_id = ?', name, session.id, user.id);
    return { device: svc.publicSession({ ...session, device_name: name }, session.id) };
  });

  router.delete('/api/me/devices/:id', (ctx) => {
    const { user } = svc.authenticate(ctx);
    const s = db.get('SELECT * FROM sessions WHERE id = ? AND user_id = ?', Number(ctx.params.id), user.id);
    if (!s) throw notFound('기기를 찾을 수 없어요.');
    db.run('DELETE FROM sessions WHERE id = ?', s.id);
    svc.audit(ctx, 'session.revoke', s.device_name || s.device_id);
    return { ok: true };
  });

  router.post('/api/me/devices/logout-others', (ctx) => {
    const { user, session } = svc.authenticate(ctx);
    svc.revokeSessions(user.id, session.id);
    svc.audit(ctx, 'session.revoke_others', '');
    return { ok: true };
  });
}

module.exports = { register };
