'use strict';

const crypto = require('node:crypto');
const { readJson } = require('../http');
const {
  DAY,
  HttpError,
  bad,
  forbidden,
  notFound,
  normalizeUsername,
  validatePassword,
  validateName,
  randomToken,
  sha256Hex,
  intOr,
} = require('../util');
const { hashPassword, seal, unseal } = require('../security');
const CONSENT_VERSION = '2026-11-09';
const ITEMS = ['collect', 'messaging', 'overseas_ai', 'marketing'];
const JOIN_ITEMS = ['collect', 'messaging'];
const consent = (c) => ({ ...c, verified: c.method === 'paper' || c.sms_confirmed_at != null });

// 확인 문자 발송을 마친 신뢰할 수 있는 발송 작업만 호출한다.
function confirmConsentSms(db, id, at = Date.now()) {
  return db.run(
    "UPDATE guardian_consents SET sms_confirmed_at = ? WHERE id = ? AND method = 'online' AND withdrawn_at IS NULL AND sms_confirmed_at IS NULL",
    at,
    id,
  ).changes;
}

function register(router, deps) {
  const { db, svc, joinCodes, guardianKey } = deps;

  function who(ctx, write = false) {
    const { user } = svc.authenticate(ctx, { app: true });
    if (!(write ? ['admin', 'director'] : ['admin', 'director', 'teacher']).includes(user.role)) throw forbidden();
    const aca = user.role === 'admin' ? intOr(ctx.query.get('academy'), null, 1) : user.academy_id;
    if (!aca || !db.get('SELECT 1 FROM academies WHERE id = ?', aca)) throw bad('학원을 골라 주세요.', 'academy_required');
    return { user, aca };
  }

  function student(ctx, write = false) {
    const w = who(ctx, write);
    const s = db.get('SELECT * FROM students WHERE id = ? AND academy_id = ? AND purged_at IS NULL', ctx.params.sid, w.aca);
    if (!s) throw notFound('학생을 찾을 수 없어요.');
    if (w.user.role === 'teacher' && s.teacher_uid !== w.user.uid) throw forbidden();
    return { ...w, s };
  }

  function guardian(ctx, write = false) {
    const w = student(ctx, write);
    const g = db.get('SELECT * FROM guardians WHERE id = ? AND academy_id = ? AND student_id = ?', ctx.params.gid, w.aca, w.s.id);
    if (!g) throw notFound('보호자를 찾을 수 없어요.');
    return { ...w, g };
  }

  function publicGuardian(g, phone = false) {
    const { phone_enc, ...out } = g;
    return { ...out, ...(phone ? { phone: unseal(guardianKey, phone_enc) } : {}) };
  }

  function audit(ctx, action, g) {
    svc.audit(ctx, `guardian.${action}`, String(g.id), { studentId: g.student_id }, g.academy_id);
  }

  function guardianValues(body, old = {}) {
    const name = validateName(body.name ?? old.name);
    const relation = body.relation ?? old.relation ?? '';
    const phone = body.phone;
    if (typeof relation !== 'string' || relation.length > 30) throw bad('관계는 30자 이내로 입력해 주세요.');
    if (phone !== undefined && (typeof phone !== 'string' || !/^[+0-9 ()-]{7,30}$/.test(phone))) throw bad('전화번호를 확인해 주세요.');
    for (const k of ['notify', 'isPrimary'])
      if (body[k] !== undefined && typeof body[k] !== 'boolean') throw bad('설정이 올바르지 않아요.');
    if (!old.id && phone === undefined) throw bad('전화번호를 입력해 주세요.');
    return [
      name,
      relation,
      phone === undefined ? old.phone_enc : seal(guardianKey, phone),
      body.notify === undefined ? old.notify || 0 : +body.notify,
      body.isPrimary === undefined ? old.is_primary || 0 : +body.isPrimary,
    ];
  }

  router.get('/api/guardians/consent-summary', (ctx) => {
    const { aca, user } = who(ctx);
    const rows = db.all(`SELECT s.id AS studentId, EXISTS (
      SELECT 1 FROM guardian_consents c JOIN guardians g ON g.id=c.guardian_id
      AND g.student_id=s.id AND g.academy_id=s.academy_id
      WHERE c.student_id=s.id AND c.academy_id=s.academy_id AND c.item='collect'
      AND c.withdrawn_at IS NULL AND (c.method='paper' OR c.sms_confirmed_at IS NOT NULL)
    ) AS collectVerified FROM students s
    WHERE s.academy_id=? AND s.deleted_at IS NULL AND s.purged_at IS NULL
    AND (? != 'teacher' OR s.teacher_uid=?)`, aca, user.role, user.uid);
    return { students: rows.map(r => ({ ...r, collectVerified: !!r.collectVerified })) };
  });

  router.get('/api/students/:sid/guardians', (ctx) => {
    const { aca, s } = student(ctx);
    const cs = db.all('SELECT * FROM guardian_consents WHERE academy_id=? AND student_id=?', aca, s.id).map(consent);
    return {
      guardians: db.all('SELECT * FROM guardians WHERE academy_id = ? AND student_id = ?', aca, s.id).map((g) => ({ ...publicGuardian(g, true), consents: cs.filter(c => c.guardian_id === g.id) })),
    };
  });

  router.post('/api/students/:sid/guardians', async (ctx) => {
    const { user, aca, s } = student(ctx, true);
    const fields = guardianValues(await readJson(ctx.req));
    const now = Date.now();
    const id = db.tx(() => {
      if (fields[4])
        db.run('UPDATE guardians SET is_primary = 0, rev = rev + 1, updated_at = ? WHERE student_id = ? AND is_primary = 1', now, s.id);
      return db.run(
        'INSERT INTO guardians(academy_id,student_id,name,relation,phone_enc,notify,is_primary,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        aca,
        s.id,
        ...fields,
        user.id,
        now,
        now,
      ).lastInsertRowid;
    });
    const g = db.get('SELECT * FROM guardians WHERE id = ?', id);
    audit(ctx, 'create', g);
    return { guardian: publicGuardian(g, true) };
  });

  router.patch('/api/students/:sid/guardians/:gid', async (ctx) => {
    const { g } = guardian(ctx, true);
    const body = await readJson(ctx.req);
    const fields = guardianValues(body, g);
    const now = Date.now();
    db.tx(() => {
      if (body.rev !== db.get('SELECT rev FROM guardians WHERE id=?', g.id)?.rev)
        throw new HttpError(409, '다른 사람이 고쳤어요. 다시 불러와 주세요.', 'conflict');
      if (fields[4])
        db.run(
          'UPDATE guardians SET is_primary = 0, rev = rev + 1, updated_at = ? WHERE student_id = ? AND id != ? AND is_primary = 1',
          now,
          g.student_id,
          g.id,
        );
      db.run(
        'UPDATE guardians SET name=?,relation=?,phone_enc=?,notify=?,is_primary=?,updated_at=?,rev=rev+1 WHERE id=?',
        ...fields,
        now,
        g.id,
      );
    });
    audit(ctx, 'update', g);
    return { guardian: publicGuardian(db.get('SELECT * FROM guardians WHERE id=?', g.id), true) };
  });

  router.delete('/api/students/:sid/guardians/:gid', (ctx) => {
    const { g } = guardian(ctx, true);
    db.run('DELETE FROM guardians WHERE id=?', g.id);
    audit(ctx, 'delete', g);
    return { ok: true };
  });

  router.post('/api/students/:sid/guardians/:gid/invite', (ctx) => {
    const { user, g, s } = guardian(ctx, true);
    if (g.user_id || s.deleted_at) throw bad('초대할 수 없는 보호자예요.');
    const code = randomToken(24),
      now = Date.now(),
      expiresAt = now + 7 * DAY;
    db.tx(() => {
      db.run('DELETE FROM guardian_invites WHERE guardian_id=?', g.id);
      db.run(
        'INSERT INTO guardian_invites(code_hash,academy_id,guardian_id,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?)',
        sha256Hex(code),
        g.academy_id,
        g.id,
        user.id,
        now,
        expiresAt,
      );
    });
    audit(ctx, 'invite.create', g);
    return { code, expiresAt };
  });

  router.delete('/api/students/:sid/guardians/:gid/invite', (ctx) => {
    const { g } = guardian(ctx, true);
    db.run('DELETE FROM guardian_invites WHERE guardian_id=?', g.id);
    audit(ctx, 'invite.cancel', g);
    return { ok: true };
  });

  router.delete('/api/students/:sid/guardians/:gid/account-link', (ctx) => {
    const { g } = guardian(ctx, true);
    db.tx(() => {
      db.run('UPDATE guardians SET user_id=NULL,rev=rev+1,updated_at=? WHERE id=?', Date.now(), g.id);
      db.run('DELETE FROM guardian_invites WHERE guardian_id=?', g.id);
    });
    audit(ctx, 'unlink', g);
    return { ok: true };
  });

  router.get('/api/guardian-accounts', (ctx) => {
    const { aca } = who(ctx, true);
    return {
      accounts: db.all(
        "SELECT uid AS id,username,name,(SELECT COUNT(*) FROM guardians g WHERE g.user_id=u.id) AS childLinks FROM users u WHERE role='guardian' AND academy_id=?",
        aca,
      ),
    };
  });

  router.delete('/api/guardian-accounts/:uid', (ctx) => {
    const { aca } = who(ctx, true);
    const u = db.get("SELECT * FROM users WHERE uid=? AND academy_id=? AND role='guardian'", ctx.params.uid, aca);
    if (!u) throw notFound();
    db.tx(() => {
      db.run('UPDATE guardians SET rev=rev+1,updated_at=? WHERE user_id=?', Date.now(), u.id);
      db.run('DELETE FROM users WHERE id=?', u.id);
    });
    svc.audit(ctx, 'guardian.account.delete', u.uid, null, aca);
    return { ok: true };
  });

  router.get('/api/students/:sid/guardians/:gid/consents', (ctx) => {
    const { g } = guardian(ctx);
    return { consents: db.all('SELECT * FROM guardian_consents WHERE guardian_id=?', g.id).map(consent) };
  });

  router.post('/api/students/:sid/guardians/:gid/consents', async (ctx) => {
    const { user, g } = guardian(ctx, true);
    const body = await readJson(ctx.req);
    if (!ITEMS.includes(body.item) || typeof body.version !== 'string' || !body.version.trim() || body.version.length > 80)
      throw bad('동의 항목과 판을 확인해 주세요.');
    if (body.method !== undefined && body.method !== 'paper') throw bad('종이 동의만 기록할 수 있어요.');
    const id = db.run(
      "INSERT INTO guardian_consents(academy_id,student_id,guardian_id,item,version,method,agreed_at,recorded_by) VALUES (?,?,?,?,?,'paper',?,?)",
      g.academy_id,
      g.student_id,
      g.id,
      body.item,
      body.version,
      Date.now(),
      user.id,
    ).lastInsertRowid;
    audit(ctx, 'consent.record', g);
    return { consent: consent(db.get('SELECT * FROM guardian_consents WHERE id=?', id)) };
  });

  function withdraw(ctx, c, g) {
    if (c.item === 'collect') throw bad('필수 동의는 철회할 수 없어요.', 'required_consent');
    db.run('UPDATE guardian_consents SET withdrawn_at=COALESCE(withdrawn_at,?) WHERE id=?', Date.now(), c.id);
    audit(ctx, 'consent.withdraw', g);
    return { ok: true };
  }

  router.post('/api/students/:sid/guardians/:gid/consents/:cid/withdraw', (ctx) => {
    const { g } = guardian(ctx, true);
    const c = db.get('SELECT * FROM guardian_consents WHERE id=? AND guardian_id=?', ctx.params.cid, g.id);
    if (!c) throw notFound();
    return withdraw(ctx, c, g);
  });

  router.get('/api/me/guardians', (ctx) => {
    const { user } = svc.authenticate(ctx, { app: true });
    if (user.role !== 'guardian') throw forbidden();
    return {
      apps: deps.catalog
        .list()
        .filter((a) => svc.canUseApp(user, a.id))
        .map((a) => ({ id: a.id, name: a.name, url: a.url })),
      guardians: db.all('SELECT * FROM guardians WHERE user_id=? AND academy_id=?', user.id, user.academy_id).map((g) => publicGuardian(g)),
    };
  });

  router.get('/api/me/consents', (ctx) => {
    const { user } = svc.authenticate(ctx, { app: true });
    if (user.role !== 'guardian') throw forbidden();
    return {
      consents: db
        .all(
          'SELECT c.* FROM guardian_consents c JOIN guardians g ON g.id=c.guardian_id WHERE g.user_id=? AND g.academy_id=?',
          user.id,
          user.academy_id,
        )
        .map(consent),
    };
  });

  router.post('/api/me/consents/:cid/withdraw', (ctx) => {
    const { user } = svc.authenticate(ctx);
    const c = db.get(
      'SELECT c.* FROM guardian_consents c JOIN guardians g ON g.id=c.guardian_id WHERE c.id=? AND g.user_id=? AND g.academy_id=?',
      ctx.params.cid,
      user.id,
      user.academy_id,
    );
    if (!c) throw notFound();
    return withdraw(ctx, c, db.get('SELECT * FROM guardians WHERE id=?', c.guardian_id));
  });

  function invite(ctx, code) {
    joinCodes.check(ctx.ip);
    return joinCodes.guardian(code);
  }
  // 기존 가입 경로를 감싸 학생 가입 흐름과 공통 실패 횟수 제한을 유지한다.
  deps.guardianJoin = async (ctx, body) => {
    const i = invite(ctx, body.code);
    if (!i) return null;
    let existing = null;
    if (ctx.req.headers.authorization) {
      existing = svc.authenticate(ctx).user;
      if (existing.role !== 'guardian' || existing.academy_id !== i.academy_id)
        throw forbidden('로그아웃하고 이 학원용 보호자 계정을 만들어 주세요.', 'guardian_account_mismatch');
    }
    if (
      !body.consents ||
      body.consents.collect !== true ||
      body.consentVersion !== CONSENT_VERSION ||
      Object.keys(body.consents).some((k) => !JOIN_ITEMS.includes(k) || typeof body.consents[k] !== 'boolean')
    )
      throw bad('필수 동의와 동의문 판을 확인해 주세요.', 'required_consent');
    const username = existing ? existing.username : normalizeUsername(body.username),
      name = existing ? existing.name : validateName(body.name);
    const password = existing ? null : validatePassword(body.password, username);
    const result = db.tx(() => {
      const fresh = invite(ctx, body.code);
      if (!fresh) joinCodes.invalid(ctx.ip);
      let user = existing;
      const now = Date.now();
      if (!user) {
        if (db.get('SELECT 1 FROM users WHERE username=?', username)) throw bad('이미 있는 아이디예요.', 'username_taken');
        const id = db.run(
          "INSERT INTO users(uid,username,name,role,academy_id,password_hash,created_by,created_at,updated_at) VALUES (?,?,?,'guardian',?,?,?,?,?)",
          crypto.randomUUID(),
          username,
          name,
          i.academy_id,
          hashPassword(password),
          i.created_by,
          now,
          now,
        ).lastInsertRowid;
        user = db.get('SELECT * FROM users WHERE id=?', id);
      }
      if (db.get('SELECT 1 FROM guardians WHERE student_id=? AND user_id=?', i.student_id, user.id))
        throw bad('이미 연결된 자녀예요.', 'already_linked');
      db.run('UPDATE guardians SET user_id=?,rev=rev+1,updated_at=? WHERE id=?', user.id, now, i.guardian_id);
      db.run('UPDATE guardian_invites SET used_at=? WHERE id=?', now, i.id);
      for (const item of JOIN_ITEMS)
        if (body.consents[item] === true)
          db.run(
            "INSERT INTO guardian_consents(academy_id,student_id,guardian_id,item,version,method,agreed_at,recorded_by) VALUES (?,?,?,?,?,'online',?,?)",
            i.academy_id,
            i.student_id,
            i.guardian_id,
            item,
            CONSENT_VERSION,
            now,
            user.id,
          );
      return { user, token: svc.createSession(user, { platform: 'web', name: '보호자 웹' }, ctx.ip) };
    });
    ctx.auth = { user: result.user };
    const g = db.get('SELECT * FROM guardians WHERE id=?', i.guardian_id);
    audit(ctx, 'join', g);
    audit(ctx, 'consent.record', g);
    return { token: result.token, user: svc.publicUser(result.user), server: { id: svc.meta('server_id'), keys: deps.trustKeys() } };
  };
}

module.exports = { register, confirmConsentSms, CONSENT_VERSION };
