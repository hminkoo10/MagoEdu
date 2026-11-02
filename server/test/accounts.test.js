'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ADMIN_PASSWORD } = require('./helpers');

test('계정: 운영자, 가입 코드, 원장·선생님 관리', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { request: rq } = s;

  const admin = await s.login('admin', ADMIN_PASSWORD, 'admin-pc');

  await t.test('운영자 계정이 처음부터 있고, 틀린 비밀번호는 거절', async () => {
    const me = await rq('GET', '/api/me', { token: admin });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.role, 'admin');
    assert.equal(me.data.user.username, 'admin');
    const bad = await rq('POST', '/api/auth/login', { body: { username: 'admin', password: 'nope' } });
    assert.equal(bad.status, 401);
    assert.equal(bad.data.error.code, 'invalid_credentials');
    const noAuth = await rq('GET', '/api/me');
    assert.equal(noAuth.status, 401);
  });

  let code;
  await t.test('원장 가입 코드 만들기 → 코드 확인 → 가입', async () => {
    const r = await rq('POST', '/api/codes', { token: admin, body: { academyName: '마고수학학원', memo: '본원', maxUses: 1, expiresInDays: 7 } });
    assert.equal(r.status, 200);
    code = r.data.code.code;
    assert.match(code, /^MAGO-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const chk = await rq('GET', `/api/auth/codes/${code.toLowerCase()}`);
    assert.equal(chk.status, 200);
    assert.equal(chk.data.academyName, '마고수학학원');

    const su = await rq('POST', '/api/auth/signup', {
      body: { code, name: '김원장', username: 'Director1', password: 'secret12', device: { id: 'dir-pc', name: '원장실' } },
    });
    assert.equal(su.status, 200, JSON.stringify(su.data));
    assert.equal(su.data.user.role, 'director');
    assert.equal(su.data.user.username, 'director1');
    assert.equal(su.data.user.academy.name, '마고수학학원');
    assert.ok(su.data.token);
    assert.ok(su.data.server.keys[0].x);

    const again = await rq('POST', '/api/auth/signup', { body: { code, name: '또원장', username: 'dir2', password: 'secret12' } });
    assert.equal(again.status, 400);
    assert.equal(again.data.error.code, 'invalid_code');

    const list = await rq('GET', '/api/codes', { token: admin });
    assert.equal(list.data.codes[0].state, 'used');
  });

  await t.test('취소한 코드는 쓸 수 없음', async () => {
    const r = await rq('POST', '/api/codes', { token: admin, body: { maxUses: 3 } });
    const del = await rq('DELETE', `/api/codes/${r.data.code.id}`, { token: admin });
    assert.equal(del.data.code.state, 'revoked');
    const su = await rq('POST', '/api/auth/signup', {
      body: { code: r.data.code.code, academyName: 'X', name: 'X', username: 'xxx', password: 'secret12' },
    });
    assert.equal(su.status, 400);
  });

  const director = await s.login('director1', 'secret12', 'dir-pc');
  let teacherId;

  await t.test('원장은 선생님 계정을 만들고 지울 수 있음', async () => {
    const r = await rq('POST', '/api/users', { token: director, body: { name: '이선생', username: 'teacher1', password: 'teach123' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.user.role, 'teacher');
    assert.equal(r.data.user.academy.name, '마고수학학원');
    assert.equal(r.data.user.mustChangePassword, true);
    teacherId = r.data.user.id;

    // 원장이 운영자나 원장 계정을 만들 수는 없음 (항상 선생님)
    const r2 = await rq('POST', '/api/users', { token: director, body: { role: 'admin', name: '가짜', username: 'fakeadmin' } });
    assert.equal(r2.data.user.role, 'teacher');
    assert.ok(r2.data.password, '비밀번호를 비우면 만들어서 알려 줌');
    const del = await rq('DELETE', `/api/users/${r2.data.user.id}`, { token: director });
    assert.equal(del.status, 200);

    const list = await rq('GET', '/api/users', { token: director });
    assert.deepEqual(
      list.data.users.map((u) => u.username),
      ['director1', 'teacher1'],
    );
    assert.equal(list.data.users.find((u) => u.username === 'director1').manageable, false);
  });

  await t.test('다른 학원 계정·원장 자신은 관리할 수 없음', async () => {
    const other = await rq('POST', '/api/users', {
      token: admin,
      body: { role: 'teacher', name: '박선생', username: 'other1', password: 'other123', academyName: '다른학원' },
    });
    assert.equal(other.status, 200);
    const r = await rq('DELETE', `/api/users/${other.data.user.id}`, { token: director });
    assert.equal(r.status, 403);
    const meId = (await rq('GET', '/api/me', { token: director })).data.user.id;
    assert.equal((await rq('POST', `/api/users/${meId}/password`, { token: director, body: {} })).status, 403);
  });

  await t.test('선생님은 계정 목록을 볼 수 없음, 처음 로그인하면 비밀번호 바꾸기', async () => {
    const teacher = await s.login('teacher1', 'teach123', 't-pc');
    assert.equal((await rq('GET', '/api/users', { token: teacher })).status, 403);
    assert.equal((await rq('GET', '/api/codes', { token: teacher })).status, 403);
    const me = await rq('GET', '/api/me', { token: teacher });
    assert.equal(me.data.user.mustChangePassword, true);
    const ch = await rq('PATCH', '/api/me/password', { token: teacher, body: { currentPassword: 'teach123', newPassword: 'newteach1' } });
    assert.equal(ch.status, 200);
    assert.equal(ch.data.user.mustChangePassword, false);
  });

  await t.test('아이디·비밀번호 바꾸기 (모든 계정)', async () => {
    let teacher = await s.login('teacher1', 'newteach1', 't-pc');
    const other = await s.login('teacher1', 'newteach1', 't-pc2', '집 컴퓨터');
    const badPw = await rq('PATCH', '/api/me/username', { token: teacher, body: { username: 'lee', password: 'wrong' } });
    assert.equal(badPw.status, 400);
    const taken = await rq('PATCH', '/api/me/username', { token: teacher, body: { username: 'DIRECTOR1', password: 'newteach1' } });
    assert.equal(taken.data.error.code, 'username_taken');
    const ok = await rq('PATCH', '/api/me/username', { token: teacher, body: { username: 'lee.teacher', password: 'newteach1' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.user.username, 'lee.teacher');
    assert.equal(ok.data.user.id, teacherId, '아이디를 바꿔도 계정(데이터)은 그대로');

    const pw = await rq('PATCH', '/api/me/password', { token: teacher, body: { currentPassword: 'newteach1', newPassword: 'another1' } });
    assert.equal(pw.status, 200);
    assert.equal((await rq('GET', '/api/me', { token: teacher })).status, 200, '지금 기기는 계속 로그인');
    assert.equal((await rq('GET', '/api/me', { token: other })).status, 401, '다른 기기는 로그아웃');
    teacher = await s.login('lee.teacher', 'another1', 't-pc');
    assert.ok(teacher);

    const adminPw = await rq('PATCH', '/api/me/password', { token: admin, body: { currentPassword: ADMIN_PASSWORD, newPassword: 'admin-new-1' } });
    assert.equal(adminPw.status, 200);
  });

  await t.test('비밀번호 초기화, 사용 중지, 다시 사용', async () => {
    const teacher = await s.login('lee.teacher', 'another1', 't-pc');
    const reset = await rq('POST', `/api/users/${teacherId}/password`, { token: director, body: {} });
    assert.equal(reset.status, 200);
    assert.match(reset.data.password, /^[a-z]{4}[0-9]{4}[a-z]{2}$/);
    assert.equal((await rq('GET', '/api/me', { token: teacher })).status, 401, '초기화하면 로그아웃');
    const t2 = await s.login('lee.teacher', reset.data.password, 't-pc');
    assert.equal((await rq('GET', '/api/me', { token: t2 })).data.user.mustChangePassword, true);

    const sus = await rq('POST', `/api/users/${teacherId}/suspend`, { token: director, body: { reason: '휴직' } });
    assert.equal(sus.data.user.status, 'suspended');
    assert.equal((await rq('GET', '/api/me', { token: t2 })).status, 401);
    const login = await rq('POST', '/api/auth/login', { body: { username: 'lee.teacher', password: reset.data.password } });
    assert.equal(login.status, 403);
    assert.equal(login.data.error.code, 'account_suspended');
    assert.equal(login.data.error.reason, '휴직');

    const act = await rq('POST', `/api/users/${teacherId}/activate`, { token: director });
    assert.equal(act.data.user.status, 'active');
    assert.ok(await s.login('lee.teacher', reset.data.password));
  });

  await t.test('로그인 기기 목록과 원격 로그아웃', async () => {
    const a = await s.login('director1', 'secret12', 'dir-pc', '원장실 PC');
    const b = await s.login('director1', 'secret12', 'dir-home', '집 노트북');
    const list = await rq('GET', '/api/me/devices', { token: a });
    assert.equal(list.data.devices.length, 2, '같은 기기에서 다시 로그인하면 하나로 합침');
    const home = list.data.devices.find((d) => d.deviceName === '집 노트북');
    assert.equal(list.data.devices.find((d) => d.current).deviceName, '원장실 PC');
    await rq('DELETE', `/api/me/devices/${home.id}`, { token: a });
    assert.equal((await rq('GET', '/api/me', { token: b })).status, 401);
    assert.equal((await rq('GET', '/api/me', { token: a })).status, 200);
  });

  await t.test('마지막 운영자는 지우거나 중지할 수 없음', async () => {
    const adminNow = await s.login('admin', 'admin-new-1', 'admin-pc');
    const second = await rq('POST', '/api/users', { token: adminNow, body: { role: 'admin', name: '부운영자', username: 'admin2', password: 'admin2pw' } });
    assert.equal(second.status, 200);
    const admin2 = await s.login('admin2', 'admin2pw');
    const meId = (await rq('GET', '/api/me', { token: adminNow })).data.user.id;
    assert.equal((await rq('DELETE', `/api/users/${meId}`, { token: adminNow })).status, 403, '자기 자신은 못 지움');
    assert.equal((await rq('DELETE', `/api/users/${second.data.user.id}`, { token: adminNow })).status, 200);
    assert.equal((await rq('GET', '/api/me', { token: admin2 })).status, 401);
  });

  await t.test('활동 기록 (운영자만)', async () => {
    const adminNow = await s.login('admin', 'admin-new-1', 'admin-pc');
    const r = await rq('GET', '/api/audit?limit=200', { token: adminNow });
    assert.equal(r.status, 200);
    const actions = new Set(r.data.entries.map((e) => e.action));
    for (const a of ['code.create', 'signup', 'user.create', 'user.delete', 'user.password_reset', 'user.suspend', 'me.username', 'login.failed']) {
      assert.ok(actions.has(a), `활동 기록에 ${a}`);
    }
    const dirNow = await s.login('director1', 'secret12', 'dir-pc');
    assert.equal((await rq('GET', '/api/audit', { token: dirNow })).status, 403);
  });

  await t.test('로그인을 너무 많이 틀리면 잠시 막음', async () => {
    let last;
    for (let i = 0; i < 9; i += 1) {
      last = await rq('POST', '/api/auth/login', { body: { username: 'director1', password: 'wrong-pw' } });
    }
    assert.equal(last.status, 429);
    assert.equal(last.data.error.code, 'rate_limited');
  });
});

test('공지사항과 프로그램별 사용 권한', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { request: rq } = s;
  const admin = await s.login('admin', ADMIN_PASSWORD);

  const mk = async (body) => {
    const r = await rq('POST', '/api/users', { token: admin, body: { password: 'pass1234', mustChangePassword: false, ...body } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.user;
  };
  const dirA = await mk({ role: 'director', name: 'A원장', username: 'dira', academyName: 'A학원', allowedApps: ['ohdapnote'] });
  await mk({ role: 'director', name: 'B원장', username: 'dirb', academyName: 'B학원' });
  const a = await s.login('dira', 'pass1234');
  const b = await s.login('dirb', 'pass1234');

  await t.test('전체 공지와 학원 공지', async () => {
    await rq('POST', '/api/notices', { token: admin, body: { title: '서버 점검', body: '토요일 밤에 점검해요', pinned: true } });
    const own = await rq('POST', '/api/notices', { token: a, body: { title: 'A학원 회의', body: '금요일 7시', academyId: null } });
    assert.equal(own.data.notice.academy.id, dirA.academy.id, '원장 공지는 항상 자기 학원');
    const na = await rq('GET', '/api/notices', { token: a });
    const nb = await rq('GET', '/api/notices', { token: b });
    assert.deepEqual(na.data.notices.map((n) => n.title), ['서버 점검', 'A학원 회의']);
    assert.deepEqual(nb.data.notices.map((n) => n.title), ['서버 점검']);
    assert.equal(na.data.notices[0].editable, false);
    assert.equal(na.data.notices[1].editable, true);
    assert.equal((await rq('DELETE', `/api/notices/${own.data.notice.id}`, { token: b })).status, 403);
    assert.equal((await rq('DELETE', `/api/notices/${own.data.notice.id}`, { token: a })).status, 200);
  });

  await t.test('쓸 수 있는 프로그램만 보이고, 원장은 자기 권한 안에서만 줄 수 있음', async () => {
    const appsA = await rq('GET', '/api/apps', { token: a });
    assert.deepEqual(appsA.data.apps.map((x) => x.id), ['ohdapnote']);
    const appsB = await rq('GET', '/api/apps', { token: b });
    assert.deepEqual(appsB.data.apps.map((x) => x.id).sort(), ['ohdapnote', 'tajong', 'tajong-android']);

    const bad = await rq('POST', '/api/users', { token: a, body: { name: 'T', username: 'tt1', allowedApps: ['tajong'] } });
    assert.equal(bad.status, 403);
    const badAll = await rq('POST', '/api/users', { token: a, body: { name: 'T', username: 'tt1', allowedApps: null } });
    assert.equal(badAll.status, 403);
    const ok = await rq('POST', '/api/users', { token: a, body: { name: 'T', username: 'tt1', allowedApps: ['ohdapnote'] } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.data.user.allowedApps, ['ohdapnote']);

    const tick = await rq('POST', '/api/apps/tajong/ticket', { token: a });
    assert.equal(tick.status, 403);
    const sync = await rq('GET', '/api/sync/tajong', { token: a });
    assert.equal(sync.status, 403);
  });

  await t.test('저장 용량은 운영자만 바꿈', async () => {
    const list = await rq('GET', '/api/users', { token: a });
    const teacher = list.data.users.find((u) => u.username === 'tt1');
    assert.equal((await rq('PATCH', `/api/users/${teacher.id}`, { token: a, body: { quotaMb: 10 } })).status, 403);
    const r = await rq('PATCH', `/api/users/${teacher.id}`, { token: admin, body: { quotaMb: 10 } });
    assert.equal(r.data.user.quotaBytes, 10 * 1024 * 1024);
    const st = await rq('GET', '/api/admin/stats', { token: admin });
    assert.equal(st.data.users.director, 2);
  });
});
