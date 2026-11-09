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
  normalizeSubjects,
  parseSubjects,
  randomPassword,
  randomCode,
  randomToken,
  sha256Hex,
  intOr,
  str,
  DAY,
} = require('../util');
const { hashPassword } = require('../security');
const { MEMBERS } = require('../sharing');

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
  function inviteById(ctx, actor) {
    const row = db.get('SELECT * FROM teacher_invites WHERE id = ?', Number(ctx.params.id));
    if (!row || (actor.role === 'director' && row.academy_id !== actor.academy_id)) throw notFound();
    return row;
  }
  function publicInvite(row) {
    return { id: row.id, academyId: row.academy_id, name: row.name,
      allowedApps: row.allowed_apps === null ? null : JSON.parse(row.allowed_apps),
      createdBy: db.get('SELECT name FROM users WHERE id = ?', row.created_by)?.name || '',
      createdAt: row.created_at, expiresAt: row.expires_at, expired: row.expires_at <= Date.now() };
  }
  router.post('/api/teacher-invites', async (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const body = await readJson(ctx.req);
    const academyId = actor.role === 'director' ? actor.academy_id : Number(ctx.query.get('academy') || body.academyId);
    if (!academyId || !db.get('SELECT 1 FROM academies WHERE id = ?', academyId)) throw bad('학원을 고르세요.', 'invalid_academy');
    const name = validateName(body.name);
    const allowed = body.allowedApps === undefined ? null : parseAllowedApps(body.allowedApps);
    checkGrantable(actor, allowed);
    const code = randomToken(24), now = Date.now(), expiresAt = now + 7 * DAY;
    const id = db.run(`INSERT INTO teacher_invites(code_hash, academy_id, name, allowed_apps, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, sha256Hex(code), academyId, name, allowed === null ? null : JSON.stringify(allowed), actor.id, now, expiresAt).lastInsertRowid;
    svc.audit(ctx, 'teacher.invite.create', name, null, academyId);
    return { invite: publicInvite(db.get('SELECT * FROM teacher_invites WHERE id = ?', id)), code, expiresAt };
  });
  router.get('/api/teacher-invites', (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const academy = actor.role === 'director' ? actor.academy_id : ctx.query.get('academy');
    const rows = academy ? db.all('SELECT * FROM teacher_invites WHERE academy_id = ? ORDER BY created_at DESC', Number(academy))
      : actor.role === 'admin' ? db.all('SELECT * FROM teacher_invites ORDER BY created_at DESC') : [];
    return { invites: rows.map(publicInvite) };
  });
  router.post('/api/teacher-invites/:id/renew', (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const row = inviteById(ctx, actor);
    checkGrantable(actor, row.allowed_apps === null ? null : JSON.parse(row.allowed_apps));
    const code = randomToken(24), expiresAt = Date.now() + 7 * DAY;
    db.run('UPDATE teacher_invites SET code_hash = ?, expires_at = ? WHERE id = ?', sha256Hex(code), expiresAt, row.id);
    svc.audit(ctx, 'teacher.invite.renew', row.name, null, row.academy_id);
    return { code, expiresAt };
  });
  router.delete('/api/teacher-invites/:id', (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const row = inviteById(ctx, actor);
    db.run('DELETE FROM teacher_invites WHERE id = ?', row.id);
    svc.audit(ctx, 'teacher.invite.revoke', row.name, null, row.academy_id);
    return { ok: true };
  });

  router.get('/api/users', (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const q = str(ctx.query.get('q'), 40);
    const role = str(ctx.query.get('role'), 20);
    const academy = ctx.query.get('academy');
    const where = ["role NOT IN ('student', 'guardian')"];
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
          const subjects = body.academySubjects === undefined ? ['math'] : normalizeSubjects(body.academySubjects);
          academyId = db.run('INSERT INTO academies(name, subjects, created_at) VALUES (?, ?, ?)', academyName, JSON.stringify(subjects), now).lastInsertRowid;
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
    if (body.username !== undefined && normalizeUsername(body.username) !== target.username) {
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
    // 로그인해 둔 기기는 다음에 서버에 물을 때 '사용이 중지된 계정'이라는 답을 받고 로그아웃된다 (services.authenticate)
    db.run("UPDATE users SET status = 'suspended', suspended_reason = ?, updated_at = ? WHERE id = ?", reason, Date.now(), target.id);
    svc.audit(ctx, 'user.suspend', label(target), reason ? { reason } : null, target.academy_id);
    return { user: svc.publicUser(svc.userByUid(target.uid), { withUsage: true }) };
  });

  router.post('/api/users/:id/activate', (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const target = svc.userByUid(ctx.params.id);
    svc.assertManage(actor, target);
    db.tx(() => {
      db.run("UPDATE users SET status = 'active', suspended_reason = NULL, updated_at = ? WHERE id = ?", Date.now(), target.id);
      svc.revokeSessions(target.id); // 사용 중지 전 로그인은 되살리지 않음 (다시 로그인)
    });
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
  // 학원 공간에 남긴 것(members/<계정>/ 파일, 주인인 묶음, 담당 학생)은 같은 학원 원장에게 넘긴다.
  // 개인 공간과 인계되지 않은 개인 폴더 파일은 바로 지운다.

  /** 넘겨받을 수 있는 사람: 같은 학원 원장 (학원이 있는 운영자도, 원장 다음에) */
  function receivers(target) {
    if (target.academy_id == null) return [];
    return db.all(
      "SELECT * FROM users WHERE academy_id = ? AND role IN ('director', 'admin') AND id != ? ORDER BY role = 'admin', created_at",
      target.academy_id,
      target.id,
    );
  }

  /** uid 가 없으면 지우는 사람(원장일 때), 아니면 처음 원장 */
  function pickReceiver(actor, target, uid) {
    const list = receivers(target);
    if (uid) {
      const r = list.find((u) => u.uid === uid);
      if (!r) throw bad('넘겨받을 원장을 찾을 수 없어요.', 'invalid_receiver');
      return r;
    }
    return list.find((u) => u.id === actor.id) || list[0] || null;
  }

  /** 넘길 파일: members/<계정>/ 의 하위 폴더 것만. 바로 아래 파일(예: 오답노트 profile.json = 그 사람 이름)은 그 사람에 대한 것이라 그대로 둠 */
  function memberFiles(target) {
    if (target.academy_id == null) return [];
    const prefix = `${MEMBERS}/${target.uid}/`;
    return db
      .all('SELECT * FROM shared_files WHERE academy_id = ? AND deleted = 0 AND substr(path, 1, ?) = ?', target.academy_id, prefix.length, prefix)
      .filter((f) => f.path.slice(prefix.length).includes('/'));
  }

  function handoverCounts(target) {
    const files = memberFiles(target);
    const aca = target.academy_id ?? -1;
    return {
      files: files.length,
      bytes: files.reduce((n, f) => n + f.size, 0),
      items: db.get('SELECT COUNT(*) AS n FROM shared_items WHERE academy_id = ? AND owner_id = ?', aca, target.id).n,
      students: db.get('SELECT COUNT(*) AS n FROM students WHERE academy_id = ? AND teacher_uid = ? AND purged_at IS NULL', aca, target.uid).n,
    };
  }

  /** db.tx 안에서. members/<target>/... → members/<to>/... (원장에게 같은 경로가 있으면 원래 자리에 둠 — 원장은 볼 수 있음) */
  function handOver(target, to, actor) {
    const aca = target.academy_id;
    const from = `${MEMBERS}/${target.uid}/`;
    const dest = `${MEMBERS}/${to.uid}/`;
    const out = { files: 0, kept: 0, items: 0, students: 0 };
    const touched = new Map(); // 프로그램 → 마지막 seq
    const now = Date.now();
    for (const f of memberFiles(target)) {
      const path = dest + f.path.slice(from.length);
      const dst = db.get('SELECT * FROM shared_files WHERE academy_id = ? AND app_id = ? AND path = ?', aca, f.app_id, path);
      if (dst && !dst.deleted) {
        out.kept += 1;
        continue;
      }
      const s1 = deps.nextSeq();
      if (dst) {
        db.run(
          'UPDATE shared_files SET rev = rev + 1, seq = ?, sha256 = ?, size = ?, mtime = ?, deleted = 0, device_id = NULL, updated_by = ?, updated_at = ? WHERE id = ?',
          s1, f.sha256, f.size, f.mtime, f.updated_by, now, dst.id,
        );
      } else {
        db.run(
          `INSERT INTO shared_files(academy_id, app_id, path, rev, seq, sha256, size, mtime, deleted, device_id, updated_by, updated_at)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, 0, NULL, ?, ?)`,
          aca, f.app_id, path, s1, f.sha256, f.size, f.mtime, f.updated_by, now,
        );
      }
      const s2 = deps.nextSeq();
      db.run('UPDATE shared_files SET rev = rev + 1, seq = ?, sha256 = NULL, size = 0, deleted = 1, device_id = NULL, updated_at = ? WHERE id = ?', s2, now, f.id);
      touched.set(f.app_id, s2);
      out.files += 1;
    }
    out.items = Number(db.run('UPDATE shared_items SET owner_id = ? WHERE academy_id = ? AND owner_id = ?', to.id, aca, target.id).changes);
    out.students = Number(
      db.run(
        'UPDATE students SET teacher_uid = ?, rev = rev + 1, updated_by = ?, updated_at = ? WHERE academy_id = ? AND teacher_uid = ? AND purged_at IS NULL',
        to.uid, actor.uid, now, aca, target.uid,
      ).changes,
    );
    return { out, touched };
  }

  router.get('/api/users/:id/handover', (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const target = svc.userByUid(ctx.params.id);
    svc.assertManage(actor, target);
    return {
      ...handoverCounts(target),
      to: receivers(target).map((u) => ({ id: u.uid, name: u.name, role: u.role })),
      defaultTo: pickReceiver(actor, target, null)?.uid || null,
    };
  });

  const { userFiles, deleteUser } = require('../hard-delete');
  const userDeleteCounts = (u, to) => {
    const prefix = `members/${u.uid}/`;
    const member = db.all('SELECT path FROM shared_files WHERE academy_id = ? AND deleted = 0 AND substr(path, 1, ?) = ?', u.academy_id, prefix.length, prefix);

    return { accounts: 1, files: db.get('SELECT COUNT(*) AS n FROM files WHERE user_id = ? AND deleted = 0', u.id).n
      + member.filter((f) => !to || !f.path.slice(prefix.length).includes('/') || db.get('SELECT 1 FROM shared_files WHERE academy_id = ? AND path = ? AND deleted = 0', u.academy_id, `members/${to.uid}/${f.path.slice(prefix.length)}`)).length };
  };
  router.get('/api/users/:id/delete-preview', (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const target = svc.userByUid(ctx.params.id);
    svc.assertManage(actor, target);
    return userDeleteCounts(target, pickReceiver(actor, target, str(ctx.query.get('to'), 64)));
  });
  function academyDeleteCounts(id) {
    // 운영자 계정은 학원만 빠지고 남는다 (학원 없이 쓰는 계정)
    return { accounts: db.get("SELECT COUNT(*) AS n FROM users WHERE academy_id = ? AND role != 'admin'", id).n,
      students: db.get('SELECT COUNT(*) AS n FROM students WHERE academy_id = ? AND purged_at IS NULL', id).n,
      files: db.get(`SELECT COUNT(*) AS n FROM (SELECT id FROM shared_files WHERE academy_id = ? AND deleted = 0
        UNION ALL SELECT id FROM files WHERE user_id IN (SELECT id FROM users WHERE academy_id = ? AND role != 'admin') AND deleted = 0)`, id, id).n };
  }
  router.get('/api/academies/:id/delete-preview', (ctx) => {
    svc.requireRole(ctx, 'admin');
    const id = Number(ctx.params.id);
    if (!db.get('SELECT 1 FROM academies WHERE id = ?', id)) throw notFound('학원을 찾을 수 없어요.');
    return academyDeleteCounts(id);
  });

  router.delete('/api/users/:id', (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const target = svc.userByUid(ctx.params.id);
    svc.assertManage(actor, target);
    if (target.role === 'admin' && svc.activeAdminCount() <= 1 && target.status === 'active') {
      throw bad('마지막 운영자 계정은 삭제할 수 없어요.');
    }
    const to = pickReceiver(actor, target, str(ctx.query.get('to'), 64));
    let handed = null;
    let removedShared = new Map();
    const candidates = userFiles(db, target);
    const counts = userDeleteCounts(target, to);
    db.tx(() => {
      if (to) handed = handOver(target, to, actor);
      removedShared = deleteUser(db, target, deps.nextSeq);
    });
    for (const [appId, seq] of removedShared) deps.events.publishAcademy(target.academy_id, appId, seq, null);
    if (handed) {
      for (const [appId, seq] of handed.touched) deps.events.publishAcademy(target.academy_id, appId, seq, null);
      if (handed.out.students) deps.events.publishAcademyInfo(target.academy_id, 'students');
    }
    if (target.academy_id) deps.events.publishAcademyInfo(target.academy_id, 'students');
    const blobs = deps.blobs.removeUnreferenced(candidates);
    const moved = handed && Object.values(handed.out).some(Boolean);
    const detail = { role: target.role, ...(moved && { to: label(to), ...handed.out }), removedFiles: counts.files, blobs };
    svc.audit(ctx, 'user.delete', label(target), detail, target.academy_id);
    return { ok: true, handedTo: to ? { id: to.uid, name: to.name, ...handed.out } : null };
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
        subjects: parseSubjects(a.subjects),
        createdAt: a.created_at,
        directors: db.get("SELECT COUNT(*) AS n FROM users WHERE academy_id = ? AND role = 'director'", a.id).n,
        teachers: db.get("SELECT COUNT(*) AS n FROM users WHERE academy_id = ? AND role = 'teacher'", a.id).n,
        quotaMb: a.quota_mb ?? null, // null = 기본 학원 용량
        usageBytes: svc.academyUsageBytes(a.id),
        quotaBytes: svc.academyQuotaBytes(a.id),
      })),
    };
  });

  router.post('/api/academies', async (ctx) => {
    svc.requireRole(ctx, 'admin');
    const body = await readJson(ctx.req);
    const name = str(body.name, 60);
    if (!name) throw bad('학원 이름을 입력해 주세요.');
    const subjects = body.subjects === undefined ? ['math'] : normalizeSubjects(body.subjects);
    const id = db.run('INSERT INTO academies(name, subjects, created_at) VALUES (?, ?, ?)', name, JSON.stringify(subjects), Date.now()).lastInsertRowid;
    svc.audit(ctx, 'academy.create', name, { subjects }, id);
    return { academy: { id, name, subjects } };
  });

  router.patch('/api/academies/:id', async (ctx) => {
    const actor = svc.requireRole(ctx, 'admin', 'director');
    const id = Number(ctx.params.id);
    if (actor.role === 'director' && actor.academy_id !== id) throw forbidden();
    const a = db.get('SELECT * FROM academies WHERE id = ?', id);
    if (!a) throw notFound('학원을 찾을 수 없어요.');
    const body = await readJson(ctx.req);
    const before = parseSubjects(a.subjects);
    let subjects = before;
    if (body.subjects !== undefined) {
      if (actor.role !== 'admin') throw forbidden('계약 과목은 운영자만 바꿀 수 있어요.');
      subjects = normalizeSubjects(body.subjects);
    }
    let name = a.name;
    if (body.name !== undefined) {
      name = str(body.name, 60);
      if (!name) throw bad('학원 이름을 입력해 주세요.');
      if (name !== a.name) {
        db.run('UPDATE academies SET name = ? WHERE id = ?', name, id);
        svc.audit(ctx, 'academy.update', `${a.name} → ${name}`, null, id);
      }
    }
    if (body.quotaMb !== undefined) {
      if (actor.role !== 'admin') throw forbidden('학원 용량은 운영자만 바꿀 수 있어요.');
      const q = body.quotaMb === null ? null : intOr(body.quotaMb, null, 0, 1024 * 1024);
      db.run('UPDATE academies SET quota_mb = ? WHERE id = ?', q, id);
      svc.audit(ctx, 'academy.quota', name, { quotaMb: q }, id);
    }
    const subjectsChanged = JSON.stringify(subjects) !== JSON.stringify(before);
    if (subjectsChanged) {
      db.run('UPDATE academies SET subjects = ? WHERE id = ?', JSON.stringify(subjects), id);
      svc.audit(ctx, 'academy.subjects', name, { subjects, before }, id);
    }
    if (subjectsChanged || name !== a.name) deps.events.publishAcademyInfo(id, 'academy');
    return { academy: { id, name, quotaMb: db.get('SELECT quota_mb FROM academies WHERE id = ?', id).quota_mb ?? null, subjects } };
  });

  router.delete('/api/academies/:id', (ctx) => {
    svc.requireRole(ctx, 'admin');
    const id = Number(ctx.params.id);
    const a = db.get('SELECT * FROM academies WHERE id = ?', id);
    if (!a) throw notFound('학원을 찾을 수 없어요.');
    const counts = academyDeleteCounts(id);
    const users = db.all("SELECT * FROM users WHERE academy_id = ? AND role != 'admin'", id);
    const candidates = [...db.all('SELECT sha256 FROM shared_files WHERE academy_id = ?', id), ...users.flatMap((u) => userFiles(db, u))];
    db.tx(() => {
      for (const u of users) deleteUser(db, u, deps.nextSeq);
      db.run('DELETE FROM audit WHERE academy_id = ?', id);
      db.run('DELETE FROM academies WHERE id = ?', id);
    });
    const blobs = deps.blobs.removeUnreferenced(candidates);
    svc.audit({ ...ctx, auth: { ...ctx.auth, user: { ...ctx.auth.user, academy_id: null } } }, 'academy.delete', a.name, { id, ...counts, blobs });
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
      subjects: parseSubjects(c.subjects),
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
    const subjects = body.subjects === undefined ? ['math'] : normalizeSubjects(body.subjects);
    const days = body.expiresInDays === 0 || body.expiresInDays === null ? 0 : intOr(body.expiresInDays, 7, 1, 365);
    const now = Date.now();
    let code;
    for (let i = 0; i < 5; i += 1) {
      code = randomCode();
      if (!db.get('SELECT 1 FROM signup_codes WHERE code = ?', code)) break;
    }
    const id = db.run(
      `INSERT INTO signup_codes(code, role, academy_name, memo, max_uses, expires_at, created_by, created_at, subjects)
       VALUES (?, 'director', ?, ?, ?, ?, ?, ?, ?)`,
      code,
      str(body.academyName, 60) || null,
      str(body.memo, 200) || null,
      maxUses,
      days ? now + days * DAY : null,
      actor.id,
      now,
      JSON.stringify(subjects),
    ).lastInsertRowid;
    svc.audit(ctx, 'code.create', code, { academyName: str(body.academyName, 60) || null, maxUses, days, subjects });
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
