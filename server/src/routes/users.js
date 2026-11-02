'use strict';

// 계정 관리: 운영자는 모든 계정, 원장은 자기 학원 선생님 계정
// 학원 관리, 원장 가입 코드(운영자)

const crypto = require('node:crypto');
const { readJson } = require('../http');
const {
  bad,
  forbidden,
  notFound,
  normalizeUsername,
  validatePassword,
  validateName,
  randomPassword,
  randomCode,
  intOr,
  str,
  DAY,
} = require('../util');
const { hashPassword } = require('../security');

function register(router, deps) {
  const { db, svc } = deps;

  function label(u) {
    return `${u.name} (${u.username})`;
  }

  function parseAllowedApps(value) {
    if (value === null) return null;
    if (!Array.isArray(value)) throw bad('프로그램 목록 형식이 올바르지 않아요.');
    const known = new Set(db.all('SELECT id FROM apps').map((r) => r.id));
    return [...new Set(value.map(String))].filter((id) => known.has(id));
  }

  /** 원장은 자기가 쓸 수 있는 프로그램만 선생님에게 줄 수 있다 */
  function checkGrantable(actor, list) {
    if (actor.role === 'admin') return;
    const mine = svc.allowedApps(actor);
    if (list === null) {
      if (mine !== null) throw forbidden('원장님이 쓸 수 있는 프로그램만 줄 수 있어요.');
      return;
    }
    if (mine !== null && list.some((id) => !mine.includes(id))) {
      throw forbidden('원장님이 쓸 수 있는 프로그램만 줄 수 있어요.');
    }
  }

  // ---------------- 계정 목록 ----------------
  router.get('/api/users', (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const q = str(ctx.query.get('q'), 40);
    const role = str(ctx.query.get('role'), 20);
    const academy = ctx.query.get('academy');
    const where = [];
    const args = [];
    if (actor.role === 'director') {
      where.push('academy_id = ?');
      args.push(actor.academy_id ?? -1);
    } else if (academy) {
      where.push('academy_id = ?');
      args.push(Number(academy));
    }
    if (role) {
      where.push('role = ?');
      args.push(role);
    }
    if (q) {
      where.push('(username LIKE ? OR name LIKE ?)');
      args.push(`%${q}%`, `%${q}%`);
    }
    const rows = db.all(
      `SELECT * FROM users ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'director' THEN 1 ELSE 2 END, name COLLATE NOCASE`,
      ...args,
    );
    return {
      users: rows.map((u) => ({
        ...svc.publicUser(u, { withUsage: true }),
        manageable: svc.canManage(actor, u),
        devices: db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', u.id).n,
      })),
    };
  });

  // ---------------- 계정 만들기 ----------------
  router.post('/api/users', async (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const body = await readJson(ctx.req);
    const role = actor.role === 'director' ? 'teacher' : str(body.role, 20) || 'teacher';
    if (!['admin', 'director', 'teacher'].includes(role)) throw bad('계정 종류가 올바르지 않아요.');
    const username = normalizeUsername(body.username);
    const name = validateName(body.name);
    const generated = !body.password;
    const password = generated ? randomPassword() : validatePassword(body.password, username);
    if (db.get('SELECT 1 FROM users WHERE username = ?', username)) throw bad('이미 있는 아이디예요.', 'username_taken');

    const allowed = body.allowedApps === undefined ? null : parseAllowedApps(body.allowedApps);
    checkGrantable(actor, allowed);
    const quota = actor.role === 'admin' && body.quotaMb !== undefined && body.quotaMb !== null ? intOr(body.quotaMb, null, 0) : null;
    const now = Date.now();

    const user = db.tx(() => {
      let academyId = null;
      if (actor.role === 'director') {
        academyId = actor.academy_id;
      } else if (role !== 'admin') {
        if (body.academyId) {
          const a = db.get('SELECT id FROM academies WHERE id = ?', Number(body.academyId));
          if (!a) throw bad('학원을 찾을 수 없어요.');
          academyId = a.id;
        } else {
          const academyName = str(body.academyName, 60);
          if (!academyName) throw bad('학원을 고르거나 새 학원 이름을 입력해 주세요.', 'invalid_academy');
          academyId = db.run('INSERT INTO academies(name, created_at) VALUES (?, ?)', academyName, now).lastInsertRowid;
        }
      }
      const id = db.run(
        `INSERT INTO users(uid, username, name, role, academy_id, password_hash, must_change_password, allowed_apps, quota_mb,
                           created_by, created_at, updated_at, password_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        username,
        name,
        role,
        academyId,
        hashPassword(password),
        body.mustChangePassword === false ? 0 : 1,
        allowed === null ? null : JSON.stringify(allowed),
        quota,
        actor.id,
        now,
        now,
        now,
      ).lastInsertRowid;
      return db.get('SELECT * FROM users WHERE id = ?', id);
    });
    svc.audit(ctx, 'user.create', label(user), { role }, user.academy_id);
    return { user: svc.publicUser(user, { withUsage: true }), password: generated ? password : undefined };
  });

  // ---------------- 계정 고치기 ----------------
  router.patch('/api/users/:id', async (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const target = svc.userByUid(ctx.params.id);
    svc.assertManage(actor, target);
    const body = await readJson(ctx.req);
    const sets = [];
    const args = [];
    const changes = {};
    if (body.name !== undefined) {
      sets.push('name = ?');
      args.push(validateName(body.name));
      changes.name = true;
    }
    if (body.username !== undefined) {
      const username = normalizeUsername(body.username);
      if (db.get('SELECT 1 FROM users WHERE username = ? AND id != ?', username, target.id)) {
        throw bad('이미 있는 아이디예요.', 'username_taken');
      }
      sets.push('username = ?');
      args.push(username);
      changes.username = `${target.username} → ${username}`;
    }
    if (body.allowedApps !== undefined) {
      const list = parseAllowedApps(body.allowedApps);
      checkGrantable(actor, list);
      sets.push('allowed_apps = ?');
      args.push(list === null ? null : JSON.stringify(list));
      changes.allowedApps = list;
    }
    if (body.quotaMb !== undefined) {
      if (actor.role !== 'admin') throw forbidden('저장 용량은 운영자만 바꿀 수 있어요.');
      const q = body.quotaMb === null ? null : intOr(body.quotaMb, null, 0);
      sets.push('quota_mb = ?');
      args.push(q);
      changes.quotaMb = q;
    }
    if (body.academyId !== undefined) {
      if (actor.role !== 'admin') throw forbidden();
      if (target.role === 'admin') throw bad('운영자 계정은 학원에 넣을 수 없어요.');
      const a = db.get('SELECT id FROM academies WHERE id = ?', Number(body.academyId));
      if (!a) throw bad('학원을 찾을 수 없어요.');
      sets.push('academy_id = ?');
      args.push(a.id);
      changes.academyId = a.id;
    }
    if (body.role !== undefined && body.role !== target.role) {
      if (actor.role !== 'admin') throw forbidden();
      if (!['director', 'teacher'].includes(body.role) || target.role === 'admin') {
        throw bad('원장과 선생님 사이에서만 바꿀 수 있어요.');
      }
      sets.push('role = ?');
      args.push(body.role);
      changes.role = body.role;
    }
    if (!sets.length) return { user: svc.publicUser(target, { withUsage: true }) };
    sets.push('updated_at = ?');
    args.push(Date.now());
    db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...args, target.id);
    const fresh = svc.userByUid(target.uid);
    svc.audit(ctx, 'user.update', label(fresh), changes, fresh.academy_id);
    return { user: svc.publicUser(fresh, { withUsage: true }) };
  });

  // ---------------- 비밀번호 초기화 ----------------
  router.post('/api/users/:id/password', async (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const target = svc.userByUid(ctx.params.id);
    svc.assertManage(actor, target);
    const body = await readJson(ctx.req);
    const generated = !body.password;
    const password = generated ? randomPassword() : validatePassword(body.password, target.username);
    const now = Date.now();
    db.tx(() => {
      db.run(
        'UPDATE users SET password_hash = ?, must_change_password = 1, password_changed_at = ?, updated_at = ? WHERE id = ?',
        hashPassword(password),
        now,
        now,
        target.id,
      );
      svc.revokeSessions(target.id);
    });
    svc.audit(ctx, 'user.password_reset', label(target), null, target.academy_id);
    return { ok: true, password };
  });

  // ---------------- 사용 중지 / 다시 사용 ----------------
  router.post('/api/users/:id/suspend', async (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const target = svc.userByUid(ctx.params.id);
    svc.assertManage(actor, target);
    const body = await readJson(ctx.req);
    if (target.role === 'admin' && target.status === 'active' && svc.activeAdminCount() <= 1) {
      throw bad('마지막 운영자 계정은 중지할 수 없어요.');
    }
    const reason = str(body.reason, 200) || null;
    db.tx(() => {
      db.run("UPDATE users SET status = 'suspended', suspended_reason = ?, updated_at = ? WHERE id = ?", reason, Date.now(), target.id);
      svc.revokeSessions(target.id);
    });
    svc.audit(ctx, 'user.suspend', label(target), reason ? { reason } : null, target.academy_id);
    return { user: svc.publicUser(svc.userByUid(target.uid), { withUsage: true }) };
  });

  router.post('/api/users/:id/activate', (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const target = svc.userByUid(ctx.params.id);
    svc.assertManage(actor, target);
    db.run("UPDATE users SET status = 'active', suspended_reason = NULL, updated_at = ? WHERE id = ?", Date.now(), target.id);
    svc.audit(ctx, 'user.activate', label(target), null, target.academy_id);
    return { user: svc.publicUser(svc.userByUid(target.uid), { withUsage: true }) };
  });

  // ---------------- 모든 기기에서 로그아웃 ----------------
  router.get('/api/users/:id/devices', (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const target = svc.userByUid(ctx.params.id);
    svc.assertManage(actor, target);
    const rows = db.all('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC', target.id);
    return { devices: rows.map((s) => svc.publicSession(s, null)) };
  });

  router.post('/api/users/:id/logout-all', (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const target = svc.userByUid(ctx.params.id);
    svc.assertManage(actor, target);
    svc.revokeSessions(target.id);
    svc.audit(ctx, 'user.logout_all', label(target), null, target.academy_id);
    return { ok: true };
  });

  // ---------------- 계정 삭제 ----------------
  router.delete('/api/users/:id', (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const target = svc.userByUid(ctx.params.id);
    svc.assertManage(actor, target);
    if (target.role === 'admin' && svc.activeAdminCount() <= 1 && target.status === 'active') {
      throw bad('마지막 운영자 계정은 삭제할 수 없어요.');
    }
    db.tx(() => {
      db.run('DELETE FROM users WHERE id = ?', target.id); // 세션·파일 기록은 함께 지워짐
    });
    deps.blobs.scheduleGc();
    svc.audit(ctx, 'user.delete', label(target), { role: target.role }, target.academy_id);
    return { ok: true };
  });

  // ---------------- 학원 ----------------
  router.get('/api/academies', (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const rows =
      actor.role === 'admin'
        ? db.all('SELECT * FROM academies ORDER BY name COLLATE NOCASE')
        : db.all('SELECT * FROM academies WHERE id = ?', actor.academy_id ?? -1);
    return {
      academies: rows.map((a) => ({
        id: a.id,
        name: a.name,
        createdAt: a.created_at,
        directors: db.get("SELECT COUNT(*) AS n FROM users WHERE academy_id = ? AND role = 'director'", a.id).n,
        teachers: db.get("SELECT COUNT(*) AS n FROM users WHERE academy_id = ? AND role = 'teacher'", a.id).n,
      })),
    };
  });

  router.post('/api/academies', async (ctx) => {
    svc.requireRole(ctx, 'admin');
    const body = await readJson(ctx.req);
    const name = str(body.name, 60);
    if (!name) throw bad('학원 이름을 입력해 주세요.');
    const id = db.run('INSERT INTO academies(name, created_at) VALUES (?, ?)', name, Date.now()).lastInsertRowid;
    svc.audit(ctx, 'academy.create', name, null, id);
    return { academy: { id, name } };
  });

  router.patch('/api/academies/:id', async (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const id = Number(ctx.params.id);
    if (actor.role === 'director' && actor.academy_id !== id) throw forbidden();
    const a = db.get('SELECT * FROM academies WHERE id = ?', id);
    if (!a) throw notFound('학원을 찾을 수 없어요.');
    const body = await readJson(ctx.req);
    const name = str(body.name, 60);
    if (!name) throw bad('학원 이름을 입력해 주세요.');
    db.run('UPDATE academies SET name = ? WHERE id = ?', name, id);
    svc.audit(ctx, 'academy.update', `${a.name} → ${name}`, null, id);
    return { academy: { id, name } };
  });

  router.delete('/api/academies/:id', (ctx) => {
    svc.requireRole(ctx, 'admin');
    const id = Number(ctx.params.id);
    const a = db.get('SELECT * FROM academies WHERE id = ?', id);
    if (!a) throw notFound('학원을 찾을 수 없어요.');
    if (db.get('SELECT COUNT(*) AS n FROM users WHERE academy_id = ?', id).n > 0) {
      throw bad('이 학원에 계정이 남아 있어요. 계정을 먼저 옮기거나 지워 주세요.');
    }
    db.run('DELETE FROM academies WHERE id = ?', id);
    svc.audit(ctx, 'academy.delete', a.name, null, id);
    return { ok: true };
  });

  // ---------------- 원장 가입 코드 (운영자) ----------------
  function publicCode(c) {
    const now = Date.now();
    let state = 'active';
    if (c.revoked) state = 'revoked';
    else if (c.uses >= c.max_uses) state = 'used';
    else if (c.expires_at && c.expires_at < now) state = 'expired';
    const creator = c.created_by ? db.get('SELECT name FROM users WHERE id = ?', c.created_by) : null;
    return {
      id: c.id,
      code: c.code,
      role: c.role,
      academyName: c.academy_name || '',
      memo: c.memo || '',
      maxUses: c.max_uses,
      uses: c.uses,
      expiresAt: c.expires_at,
      createdAt: c.created_at,
      createdBy: creator?.name || '',
      state,
    };
  }

  router.get('/api/codes', (ctx) => {
    svc.requireRole(ctx, 'admin');
    return { codes: db.all('SELECT * FROM signup_codes ORDER BY created_at DESC LIMIT 200').map(publicCode) };
  });

  router.post('/api/codes', async (ctx) => {
    const actor = svc.requireRole(ctx, 'admin');
    const body = await readJson(ctx.req);
    const maxUses = intOr(body.maxUses, 1, 1, 100);
    const days = body.expiresInDays === 0 || body.expiresInDays === null ? 0 : intOr(body.expiresInDays, 7, 1, 365);
    const now = Date.now();
    let code;
    for (let i = 0; i < 5; i += 1) {
      code = randomCode();
      if (!db.get('SELECT 1 FROM signup_codes WHERE code = ?', code)) break;
    }
    const id = db.run(
      `INSERT INTO signup_codes(code, role, academy_name, memo, max_uses, expires_at, created_by, created_at)
       VALUES (?, 'director', ?, ?, ?, ?, ?, ?)`,
      code,
      str(body.academyName, 60) || null,
      str(body.memo, 200) || null,
      maxUses,
      days ? now + days * DAY : null,
      actor.id,
      now,
    ).lastInsertRowid;
    svc.audit(ctx, 'code.create', code, { academyName: str(body.academyName, 60) || null, maxUses, days });
    return { code: publicCode(db.get('SELECT * FROM signup_codes WHERE id = ?', id)) };
  });

  router.delete('/api/codes/:id', (ctx) => {
    svc.requireRole(ctx, 'admin');
    const c = db.get('SELECT * FROM signup_codes WHERE id = ?', Number(ctx.params.id));
    if (!c) throw notFound('가입 코드를 찾을 수 없어요.');
    db.run('UPDATE signup_codes SET revoked = 1 WHERE id = ?', c.id);
    svc.audit(ctx, 'code.revoke', c.code);
    return { code: publicCode(db.get('SELECT * FROM signup_codes WHERE id = ?', c.id)) };
  });
}

module.exports = { register };
