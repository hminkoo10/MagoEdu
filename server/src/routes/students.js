'use strict';

// 학원 학생 명단과 학원 공용 AI (students.js)
//   GET    /api/students                  명단 (지운 학생 포함) + 완전히 지운 학생 ID
//   POST   /api/students                  추가 {name, school, schoolOffice, schoolCode, grade, teacherId, memo, id?}
//   PATCH  /api/students/:id              고치기 {..., baseRev?}  (baseRev 가 다르면 409)
//   DELETE /api/students/:id              지우기 (숨김, 정한 날짜 뒤 완전히 지움)
//   POST   /api/students/:id/restore      되살리기
//   GET    /api/academy/members           학원 사람 (담당 선생님 고르기)
//   GET    /api/academy/ai?app=<id>       그 프로그램이 쓸 학원 AI (학원 사람 누구나, 키는 빼고 — 부르는 건 routes/ai-relay.js)
//   GET    /api/academy/ai/all            학원 AI 설정 전체 (키는 끝 4자리만, 원장·운영자)
//   PUT    /api/academy/ai                {app: '' | 프로그램 ID, config: {...} | null} (원장·운영자)
//
// 원장·선생님은 자기 학원, 운영자는 ?academy=<학원 ID>. 웹 프로그램 전용 세션도 쓸 수 있다 (AI 설정 고치기는 빼고).

const { readJson } = require('../http');
const { forbidden, notFound, bad, intOr } = require('../util');
const { publicAi } = require('./ai-relay');

function register(router, deps) {
  const { db, svc } = deps;
  const students = deps.students;

  function who(ctx) {
    const { user, session } = svc.authenticate(ctx, { app: true });
    let aca = user.academy_id;
    if (user.role === 'admin') {
      aca = intOr(ctx.query.get('academy'), null, 1);
      if (!aca) throw bad('학원을 골라 주세요.', 'academy_required');
      if (!db.get('SELECT 1 FROM academies WHERE id = ?', aca)) throw notFound('학원을 찾을 수 없어요.');
    }
    if (!aca) throw notFound('학원에 속한 계정만 학생 명단을 쓸 수 있어요.', 'no_academy');
    return { user, session, aca };
  }

  function manager(ctx) {
    const w = who(ctx);
    if (w.session.app_id || (w.user.role !== 'director' && w.user.role !== 'admin')) throw forbidden('원장님이나 운영자만 바꿀 수 있어요.');
    return w;
  }

  // ---------------- 학생 ----------------
  router.get('/api/students', (ctx) => {
    const { user, aca } = who(ctx);
    if (user.role === 'student') {
      const s = db.get('SELECT * FROM students WHERE id = ? AND academy_id = ?', user.student_id, aca);
      return { academyId: aca, students: [{ id: s.id, name: s.name, school: s.school, grade: s.grade,
        schoolOffice: s.school_office, schoolCode: s.school_code,
        teacher: s.teacher_uid ? { id: s.teacher_uid, name: svc.publicUser(user).student.teacherName } : null }], purged: [] };
    }
    const out = students.list(aca);
    const accounts = new Map(db.all("SELECT student_id, username, status, must_change_password, ai_mode, last_login_at FROM users WHERE academy_id = ? AND role = 'student'", aca)
      .map((u) => [u.student_id, { username: u.username, status: u.status === 'active' ? 'active' : 'disabled',
        mustChangePassword: !!u.must_change_password, aiMode: u.ai_mode, lastLoginAt: u.last_login_at || null }]));
    for (const s of out.students) s.account = accounts.get(s.id) || null;
    return out;
  });

  router.post('/api/students', async (ctx) => {
    const { user, aca } = who(ctx);
    const r = students.create(user, aca, await readJson(ctx.req));
    if (!r.existed) svc.audit(ctx, 'student.create', r.student.name, { id: r.student.id }, aca);
    return r;
  });

  router.patch('/api/students/:id', async (ctx) => {
    const { user, aca } = who(ctx);
    const s = students.update(user, aca, ctx.params.id, await readJson(ctx.req));
    svc.audit(ctx, 'student.update', s.name, { id: s.id }, aca);
    return { student: s };
  });

  router.delete('/api/students/:id', (ctx) => {
    const { user, aca } = who(ctx);
    const s = db.tx(() => {
      const out = students.remove(user, aca, ctx.params.id);
      db.run("UPDATE users SET status = 'suspended', updated_at = ? WHERE student_id = ? AND academy_id = ?", Date.now(), out.id, aca);
      db.run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE student_id = ? AND academy_id = ?)', out.id, aca);
      db.run('DELETE FROM student_invites WHERE student_id = ?', out.id);
      return out;
    });
    svc.audit(ctx, 'student.delete', s.name, { id: s.id }, aca);
    return { student: s };
  });

  router.post('/api/students/:id/restore', (ctx) => {
    const { user, aca } = who(ctx);
    const s = db.tx(() => {
      const out = students.restore(user, aca, ctx.params.id);
      db.run("UPDATE users SET status = 'active', updated_at = ? WHERE student_id = ? AND academy_id = ?", Date.now(), out.id, aca);
      return out;
    });
    svc.audit(ctx, 'student.restore', s.name, { id: s.id }, aca);
    return { student: s };
  });

  router.get('/api/academy/members', (ctx) => {
    const { aca } = who(ctx);
    return { academyId: aca, members: students.members(aca) };
  });

  // ---------------- 학원 공용 AI ----------------
  router.get('/api/academy/ai', (ctx) => {
    const { user, session, aca } = who(ctx);
    // 웹 프로그램 전용 세션은 자기 프로그램 것만
    const appId = session.app_id || String(ctx.query.get('app') || '');
    if (appId && !svc.canUseApp(user, appId)) throw forbidden('이 프로그램을 쓸 권한이 없어요.');
    return { app: appId, ai: publicAi(students.aiFor(aca, appId), { allowPrivate: deps.config.aiRelayAllowPrivate }) };
  });

  router.get('/api/academy/ai/all', (ctx) => {
    const { aca } = manager(ctx);
    return { ...students.aiAll(aca), programs: programs(aca) };
  });

  router.put('/api/academy/ai', async (ctx) => {
    const { user, aca } = manager(ctx);
    const body = await readJson(ctx.req);
    const appId = String(body.app || '');
    const out = students.setAi(user, aca, appId, body.config ?? null);
    svc.audit(ctx, body.config ? 'academy.ai.set' : 'academy.ai.clear', appId || '기본', null, aca);
    return { ...out, programs: programs(aca) };
  });

  /** 프로그램마다 따로 정할 수 있는 목록 (켜진 PC·웹 프로그램, 꺼졌어도 이미 따로 정한 것) */
  function programs(aca) {
    return db
      .all(
        `SELECT id, name, platform FROM apps WHERE platform IN ('windows', 'web')
           AND (enabled = 1 OR id IN (SELECT app_id FROM academy_ai WHERE academy_id = ?)) ORDER BY sort, name`,
        aca,
      )
      .map((a) => ({ id: a.id, name: a.name, platform: a.platform }));
  }
}

module.exports = { register };
