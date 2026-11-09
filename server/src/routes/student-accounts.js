'use strict';

// 명단에 연결한 학생 계정: 직접·일괄 발급, 일회용 초대, 학생 본인 아이디 변경

const crypto = require('node:crypto');
const { readJson } = require('../http');
const { DAY, bad, notFound, intOr, normalizeUsername, validatePassword, randomPassword, randomToken, sha256Hex } = require('../util');
const { hashPassword } = require('../security');

function register(router, deps) {
  const { db, svc, events, joinCodes } = deps;

  function who(ctx, codeOnly = false) {
    const user = svc.requireRole(ctx, ...(codeOnly ? ['admin', 'director'] : ['admin', 'director', 'teacher']));
    const aca = user.role === 'admin' ? intOr(ctx.query.get('academy'), null, 1) : user.academy_id;
    if (!aca) throw bad('학원을 골라야 해요.', 'academy_required');
    const academy = db.get('SELECT id, name, code FROM academies WHERE id = ?', aca);
    if (!academy) throw notFound('학원을 찾을 수 없어요.');
    return { user, academy };
  }

  function student(aca, sid) {
    const s = db.get('SELECT * FROM students WHERE id = ? AND academy_id = ? AND purged_at IS NULL', String(sid), aca);
    if (!s) throw notFound('학생을 찾을 수 없어요.', 'no_student');
    return s;
  }

  function active(s) {
    if (s.deleted_at) throw bad('지운 학생은 먼저 되살려야 해요.', 'student_deleted');
  }

  function account(s) {
    return db.get("SELECT * FROM users WHERE student_id = ? AND academy_id = ? AND role = 'student'", s.id, s.academy_id);
  }

  function available(username, id = -1) {
    if (db.get('SELECT 1 FROM users WHERE username = ? AND id != ?', username, id)) throw bad('이미 있는 아이디예요.', 'username_taken');
  }

  function changed(ctx, action, s, detail = null) {
    svc.audit(ctx, action, s.name, { studentId: s.id, ...detail }, s.academy_id);
    events.publishAcademyInfo(s.academy_id, 'students');
  }

  function create(s, username, password, creator, temporary = false) {
    active(s);
    if (account(s)) throw bad('이미 학생 계정이 있어요.', 'account_exists');
    available(username);
    const now = Date.now();
    const id = db.run(
      `INSERT INTO users(uid, username, name, role, academy_id, student_id, password_hash, must_change_password,
                         ai_mode, created_by, created_at, updated_at, password_changed_at)
       VALUES (?, ?, ?, 'student', ?, ?, ?, ?, 'academy', ?, ?, ?, ?)`,
      crypto.randomUUID(), username, s.name, s.academy_id, s.id, hashPassword(password), temporary ? 1 : 0,
      creator, now, now, now,
    ).lastInsertRowid;
    return db.get('SELECT * FROM users WHERE id = ?', id);
  }

  function publicAccount(u) {
    return { username: u.username, status: u.status === 'active' ? 'active' : 'disabled', mustChangePassword: !!u.must_change_password,
      aiMode: u.ai_mode, lastLoginAt: u.last_login_at || null };
  }

  router.get('/api/academy', (ctx) => ({ academy: who(ctx).academy }));

  router.patch('/api/academy', async (ctx) => {
    const { academy } = who(ctx, true);
    const body = await readJson(ctx.req);
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!/^[a-z0-9]{2,8}$/.test(code)) throw bad('학원 코드는 영문 소문자·숫자 2~8자로 정해야 해요.', 'invalid_academy_code');
    if (db.get('SELECT 1 FROM academies WHERE code = ? AND id != ?', code, academy.id)) throw bad('이미 쓰는 학원 코드예요.', 'academy_code_taken');
    db.run('UPDATE academies SET code = ? WHERE id = ?', code, academy.id);
    svc.audit(ctx, 'academy.code', academy.name, { code }, academy.id);
    events.publishAcademyInfo(academy.id, 'students');
    return { academy: { ...academy, code } };
  });

  router.post('/api/students/:sid/account', async (ctx) => {
    const { user, academy } = who(ctx);
    const body = await readJson(ctx.req);
    const s = student(academy.id, ctx.params.sid);
    const username = normalizeUsername(body.username);
    const password = validatePassword(body.password, username);
    const u = db.tx(() => {
      const out = create(s, username, password, user.id);
      db.run('DELETE FROM student_invites WHERE student_id = ?', s.id);
      return out;
    });
    changed(ctx, 'student.account.create', s, { username });
    return { account: publicAccount(u) };
  });

  router.post('/api/students/accounts/bulk', async (ctx) => {
    const { user, academy } = who(ctx);
    const body = await readJson(ctx.req);
    if (!academy.code) throw bad('일괄 생성 전에 학원 코드를 정해야 해요.', 'academy_code_required');
    if (!Array.isArray(body.studentIds) || !body.studentIds.length || body.studentIds.some((id) => typeof id !== 'string' || !id)) {
      throw bad('계정을 만들 학생을 골라야 해요.', 'invalid_students');
    }
    const created = [];
    const skipped = [];
    const ym = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(2, 7).replace('-', '');
    const prefix = `${academy.code}${ym}`;
    const key = `student_number:${academy.id}:${ym}`;
    db.tx(() => {
      let number = Number(svc.meta(key, '0'));
      for (const sid of new Set(body.studentIds)) {
        const s = db.get('SELECT * FROM students WHERE id = ? AND academy_id = ?', sid, academy.id);
        const reason = !s || s.purged_at ? 'no_student' : s.deleted_at ? 'student_deleted' : account(s) ? 'account_exists' : null;
        if (reason) {
          skipped.push({ studentId: sid, name: !s || s.purged_at ? '' : s.name, reason });
          continue;
        }
        let username;
        do {
          number += 1;
          username = `${prefix}${String(number).padStart(3, '0')}`;
        } while (number <= 999 && db.get('SELECT 1 FROM users WHERE username = ?', username));
        if (number > 999) {
          skipped.push({ studentId: sid, name: s.name, reason: 'username_exhausted' });
          continue;
        }
        const password = randomPassword();
        create(s, username, password, user.id, true);
        db.run('DELETE FROM student_invites WHERE student_id = ?', sid);
        svc.audit(ctx, 'student.account.create', s.name, { studentId: sid, username, temporary: true }, academy.id);
        created.push({ studentId: sid, name: s.name, username, password });
      }
      svc.setMeta(key, Math.min(number, 999));
    });
    if (created.length) events.publishAcademyInfo(academy.id, 'students');
    return { created, skipped };
  });

  router.post('/api/students/:sid/invite', (ctx) => {
    const { user, academy } = who(ctx);
    const s = student(academy.id, ctx.params.sid);
    active(s);
    if (account(s)) throw bad('이미 학생 계정이 있어요.', 'account_exists');
    const code = randomToken(24);
    const now = Date.now();
    const expiresAt = now + 7 * DAY;
    db.tx(() => {
      db.run('DELETE FROM student_invites WHERE student_id = ?', s.id);
      db.run('INSERT INTO student_invites(code_hash, academy_id, student_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        sha256Hex(code), academy.id, s.id, user.id, now, expiresAt);
    });
    changed(ctx, 'student.invite.create', s);
    return { code, expiresAt };
  });

  router.delete('/api/students/:sid/invite', (ctx) => {
    const { academy } = who(ctx);
    const s = student(academy.id, ctx.params.sid);
    db.run('DELETE FROM student_invites WHERE student_id = ?', s.id);
    changed(ctx, 'student.invite.delete', s);
    return { ok: true };
  });

  router.patch('/api/students/:sid/account', async (ctx) => {
    const { academy } = who(ctx);
    const body = await readJson(ctx.req);
    const s = student(academy.id, ctx.params.sid);
    const u = account(s);
    if (!u) throw notFound('학생 계정이 없어요.', 'no_account');
    const username = body.username === undefined ? u.username : normalizeUsername(body.username);
    available(username, u.id);
    if (body.status !== undefined && !['active', 'disabled'].includes(body.status)) throw bad('계정 상태가 올바르지 않아요.', 'invalid_status');
    if (body.status === 'active') active(s);
    if (body.aiMode !== undefined && !['academy', 'teacher'].includes(body.aiMode)) throw bad('AI 설정이 올바르지 않아요.', 'invalid_ai_mode');
    if (body.resetPassword !== undefined && typeof body.resetPassword !== 'boolean') throw bad('비밀번호 초기화 설정이 올바르지 않아요.');
    const password = body.resetPassword === true ? randomPassword() : null;
    const now = Date.now();
    db.tx(() => {
      db.run('UPDATE users SET username = ?, status = ?, ai_mode = ?, updated_at = ? WHERE id = ?',
        username, body.status === undefined ? u.status : body.status === 'active' ? 'active' : 'suspended', body.aiMode ?? u.ai_mode, now, u.id);
      if (password) db.run('UPDATE users SET password_hash = ?, must_change_password = 1, password_changed_at = ? WHERE id = ?', hashPassword(password), now, u.id);
      if (password || body.status === 'disabled') svc.revokeSessions(u.id);
    });
    changed(ctx, password ? 'student.account.password_reset' : 'student.account.update', s,
      { username, status: body.status, aiMode: body.aiMode });
    return password ? { password } : { account: publicAccount(account(s)) };
  });

  router.delete('/api/students/:sid/account', (ctx) => {
    const { academy } = who(ctx);
    const s = student(academy.id, ctx.params.sid);
    db.tx(() => {
      db.run("DELETE FROM users WHERE student_id = ? AND role = 'student'", s.id);
      db.run('DELETE FROM student_invites WHERE student_id = ?', s.id);
    });
    changed(ctx, 'student.account.delete', s);
    return { ok: true };
  });

  function invite(ctx, code) {
    joinCodes.check(ctx.ip);
    const i = joinCodes.student(code);
    if (!i) joinCodes.invalid(ctx.ip);
    return i;
  }

  router.get('/api/join/:code', (ctx) => {
    joinCodes.check(ctx.ip);
    const g = joinCodes.guardian(ctx.params.code);
    if (g) return { role: 'guardian', academyName: g.academy_name, studentName: g.student_name, consentVersion: require('./guardians').CONSENT_VERSION };
    const i = invite(ctx, ctx.params.code);
    return { academyName: i.academy_name, studentName: i.student_name };
  });

  router.post('/api/join', async (ctx) => {
    const body = await readJson(ctx.req);
    const guardianResult = await deps.guardianJoin(ctx, body);
    if (guardianResult) return guardianResult;
    const i = invite(ctx, body.code);
    const username = normalizeUsername(body.username);
    const password = validatePassword(body.password, username);
    const s = student(i.academy_id, i.student_id);
    const { user, token } = db.tx(() => {
      invite(ctx, body.code);
      const user = create(s, username, password, i.created_by);
      db.run('UPDATE student_invites SET used_at = ? WHERE id = ?', Date.now(), i.id);
      const token = svc.createSession(user, { platform: 'web', name: '학생 웹' }, ctx.ip);
      return { user, token };
    });
    ctx.auth = { user };
    changed(ctx, 'student.join', s, { username });
    return { token, user: svc.publicUser(svc.userByUid(user.uid), { withUsage: true }),
      server: { id: svc.meta('server_id'), keys: deps.trustKeys() } };
  });

  router.patch('/api/me', async (ctx) => {
    const user = svc.requireRole(ctx, 'student');
    const body = await readJson(ctx.req);
    if (body.username !== undefined) {
      const username = normalizeUsername(body.username);
      available(username, user.id);
      db.run('UPDATE users SET username = ?, updated_at = ? WHERE id = ?', username, Date.now(), user.id);
      changed(ctx, 'me.username', student(user.academy_id, user.student_id), { username });
    }
    return { user: svc.publicUser(svc.userByUid(user.uid), { withUsage: true }) };
  });
}

module.exports = { register };
