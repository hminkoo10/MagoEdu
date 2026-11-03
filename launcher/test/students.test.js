'use strict';

// 학원 학생 명단·학원 AI 를 프로그램에 넘기기 (academy-info.json, 요청 op), 학생 폴더 동기화, 웹 프로그램
//   - academy-info.json: 켤 때·실시간 알림(event: academy)·학생을 고친 뒤 새로 씀
//   - 요청 op: students.save|delete|restore, sso.code (SDK saveStudent 등)
//   - students/<학생 ID>/: 명단에 아직 없으면 되돌리지 않고 미룸(student_pending), 완전히 지우면 PC 에서도 지워짐
//   - 웹 프로그램: 목록에는 보이지만 설치·동기화하지 않음

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startServer, ADMIN_PASSWORD } = require('../../server/test/helpers');
const { makeZip } = require('./lib/zipwriter');
const { ApiClient } = require('../src/core/api');
const { makePaths } = require('../src/core/paths');
const { normalizeManifest } = require('../src/core/manifest');
const { buildEnv } = require('../src/core/runner');
const { Store } = require('../src/main/store');
const { Cloud } = require('../src/main/cloud');
const sdk = require('../../sdk/node/magoedu-cloud');

const quiet = { info() {}, warn() {}, error() {} };
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `magoedu-${name}-`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 60 * 60 * 1000;
async function until(fn, ms = 6000, what = '조건') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`${what}: ${ms}ms 안에 되지 않았어요`);
    await sleep(40);
  }
}

const NOTES = { format: 1, id: 'notes', exe: 'bin/notes.sh', sync: { include: ['settings.json'] }, shared: { include: ['**'] }, academyInfo: true };
const NAVI_PC = { format: 1, id: 'navi-pc', exe: 'bin/navi.sh', sync: { include: ['settings.json'] }, sso: 'navi' };

test('매니페스트: academyInfo·sso', () => {
  const m = normalizeManifest(NOTES);
  assert.deepEqual([m.academyInfo, m.sso], [true, null]);
  assert.equal(normalizeManifest(NAVI_PC).sso, 'navi');
  assert.equal(normalizeManifest({ sso: '../x', academyInfo: 'yes' }).sso, null, '프로그램 ID 모양만');
  assert.equal(normalizeManifest({ academyInfo: 'yes' }).academyInfo, false);
});

