'use strict';

// 학원 학생 명단·학원 공용 AI·학원 공간의 학생 폴더 (students.js, routes/students.js, sharing.js)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openEvents, settleEvents } = require('./event-helpers');
const { startServer, ADMIN_PASSWORD } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;

/** 원장 A·B(다른 학원), A학원 선생님 둘 */
async function setup(s) {
  const rq = s.request;
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const mk = async (token, body) => {
    const r = await rq('POST', '/api/users', { token, body: { password: 'pass1234', mustChangePassword: false, ...body } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.user;
  };
  const da = await mk(admin, { role: 'director', name: 'A원장', username: 'dira', academyName: 'A학원' });
  const db = await mk(admin, { role: 'director', name: 'B원장', username: 'dirb', academyName: 'B학원' });
  const dirA = await s.login('dira', 'pass1234');
  const dirB = await s.login('dirb', 'pass1234');
  const u1 = await mk(dirA, { name: '김선생', username: 'teach1' });
  const u2 = await mk(dirA, { name: '이선생', username: 'teach2' });
  const t1 = await s.login('teach1', 'pass1234');
  const t2 = await s.login('teach2', 'pass1234', 'dev-2');
  return { admin, dirA, dirB, t1, t2, u1, u2, da, db, acaA: da.academy.id, acaB: db.academy.id };
}

const q = (p) => encodeURIComponent(p);

test('학생 명단: 학원 사람 누구나 추가·수정·삭제·되살리기', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const rq = s.request;
  const { admin, dirA, dirB, t1, t2, u1, u2, acaA } = await setup(s);
  let sid;

  await t.test('추가: 만든 사람, 담당 선생님', async () => {
    const r = await rq('POST', '/api/students', { token: t1, body: { name: ' 홍길동 ', school: '마고고', grade: '고1', teacherId: u1.id, memo: '수학' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.existed, false);
    const st = r.data.student;
    sid = st.id;
    assert.equal(st.name, '홍길동');
    assert.deepEqual([st.school, st.grade, st.memo, st.rev], ['마고고', '고1', '수학', 1]);
    assert.deepEqual(st.teacher, { id: u1.id, name: '김선생' });
    assert.deepEqual(st.createdBy, { id: u1.id, name: '김선생' });
    assert.equal(st.deletedAt, null);

    assert.equal((await rq('POST', '/api/students', { token: t1, body: { name: '  ' } })).status, 400);
    const other = await rq('POST', '/api/students', { token: dirB, body: { name: '남', teacherId: u1.id } });
    assert.equal(other.status, 400, '다른 학원 선생님은 담당으로 못 고름');
    assert.equal(other.data.error.code, 'invalid_teacher');
  });

  await t.test('수정: 다른 선생님도, 담당 바꾸기, 먼저 바뀌었으면 409', async () => {
    const r = await rq('PATCH', `/api/students/${sid}`, { token: t2, body: { teacherId: u2.id, baseRev: 1 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.student.rev, 2);
    assert.deepEqual(r.data.student.teacher, { id: u2.id, name: '이선생' });
    assert.deepEqual(r.data.student.updatedBy, { id: u2.id, name: '이선생' });
    assert.equal(r.data.student.school, '마고고', '보내지 않은 칸은 그대로');

    const late = await rq('PATCH', `/api/students/${sid}`, { token: t1, body: { memo: '늦게', baseRev: 1 } });
    assert.equal(late.status, 409);
    assert.equal(late.data.error.code, 'conflict');
    assert.equal(late.data.error.student.rev, 2, '지금 것을 같이 돌려줌');

    const clear = await rq('PATCH', `/api/students/${sid}`, { token: dirA, body: { teacherId: null } });
    assert.equal(clear.status, 200, 'baseRev 없이도 고칠 수 있음');
    assert.equal(clear.data.student.teacher, null);
    assert.equal((await rq('PATCH', `/api/students/${sid}`, { token: dirB, body: { name: 'x' } })).status, 404, '다른 학원 학생은 없음');
  });

  await t.test('목록: 자기 학원만, 운영자는 학원을 골라서', async () => {
    const a = await rq('GET', '/api/students', { token: t2 });
    assert.equal(a.status, 200);
    assert.equal(a.data.academyId, acaA);
    assert.equal(a.data.purgeDays, 30);
    assert.deepEqual(a.data.students.map((x) => x.name), ['홍길동']);
    assert.deepEqual((await rq('GET', '/api/students', { token: dirB })).data.students, []);

    const noAca = await rq('GET', '/api/students', { token: admin });
    assert.equal(noAca.status, 400);
    assert.equal(noAca.data.error.code, 'academy_required');
    const byAdmin = await rq('GET', `/api/students?academy=${acaA}`, { token: admin });
    assert.deepEqual(byAdmin.data.students.map((x) => x.id), [sid]);
    assert.equal((await rq('GET', '/api/students?academy=999', { token: admin })).status, 404);

    const m = await rq('GET', '/api/academy/members', { token: t1 });
    assert.deepEqual(
      m.data.members.map((x) => [x.name, x.role]),
      [
        ['A원장', 'director'],
        ['김선생', 'teacher'],
        ['이선생', 'teacher'],
      ],
    );
  });

  await t.test('ID 를 정해서 추가 (프로그램이 먼저 만든 학생): 같은 학원이면 그대로, 다른 학원이면 409', async () => {
    const r = await rq('POST', '/api/students', { token: t1, body: { id: 'stu-0000-0001', name: '김철수' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.student.id, 'stu-0000-0001');
    const again = await rq('POST', '/api/students', { token: t2, body: { id: 'stu-0000-0001', name: '다른 이름' } });
    assert.equal(again.data.existed, true);
    assert.equal(again.data.student.name, '김철수', '다시 보내도 덮어쓰지 않음');
    const taken = await rq('POST', '/api/students', { token: dirB, body: { id: 'stu-0000-0001', name: '김철수' } });
    assert.equal(taken.status, 409);
    assert.equal(taken.data.error.code, 'id_taken');
    const bad = await rq('POST', '/api/students', { token: t1, body: { id: '../x', name: '이상한 ID' } });
    assert.notEqual(bad.data.student.id, '../x', '맞지 않는 ID 는 새로 만듦');
  });

  await t.test('삭제(숨김) → 누구나 되살리기', async () => {
    const d = await rq('DELETE', `/api/students/${sid}`, { token: t2 });
    assert.equal(d.status, 200);
    assert.ok(d.data.student.deletedAt);
    assert.deepEqual(d.data.student.deletedBy, { id: u2.id, name: '이선생' });
    assert.equal(d.data.student.purgeAt, d.data.student.deletedAt + 30 * DAY);
    const listed = (await rq('GET', '/api/students', { token: t1 })).data.students.find((x) => x.id === sid);
    assert.ok(listed.deletedAt, '지운 학생도 목록에 (되살리기 화면)');

    const edit = await rq('PATCH', `/api/students/${sid}`, { token: t1, body: { memo: 'x' } });
    assert.equal(edit.status, 409);
    assert.equal(edit.data.error.code, 'student_deleted');

    const r = await rq('POST', `/api/students/${sid}/restore`, { token: t1 });
    assert.equal(r.status, 200);
    assert.equal(r.data.student.deletedAt, null);
    assert.equal(r.data.student.deletedBy, null);
    assert.equal((await rq('POST', `/api/students/${sid}/restore`, { token: dirB })).status, 404);
  });

  await t.test('바뀌면 같은 학원에 실시간 알림 (academy {kind: students})', async (t) => {
    const a = await openEvents(s.base, t2);
    t.after(() => a.close());
    const b = await openEvents(s.base, dirB);
    t.after(() => b.close());
    const r = await rq('PATCH', `/api/students/${sid}`, { token: t1, body: { grade: '고2' } });
    assert.equal(r.status, 200);
    assert.deepEqual((await a.next('academy')).data, { kind: 'students' });
    await settleEvents(s.app.deps.events, b);
    assert.equal(b.events.filter((e) => e.event === 'academy').length, 0, '다른 학원에는 알리지 않음');
  });

  await t.test('감사 기록', async () => {
    const r = await rq('GET', '/api/audit?limit=100', { token: admin });
    const actions = r.data.entries.map((x) => x.action);
    for (const a of ['student.create', 'student.update', 'student.delete', 'student.restore']) assert.ok(actions.includes(a), a);
  });
});

test('학원 공간 students/<학생 ID>/: 학원 사람 누구나 읽고 쓰기, 지운 학생은 읽기만, 완전히 지우면 PC 에서도 지워짐', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const rq = s.request;
  const { admin, dirA, dirB, t1, t2 } = await setup(s);
  const put = (token, p, body, baseRev = 0) =>
    rq('PUT', `/api/sync/ohdapnote/academy/file?path=${q(p)}&baseRev=${baseRev}`, { token, raw: Buffer.from(body) });
  const get = (token, p) => rq('GET', `/api/sync/ohdapnote/academy/file?path=${q(p)}`, { token });
  const list = async (token, since = 0) => (await rq('GET', `/api/sync/ohdapnote/academy?since=${since}`, { token })).data;

  const sid = (await rq('POST', '/api/students', { token: t1, body: { name: '홍길동' } })).data.student.id;
  const note = `students/${sid}/notes/note-0001.json`;

  await t.test('누구나 읽고 쓰기 (담당이 바뀌어도 이어서)', async () => {
    assert.equal((await put(t1, note, '{"v":1}')).status, 200);
    assert.equal((await get(t2, note)).data.toString(), '{"v":1}');
    assert.equal((await put(t2, note, '{"v":2}', 1)).status, 200, '다른 선생님도 고침');
    assert.equal((await put(dirA, note, '{"v":3}', 2)).status, 200);
    assert.ok((await list(t2)).entries.some((e) => e.path === note && e.rev === 3));
  });

  await t.test('명단에 없는 학생: 403 student_pending (되돌리지 않고 나중에 다시)', async () => {
    const r = await put(t1, 'students/no-such-student/notes/n.json', '{}');
    assert.equal(r.status, 403);
    assert.equal(r.data.error.code, 'student_pending');
    const other = await put(dirB, note, '{}', 0);
    assert.equal(other.data.error.code, 'student_pending', '다른 학원 학생도 그 학원에는 없음');
    assert.equal((await put(t1, `students/${sid}.json`, '{"name":"홍길동"}')).status, 200, '두 단계 경로는 예전처럼 교재 규칙');
  });

  await t.test('지운 학생: 읽기만 (쓰면 403 not_owner → 서버 것으로 되돌림)', async () => {
    await rq('DELETE', `/api/students/${sid}`, { token: t2 });
    assert.equal((await get(t1, note)).status, 200);
    const w = await put(t1, note, '{"v":4}', 3);
    assert.equal(w.status, 403);
    assert.equal(w.data.error.code, 'not_owner');
    const d = await rq('DELETE', `/api/sync/ohdapnote/academy/file?path=${q(note)}&baseRev=3`, { token: t1 });
    assert.equal(d.status, 403);
    await rq('POST', `/api/students/${sid}/restore`, { token: t1 });
    assert.equal((await put(t1, note, '{"v":4}', 3)).status, 200, '되살리면 다시 고침');
  });

  await t.test('지운 지 30일 지나면 완전히 지움: 자료는 삭제 표시, 명단에서는 purged', async () => {
    assert.equal((await put(t1, `students/${sid}/photo.png`, 'PNG')).status, 200);
    const tajong = await rq('PUT', `/api/sync/tajong/academy/file?path=${q(`students/${sid}/x.json`)}&baseRev=0`, { token: t1, raw: Buffer.from('T') });
    assert.equal(tajong.status, 200, '다른 프로그램의 학생 폴더');
    const before = await list(t2);
    await rq('DELETE', `/api/students/${sid}`, { token: t1 });

    const st = s.app.deps.students;
    assert.deepEqual(st.purgeExpired(), { students: 0, files: 0 }, '아직 날짜가 안 됨');
    s.app.deps.db.run('UPDATE students SET deleted_at = ? WHERE id = ?', Date.now() - 31 * DAY, sid);
    assert.deepEqual(st.purgeExpired(), { students: 1, files: 4 }, '노트·사진·예전 학생 파일·타종 파일');
    assert.deepEqual(st.purgeExpired(), { students: 0, files: 0 }, '한 번만');

    const after = await list(t2, before.seq);
    assert.deepEqual(
      after.entries.map((e) => [e.path, e.deleted]).sort(),
      [
        [`students/${sid}.json`, true],
        [`students/${sid}/notes/note-0001.json`, true],
        [`students/${sid}/photo.png`, true],
      ],
      '지운 항목은 볼 권한과 상관없이 넘김',
    );
    const roster = (await rq('GET', '/api/students', { token: t1 })).data;
    assert.ok(!roster.students.some((x) => x.id === sid));
    assert.deepEqual(roster.purged, [sid]);
    assert.equal((await rq('POST', `/api/students/${sid}/restore`, { token: t1 })).status, 404, '완전히 지운 학생은 되살릴 수 없음');
    const w = await put(t1, note, '{}', 5);
    assert.equal(w.data.error.code, 'not_owner');
    assert.equal((await get(t1, note)).status, 403);
    const audit = (await rq('GET', '/api/audit?limit=100', { token: admin })).data.entries;
    assert.ok(audit.some((x) => x.action === 'student.purge'));
  });
});

test('학원 공용 AI: 기본 하나 + 프로그램마다 따로, 원장만 고치고 학원 사람 누구나 씀', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const rq = s.request;
  const { admin, dirA, dirB, t1, acaA } = await setup(s);
  const put = (token, body) => rq('PUT', '/api/academy/ai', { token, body });

  await t.test('원장·운영자만 고침', async () => {
    assert.equal((await put(t1, { app: '', config: { provider: 'gemini', apiKey: 'k' } })).status, 403);
    assert.equal((await rq('GET', '/api/academy/ai/all', { token: t1 })).status, 403);
    const bad = await put(dirA, { app: '', config: { provider: 'gpt', apiKey: 'k' } });
    assert.equal(bad.data.error.code, 'invalid_provider');
    assert.equal((await put(dirA, { app: '', config: { provider: 'gemini' } })).data.error.code, 'invalid_key');
    assert.equal((await put(dirA, { app: 'no-app', config: { provider: 'gemini', apiKey: 'k' } })).status, 404);
  });

  await t.test('기본 AI: 키는 끝 4자리만 보이고, 프로그램에는 키 없이 (서버가 중계)', async () => {
    const r = await put(dirA, { app: '', config: { provider: 'gemini', apiKey: 'AIza-default-1234', model: 'gemini-flash' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.default.keyHint, '••••1234');
    assert.equal(r.data.default.apiKey, undefined);
    assert.ok(r.data.programs.some((p) => p.id === 'ohdapnote'));
    assert.ok(!r.data.programs.some((p) => p.id === 'mago-navi'), '꺼진 프로그램은 빼고 (처음에는 마고 과목내비가 꺼져 있음)');
    assert.ok(!r.data.programs.some((p) => p.id === 'tajong-android'), '휴대폰 프로그램은 빼고');

    const g = await rq('GET', '/api/academy/ai?app=ohdapnote', { token: t1 });
    assert.equal(g.status, 200);
    assert.deepEqual({ ...g.data.ai }, { provider: 'gemini', model: 'gemini-flash', model2: '', rpm: null, source: 'default', hasKey: true, relay: true });
    assert.ok(!JSON.stringify(g.data).includes('AIza'), '선생님에게 키가 가지 않음');
    assert.equal(s.app.deps.students.aiFor(acaA, 'ohdapnote').apiKey, 'AIza-default-1234', '키는 서버에');
    assert.equal((await rq('GET', '/api/academy/ai', { token: dirB })).data.ai, null, '다른 학원은 없음');

    const raw = s.app.deps.db.all('SELECT config_enc FROM academy_ai').map((x) => x.config_enc).join();
    assert.ok(!raw.includes('AIza'), 'DB 에는 암호화해서');
    assert.ok(fs.existsSync(path.join(s.dataDir, 'keys', 'ai.key')));
  });

  await t.test('프로그램마다 따로 정하기, 키를 다시 안 보내면 그대로', async () => {
    const r = await put(dirA, { app: 'ohdapnote', config: { provider: 'anthropic', apiKey: 'sk-ant-5678' } });
    assert.equal(r.data.apps.ohdapnote.keyHint, '••••5678');
    assert.equal((await rq('GET', '/api/academy/ai?app=ohdapnote', { token: t1 })).data.ai.source, 'app');
    assert.equal((await rq('GET', '/api/academy/ai?app=tajong', { token: t1 })).data.ai.source, 'default', '안 정한 프로그램은 기본');

    await put(dirA, { app: 'ohdapnote', config: { provider: 'anthropic', model: 'claude-x' } });
    const g = (await rq('GET', '/api/academy/ai?app=ohdapnote', { token: t1 })).data.ai;
    assert.deepEqual([g.hasKey, g.model], [true, 'claude-x']);
    assert.equal(s.app.deps.students.aiFor(acaA, 'ohdapnote').apiKey, 'sk-ant-5678');

    const byAdmin = await rq('PUT', `/api/academy/ai?academy=${acaA}`, { token: admin, body: { app: 'ohdapnote', config: null } });
    assert.equal(byAdmin.status, 200);
    assert.deepEqual(byAdmin.data.apps, {});
    assert.equal((await rq('GET', '/api/academy/ai?app=ohdapnote', { token: t1 })).data.ai.source, 'default', '지우면 다시 기본');
  });

  await t.test('OpenAI 호환은 주소만 있어도 됨 (학원 안 주소는 각 PC 에서 바로)', async () => {
    const r = await put(dirA, { app: 'tajong', config: { provider: 'openai', baseUrl: 'http://192.168.0.10:11434/v1', rpm: 30 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const g = (await rq('GET', '/api/academy/ai?app=tajong', { token: t1 })).data.ai;
    assert.deepEqual([g.provider, g.hasKey, g.baseUrl, g.rpm, g.direct, g.relay], ['openai', false, 'http://192.168.0.10:11434/v1', 30, true, undefined]);
    assert.equal((await put(dirA, { app: 'tajong', config: { provider: 'openai', baseUrl: 'ftp://x' } })).data.error.code, 'invalid_url');
  });

  await t.test('권한이 없는 프로그램의 AI 는 받을 수 없음', async () => {
    const u = (await rq('GET', '/api/users', { token: dirA })).data.users.find((x) => x.username === 'teach1');
    assert.equal((await rq('PATCH', `/api/users/${u.id}`, { token: dirA, body: { allowedApps: ['tajong'] } })).status, 200);
    assert.equal((await rq('GET', '/api/academy/ai?app=ohdapnote', { token: t1 })).status, 403);
    assert.equal((await rq('GET', '/api/academy/ai?app=tajong', { token: t1 })).status, 200);
  });
});

test('예전 오답노트(0.3) 데이터: 학생 파일·학원 키 가져오기, 노트를 학생 폴더로 옮기기', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const rq = s.request;
  const { dirA, t1, t2, u1, acaA } = await setup(s);
  const put = (token, p, body, baseRev = 0) =>
    rq('PUT', `/api/sync/ohdapnote/academy/file?path=${q(p)}&baseRev=${baseRev}`, { token, raw: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
  const list = async (token, since = 0) => (await rq('GET', `/api/sync/ohdapnote/academy?since=${since}`, { token })).data;
  const st = s.app.deps.students;
  const roster = async () => (await rq('GET', '/api/students', { token: t2 })).data.students;

  await t.test('0.3 이 올린 학생 파일은 같은 ID 로 명단에 (원래 파일은 그대로)', async () => {
    const legacy = { id: 'old-0000-0001', name: '김철수', school: '마고중', grade: '중3', memo: '', createdBy: { id: u1.id, name: '김선생' }, createdAt: 1700000000000 };
    assert.equal((await put(t1, 'students/old-0000-0001.json', legacy)).status, 200);
    const r = (await roster()).find((x) => x.id === 'old-0000-0001');
    assert.ok(r, JSON.stringify(await roster()));
    assert.deepEqual([r.name, r.school, r.grade, r.createdAt], ['김철수', '마고중', '중3', 1700000000000]);
    assert.deepEqual(r.createdBy, { id: u1.id, name: '김선생' });
    assert.ok((await list(t2)).entries.some((e) => e.path === 'students/old-0000-0001.json' && !e.deleted));

    // 0.3 이 다시 고쳐 올려도 명단은 덮어쓰지 않음
    assert.equal((await put(t1, 'students/old-0000-0001.json', { ...legacy, name: '바뀐 이름' }, 1)).status, 200);
    assert.equal((await roster()).find((x) => x.id === 'old-0000-0001').name, '김철수');
    assert.equal((await put(t1, 'students/no-name-0001.json', { id: 'no-name-0001' })).status, 200);
    assert.ok(!(await roster()).some((x) => x.id === 'no-name-0001'), '이름 없는 파일은 넘김');
  });

  await t.test('서버를 켤 때 가져오기: 예전 학생 + academy.json 키 (다시 해도 그대로)', async () => {
    // 이 서버가 생기기 전에 올라온 것처럼: 명단에서 빼고 다시 가져오기
    s.app.deps.db.run("DELETE FROM students WHERE id = 'old-0000-0001'");
    assert.equal((await put(dirA, 'academy.json', { ai: { geminiApiKey: 'gem-key-9999' } })).status, 200);
    assert.equal(st.aiFor(acaA, 'ohdapnote')?.apiKey, 'gem-key-9999', '0.3 원장이 올리자마자 학원 AI 로');
    s.app.deps.db.run('DELETE FROM academy_ai');
    assert.deepEqual(st.importLegacy(), { students: 1, ai: 1 });
    assert.deepEqual(st.importLegacy(), { students: 0, ai: 0 }, '두 번째는 아무것도 안 함');
    assert.ok((await roster()).some((x) => x.id === 'old-0000-0001'));
    const ai = (await rq('GET', '/api/academy/ai?app=ohdapnote', { token: t1 })).data.ai;
    assert.deepEqual([ai.provider, ai.hasKey, ai.source], ['gemini', true, 'default']);
    assert.equal(st.aiFor(acaA, 'ohdapnote').apiKey, 'gem-key-9999');

    // 원장이 클라우드에서 바꾼 기본 AI 는 academy.json 으로 덮어쓰지 않음
    await rq('PUT', '/api/academy/ai', { token: dirA, body: { app: '', config: { provider: 'anthropic', apiKey: 'sk-new-0000' } } });
    st.importLegacy();
    assert.equal((await rq('GET', '/api/academy/ai', { token: t1 })).data.ai.provider, 'anthropic');
  });

  await t.test('노트 옮기기: 오답노트 0.4 가 배포되기 전에는 하지 않음', async () => {
    const sid = 'old-0000-0001'; // 다시 가져와서 지금 이름은 '바뀐 이름'
    assert.equal((await roster()).find((x) => x.id === sid).name, '바뀐 이름');
    const base = `members/${u1.id}/notes`;
    assert.equal((await put(t1, `${base}/note-0001.json`, { title: 'ID 로', student: '아무개', studentId: sid })).status, 200);
    assert.equal((await put(t1, `${base}/note-0002.json`, { title: '이름으로', student: '바뀐 이름', studentId: '' })).status, 200);
    assert.equal((await put(t1, `${base}/note-0003.json`, { title: '모르는 학생', student: '없는학생' })).status, 200);
    assert.equal((await put(t1, `${base}/profile.json`, { name: '김선생' })).status, 200);
    assert.deepEqual(st.moveLegacyNotes(), { moved: 0, skipped: true });

    s.app.deps.db.run("UPDATE apps SET release = ? WHERE id = 'ohdapnote'", JSON.stringify({ version: '0.4.0' }));
    const before = await list(t2);
    assert.deepEqual(st.moveLegacyNotes(), { moved: 2, skipped: false });
    assert.deepEqual(st.moveLegacyNotes(), { moved: 0, skipped: false }, '한 번만');

    const after = await list(t2, before.seq);
    const paths = after.entries.map((e) => [e.path, e.deleted]).sort();
    assert.deepEqual(paths, [
      [`${base}/note-0001.json`, true],
      [`${base}/note-0002.json`, true],
      [`students/${sid}/notes/note-0001.json`, false],
      [`students/${sid}/notes/note-0002.json`, false],
    ]);
    const moved = after.entries.find((e) => e.path.endsWith('/notes/note-0002.json') && !e.deleted);
    assert.equal(moved.updatedBy, u1.id, '마지막으로 고친 사람은 그대로');
    const g = await rq('GET', `/api/sync/ohdapnote/academy/file?path=${q(`students/${sid}/notes/note-0002.json`)}`, { token: t2 });
    assert.equal(JSON.parse(g.data.toString()).title, '이름으로', '다른 선생님도 이제 봄');
    const left = (await list(t1)).entries.filter((e) => !e.deleted && e.path.startsWith(base)).map((e) => e.path).sort();
    assert.deepEqual(left, [`${base}/note-0003.json`, `${base}/profile.json`], '학생을 못 찾은 노트는 그대로');
  });
});

test('고침 6: 이미 쓰던 서버에 학생 표·학원 AI 표와 마고 과목내비(꺼진 채로)', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { openDb, MIGRATIONS } = require('../src/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-mig6-'));
  try {
    const file = path.join(dir, 'magoedu.db');
    const raw = new DatabaseSync(file);
    for (let i = 0; i < 5; i += 1) raw.exec(MIGRATIONS[i]);
    raw.exec('PRAGMA user_version = 5');
    raw.prepare(`INSERT INTO apps(id, name, sort, source, created_at, updated_at) VALUES ('ohdapnote', '오답노트', 2, '{"type":"local"}', 1, 1)`).run();
    raw.close();
    const db = openDb(file);
    const rows = db.all("SELECT id, platform, enabled, source, exe, sort FROM apps WHERE id LIKE 'mago-navi%' ORDER BY id");
    db.close();
    assert.deepEqual(
      rows.map((r) => [r.id, r.platform, r.enabled, JSON.parse(r.source).type, r.exe]),
      [
        ['mago-navi', 'web', 0, 'web', ''],
        ['mago-navi-pc', 'windows', 0, 'github', 'MagoNavi.exe'],
      ],
    );
    assert.equal(JSON.parse(rows[0].source).url, 'https://magonavi.milky.kr');
    assert.ok(new RegExp(JSON.parse(rows[1].source).asset).test('MagoNavi-1.0.0-win-x64.zip'));
    assert.ok(rows.every((r) => r.sort > 2), '목록 맨 뒤');

    const fresh = openDb(path.join(dir, 'fresh.db'));
    assert.equal(fresh.get('SELECT COUNT(*) AS n FROM apps').n, 0, '처음 설치하는 서버는 기본 목록에서');
    fresh.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
