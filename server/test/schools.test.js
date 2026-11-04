'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchSchools, createSchoolSearch } = require('../src/schools');
const { loadConfig } = require('../src/app');
const { startServer, ADMIN_PASSWORD } = require('./helpers');

const row = (kind = '중학교', extra = {}) => ({ ATPT_OFCDC_SC_CODE: 'B10', SD_SCHUL_CODE: '7010001',
  SCHUL_NM: '마고학교', SCHUL_KND_SC_NM: kind, ATPT_OFCDC_SC_NM: '서울특별시교육청', ORG_RDNMA: '서울 학교길 1', ...extra });
const response = (rows) => ({ schoolInfo: [{ head: [{ RESULT: { CODE: 'INFO-000' } }] }, { row: rows }] });
const fake = (data) => async () => ({ ok: true, json: async () => data });

test('NEIS: 초·중·고만, 같은 코드·지역 규칙, 키 선택·8초 제한', async (t) => {
  t.mock.method(AbortSignal, 'timeout', (ms) => { assert.equal(ms, 8000); return new AbortController().signal; });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(new URL(url));
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => response([
      row('초등학교'), row(), row('고등학교', { ATPT_OFCDC_SC_NM: '전남광주통합특별시교육청(광주)' }),
      row('유치원'), row('특수학교'), row('중학교', { SD_SCHUL_CODE: 7010001 }), row('중학교', { ATPT_OFCDC_SC_CODE: '' }),
    ]) };
  };
  const schools = await searchSchools('마고', '', fetchImpl);
  assert.deepEqual(schools.map((s) => s.kind), ['초등학교', '중학교', '고등학교']);
  assert.deepEqual(schools[1], { office: 'B10', code: '7010001', name: '마고학교', kind: '중학교', region: '서울', address: '서울 학교길 1' });
  assert.equal(schools[2].region, '광주');
  assert.equal(calls[0].origin + calls[0].pathname, 'https://open.neis.go.kr/hub/schoolInfo');
  assert.deepEqual(Object.fromEntries(calls[0].searchParams), { Type: 'json', pIndex: '1', pSize: '10', SCHUL_NM: '마고' });
  await searchSchools('마고', 'test-key', fetchImpl);
  assert.equal(calls[1].searchParams.get('KEY'), 'test-key');
  assert.equal(loadConfig({ NEIS_API_KEY: 'env-key' }).neisApiKey, 'env-key');
});

test('학교 검색: 검증·사용자별 40회 제한(캐시 포함)·시간창 초기화', async () => {
  let now = 0, calls = 0;
  const search = createSchoolSearch({ now: () => now, fetchImpl: async () => { calls++; return { ok: true, json: async () => response([row()]) }; } });
  for (const q of ['', '가', '가'.repeat(21), '학교%', '가\n나', '학교😀']) {
    await assert.rejects(search('teacher-a', q), (e) => e.status === 400);
  }
  for (let i = 0; i < 40; i++) await search('teacher-a', ' 마고 ');
  assert.equal(calls, 1);
  await assert.rejects(search('teacher-a', '마고'), (e) => e.status === 429);
  await search('teacher-b', '마고');
  now = 60001;
  await search('teacher-a', '마고');
  assert.equal(calls, 1);
});

test('학교 검색: bounded LRU·만료·빈 결과 캐시', async () => {
  let now = 0, calls = 0;
  const search = createSchoolSearch({ cacheSize: 2, cacheTtlMs: 100, now: () => now,
    fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ RESULT: { CODE: 'INFO-200' } }) }; } });
  await search('u', '가나'); await search('u', '다라'); await search('u', '가나');
  assert.equal(calls, 2);
  await search('u', '마바'); await search('u', '다라');
  assert.equal(calls, 4, '가장 오래 안 쓴 검색어만 제거');
  now = 101;
  await search('u', '다라');
  assert.equal(calls, 5);
});

test('학교 검색: HTTP·NEIS 오류·잘못된 JSON·시간 초과는 502, 오류 캐시 없음', async () => {
  const failures = [
    async () => ({ ok: false, status: 503 }),
    fake({ RESULT: { CODE: 'ERROR-300' } }),
    fake({ schoolInfo: [{ head: [{ RESULT: { CODE: 'ERROR-500' } }] }, { row: [] }] }),
    fake({}), fake({ schoolInfo: [{}, { row: 'invalid' }] }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('json'); } }),
    async () => { throw new DOMException('timeout', 'TimeoutError'); },
  ];
  for (const fetchImpl of failures) {
    let calls = 0;
    const search = createSchoolSearch({ fetchImpl: (...args) => { calls++; return fetchImpl(...args); } });
    for (let i = 0; i < 2; i++) await assert.rejects(search('u', '마고'), (e) => e.status === 502 && e.message === '학교 검색 서버에 연결하지 못했어요.');
    assert.equal(calls, 2);
  }
});

test('학교 검색 경로: 로그인·직원 권한, 학생 차단', async (t) => {
  const s = await startServer({ neisFetch: fake(response([row()])) });
  t.after(() => s.close());
  const url = '/api/schools/search?q=' + encodeURIComponent('마고');
  assert.equal((await s.request('GET', url)).status, 401);
  const admin = await s.login('admin', ADMIN_PASSWORD);
  assert.equal((await s.request('GET', url, { token: admin })).data.schools[0].office, 'B10');
  const director = (await s.request('POST', '/api/users', { token: admin, body: { username: 'school-dir', name: '원장', role: 'director', academyName: '학교학원', password: 'pass1234', mustChangePassword: false } })).data.user;
  const dir = await s.login('school-dir', 'pass1234');
  assert.equal((await s.request('GET', url, { token: dir })).status, 200);
  await s.request('POST', '/api/users', { token: dir, body: { username: 'school-teacher', name: '선생님', password: 'pass1234', mustChangePassword: false } });
  const teacher = await s.login('school-teacher', 'pass1234');
  assert.equal((await s.request('GET', url, { token: teacher })).status, 200);
  const student = (await s.request('POST', '/api/students', { token: dir, body: { name: '학생' } })).data.student;
  const { db, svc } = s.app.deps;
  db.run("INSERT INTO users(uid, username, name, role, academy_id, student_id, password_hash, created_at, updated_at) VALUES ('school-student', 'school-student', '학생', 'student', ?, ?, '', 1, 1)", director.academy.id, student.id);
  const token = svc.createSession(db.get("SELECT * FROM users WHERE uid = 'school-student'"), { id: 'test', platform: 'web' }, '127.0.0.1');
  assert.equal((await s.request('GET', url, { token })).status, 403);
});