async function setup(t) {
  const catalog = path.join(tmp('catalog'), 'catalog.json');
  fs.writeFileSync(catalog, '[]');
  const s = await startServer({ catalogFile: catalog });
  t.after(() => s.close());
  const admin = await s.login('admin', ADMIN_PASSWORD);
  const pkg = async (id, manifest, file) => {
    await s.request('POST', '/api/admin/apps', { token: admin, body: { id, name: id, source: { type: 'local' } } });
    fs.mkdirSync(path.join(s.dataDir, 'packages', id), { recursive: true });
    fs.writeFileSync(path.join(s.dataDir, 'packages', id, file), makeZip({ 'magoedu-app.json': JSON.stringify({ ...manifest, version: '1.0.0' }), [manifest.exe]: '#!/bin/sh\n' }));
    await s.request('POST', '/api/admin/apps/refresh', { token: admin, body: { id } });
  };
  await pkg('notes', NOTES, 'Notes-1.0.0-win-x64.zip');
  await pkg('navi-pc', NAVI_PC, 'Navi-1.0.0-win-x64.zip');
  const web = await s.request('POST', '/api/admin/apps', { token: admin, body: { id: 'navi', name: '과목내비', platform: 'web', url: 'https://navi.example.com' } });
  assert.equal(web.status, 200, JSON.stringify(web.data));
  const mk = async (token, body) => {
    const r = await s.request('POST', '/api/users', { token, body: { password: 'pass1234', mustChangePassword: false, ...body } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.user;
  };
  await mk(admin, { role: 'director', name: '원장', username: 'boss', academyName: '마고' });
  const boss = await s.login('boss', 'pass1234');
  await mk(boss, { name: '김선생', username: 'kim' });
  await mk(boss, { name: '이선생', username: 'lee' });

  const root = tmp('students');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = makePaths({ userData: path.join(root, 'roaming'), localData: path.join(root, 'local') });
  const store = new Store({ paths, defaults: { serverUrl: s.base } });
  const cloud = new Cloud({ paths, store, version: '1.2.0', log: quiet });
  t.after(() => cloud.shutdown());
  await cloud.init();
  await cloud.login('kim', 'pass1234');
  await cloud.install('notes');
  await cloud.install('navi-pc');
  await until(() => cloud.events?.connected, 4000, '실시간 연결');

  const lee = new ApiClient({ serverUrl: s.base, device: { id: 'lee-pc', name: 'lee', platform: 'test', version: '1' } });
  await lee.login('lee', 'pass1234');
  const bossApi = new ApiClient({ serverUrl: s.base, device: { id: 'boss-pc', name: 'boss', platform: 'test', version: '1' } });
  await bossApi.login('boss', 'pass1234');
  return { s, cloud, paths, lee, bossApi };
}

test('통합 클라우드: 학원 학생 명단을 프로그램에 넘기고, 프로그램 부탁으로 학생을 고침', async (t) => {
  const { s, cloud, paths, lee, bossApi } = await setup(t);
  const dirs = paths.account(cloud.user.id).app('notes');
  const session = { requestDir: dirs.requests, academyInfoFile: dirs.academyInfo, academyDir: dirs.academy };
  const info = () => sdk.academyInfo(session);
  // 테스트에서는 프로그램을 실제로 켜지 않으므로 켜져 있는 것으로
  cloud.runner.isRunning = (id) => id === 'notes';
  let sid;

  await t.test('지켜보기: 학생 명단·로그인 코드만 쓰는 프로그램도 요청 폴더', () => {
    assert.equal(cloud.watchers.get('notes').length, 3, '동기화·학원 공간·요청');
    assert.equal(cloud.watchers.get('navi-pc').length, 2, '동기화·요청');
    assert.deepEqual([cloud._usesRequests('notes'), cloud._usesRequests('navi-pc')], [true, true]);
  });

  await t.test('academy-info.json: 학원·사람·학생·학원 AI', async () => {
    await cloud._writeAcademyInfo('notes');
    const i = info();
    assert.equal(i.format, 1);
    assert.equal(i.academy.name, '마고');
    assert.deepEqual([i.me.name, i.me.role], ['김선생', 'teacher']);
    assert.deepEqual(i.members.map((m) => m.name).sort(), ['김선생', '원장', '이선생']);
    assert.deepEqual([i.students, i.purged, i.purgeDays, i.ai], [[], [], 30, null]);
    assert.ok(!fs.existsSync(paths.account(cloud.user.id).app('navi-pc').academyInfo), 'academyInfo 가 없는 프로그램에는 쓰지 않음');
  });

  await t.test('다른 사람이 학생·학원 AI 를 바꾸면 실시간으로 다시 씀', async () => {
    const stamp = cloud.academyStamp;
    await lee.post('/api/students', { name: '김철수', grade: '고1' });
    await bossApi.request('PUT', '/api/academy/ai', { json: { app: '', config: { provider: 'gemini', apiKey: 'academy-key-1234' } } });
    await until(() => info()?.students.length === 1 && info()?.ai, 5000, '새 명단');
    assert.equal(info().students[0].name, '김철수');
    assert.deepEqual([info().ai.provider, info().ai.hasKey, info().ai.relay, info().ai.source], ['gemini', true, true, 'default']);
    assert.ok(!JSON.stringify(info()).includes('academy-key-1234'), '선생님 PC 에는 키가 가지 않음 (서버가 중계)');
    const ai = sdk.academyAi({ ...session, appId: 'ohdapnote', server: 'https://cloud.test/', ticket: 'MGT1.t' });
    assert.deepEqual([ai.provider, ai.apiKey, ai.baseUrl], ['gemini', 'MGT1.t', 'https://cloud.test/api/ai/relay/ohdapnote'], '프로그램은 중계 주소 + 실행 허가증으로');
    assert.ok(cloud.academyStamp >= stamp + 2, '화면도 다시 불러오게');
    assert.equal(cloud.snapshot().academyStamp, cloud.academyStamp);
  });

  await t.test('SDK saveStudent·deleteStudent·restoreStudent → 서버 명단, 바로 새 파일', async () => {
    const r = await sdk.saveStudent(session, { id: 'stu-from-app-1', name: '홍길동', teacher: { id: cloud.user.id } }, { timeoutMs: 8000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    sid = r.student.id;
    assert.equal(sid, 'stu-from-app-1', '프로그램이 정한 ID 로');
    assert.deepEqual(r.student.teacher, { id: cloud.user.id, name: '김선생' });
    assert.ok(info().students.some((x) => x.id === sid), '답하기 전에 academy-info.json 도 새로');

    const up = await sdk.saveStudent(session, { ...r.student, grade: '고2' }, { timeoutMs: 8000 });
    assert.deepEqual([up.ok, up.student.rev, up.student.grade], [true, 2, '고2']);
    const stale = await sdk.saveStudent(session, { ...r.student, memo: '늦게' }, { timeoutMs: 8000 });
    assert.deepEqual([stale.ok, stale.errorCode, stale.student.rev], [false, 'conflict', 2], '먼저 고친 것을 돌려줌');

    const gone = (await sdk.deleteStudent(session, sid, { timeoutMs: 8000 })).student;
    assert.ok(gone.deletedAt);
    const del = await sdk.saveStudent(session, { ...gone, memo: 'x' }, { timeoutMs: 8000 });
    assert.equal(del.errorCode, 'student_deleted');
    assert.equal((await sdk.restoreStudent(session, sid, { timeoutMs: 8000 })).student.deletedAt, null);
    const bad = await sdk.saveStudent(session, { name: '' }, { timeoutMs: 8000 });
    assert.deepEqual([bad.ok, bad.errorCode], [false, 'invalid_name']);
    assert.deepEqual(fs.readdirSync(dirs.requests), [], '요청·답 모두 정리');
  });

  await t.test('학생 폴더: 명단에 없는 학생은 되돌리지 않고 미뤘다가, 명단에 생기면 올림', async () => {
    const write = (rel, text) => {
      const f = path.join(dirs.academy, ...rel.split('/'));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    };
    write(`students/${sid}/notes/n1.json`, '{"v":1}');
    write('students/later-0000-0001/notes/n2.json', '{"v":2}');
    await until(() => !Object.keys(cloud._syncing).length && !cloud.syncQueue.size && cloud.syncInfo.notes?.status, 6000, '동기화');
    await cloud.syncApp('notes', { quiet: true });
    assert.equal(cloud.syncInfo.notes.status, 'ok', JSON.stringify(cloud.syncInfo.notes.errors));
    assert.ok(fs.existsSync(path.join(dirs.academy, 'students', 'later-0000-0001', 'notes', 'n2.json')), '지우거나 되돌리지 않음');
    const has = async (p) => (await lee.get('/api/sync/notes/academy')).entries.some((e) => e.path === p && !e.deleted);
    assert.ok(await has(`students/${sid}/notes/n1.json`), '다른 선생님도 받음');
    assert.ok(!(await has('students/later-0000-0001/notes/n2.json')));

    await lee.post('/api/students', { id: 'later-0000-0001', name: '나중학생' });
    await cloud.syncApp('notes', { quiet: true });
    assert.ok(await has('students/later-0000-0001/notes/n2.json'), '다음 동기화에서 올림');
  });

  await t.test('완전히 지운 학생: PC 의 학생 폴더도 지워지고 명단에서는 purged', async () => {
    await lee.del(`/api/students/${sid}`);
    s.app.deps.db.run('UPDATE students SET deleted_at = ? WHERE id = ?', Date.now() - 31 * DAY, sid);
    s.app.deps.students.purgeExpired();
    const f = path.join(dirs.academy, 'students', sid, 'notes', 'n1.json');
    await until(() => !fs.existsSync(f), 6000, '실시간으로 지우기');
    await until(() => info()?.purged.includes(sid), 6000, '명단 파일');
    assert.ok(!info().students.some((x) => x.id === sid));
  });
});

test('통합 클라우드: 웹 프로그램 (로그인 코드·목록·설치하지 않음)', async (t) => {
  const { cloud, paths } = await setup(t);

  await t.test('목록에는 주소와 함께, 설치·동기화는 하지 않음', async () => {
    const navi = cloud.snapshot().apps.find((a) => a.id === 'navi');
    assert.deepEqual([navi.platform, navi.url, navi.installed], ['web', 'https://navi.example.com', null]);
    await assert.rejects(cloud.install('navi'), /웹 프로그램/);
    await assert.rejects(cloud.launch('navi'), /브라우저/);
    assert.ok(!cloud._syncIds().includes('navi'));
  });

  await t.test('sso 프로그램: 켤 때 일회용 코드, 실행 중에는 SDK ssoCode', async () => {
    const r = await cloud._ssoCode('navi');
    assert.match(r.ssoCode, /^msc_/);
    const dirs = paths.account(cloud.user.id).app('navi-pc');
    const env = buildEnv({ base: {}, ticket: 't', appId: 'navi-pc', user: cloud.user, appDirs: dirs, requests: true, ssoCode: r.ssoCode, serverUrl: 'x', launcherVersion: '1', trustFile: 'x' });
    assert.deepEqual([env.MAGOEDU_SSO_CODE, env.MAGOEDU_REQUEST_DIR, env.MAGOEDU_ACADEMY_INFO, env.MAGOEDU_ACADEMY_DIR], [r.ssoCode, dirs.requests, '', '']);

    const again = await sdk.ssoCode({ requestDir: dirs.requests }, { timeoutMs: 8000 });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.match(again.code, /^msc_/);
    assert.notEqual(again.code, r.ssoCode);
    const no = await sdk.saveStudent({ requestDir: dirs.requests }, { name: 'x' }, { timeoutMs: 8000 });
    assert.equal(no.ok, false);
    assert.match(no.error, /학생 명단을 쓰지 않아요/, '매니페스트에 academyInfo 가 없으면');
  });

  await t.test('예전 통합 클라우드(1.2.0 보다 낮음)에는 웹 프로그램이 보이지 않음', async () => {
    const old = new ApiClient({ serverUrl: cloud.api.serverUrl, device: { id: 'old-pc', name: 'old', platform: 'win32', version: '1.1.2' } });
    await old.login('kim', 'pass1234');
    assert.ok(!(await old.get('/api/apps')).apps.some((a) => a.id === 'navi'));
  });
});
