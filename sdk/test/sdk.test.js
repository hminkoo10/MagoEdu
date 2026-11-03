'use strict';

// 서버가 서명한 실행 허가증을 Python·Node 도구가 제대로 확인하는지
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer, ADMIN_PASSWORD } = require('../../server/test/helpers');
const sdk = require('../node/magoedu-cloud');

const PY = path.join(__dirname, '..', 'python');

function python(code, env) {
  return execFileSync('python3', ['-c', code], { env: { ...process.env, PYTHONPATH: PY, ...env }, encoding: 'utf8' }).trim();
}

test('실행 허가증 확인 (Python·Node)', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const admin = await s.login('admin', ADMIN_PASSWORD, 'pc-1');
  const meta = (await s.request('GET', '/api/meta')).data;
  const { ticket } = (await s.request('POST', '/api/apps/tajong/ticket', { token: admin })).data;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-sdk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const trust = path.join(dir, 'trust.json');
  fs.writeFileSync(trust, JSON.stringify({ keys: meta.keys }));
  const env = {
    MAGOEDU_TICKET: ticket,
    MAGOEDU_TRUST_FILE: trust,
    MAGOEDU_DATA_DIR: path.join(dir, 'sync'),
    MAGOEDU_LOCAL_DIR: path.join(dir, 'local'),
    MAGOEDU_SDK_PURE: '1',
  };

  await t.test('Python (순수 구현)', () => {
    const out = python(
      'import magoedu_cloud as c, json\ns=c.check("tajong")\nprint(json.dumps({"ok": s is not None, "user": s and s.user["username"], "reason": c.REASON, "other": c.check("ohdapnote") is None}))',
      env,
    );
    const r = JSON.parse(out);
    assert.deepEqual(r, { ok: true, user: 'admin', reason: '', other: true });
  });

  await t.test('Python: 바꾼 허가증·허가증 없음·키 없음은 거절', () => {
    const [a, b, c] = ticket.split('.');
    const payload = JSON.parse(Buffer.from(b, 'base64url'));
    const forged = `${a}.${Buffer.from(JSON.stringify({ ...payload, usr: 'hacker' })).toString('base64url')}.${c}`;
    assert.equal(python('import magoedu_cloud as c\nprint(c.check("tajong") is None)', { ...env, MAGOEDU_TICKET: forged }), 'True');
    assert.match(python('import magoedu_cloud as c\nc.check("tajong")\nprint(c.REASON)', { ...env, MAGOEDU_TICKET: '' }), /통합 클라우드에서만/);
    fs.writeFileSync(path.join(dir, 'empty.json'), '{}');
    assert.match(python('import magoedu_cloud as c\nc.check("tajong")\nprint(c.REASON)', { ...env, MAGOEDU_TRUST_FILE: path.join(dir, 'empty.json') }), /로그인/);
    // 다른 서버의 키로는 안 됨
    const other = { keys: [{ ...meta.keys[0], x: Buffer.alloc(32, 9).toString('base64url') }] };
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify(other));
    assert.equal(python('import magoedu_cloud as c\nprint(c.check("tajong") is None)', { ...env, MAGOEDU_TRUST_FILE: path.join(dir, 'other.json') }), 'True');
  });

  await t.test('Python: 개발 모드', () => {
    const out = python('import magoedu_cloud as c\ns=c.check("tajong")\nprint(s.dev, s.user["name"])', { MAGOEDU_DEV: '1', MAGOEDU_DEV_DIR: path.join(dir, 'dev') });
    assert.equal(out, 'True 개발자');
  });

  await t.test('Node', () => {
    const s1 = sdk.check('tajong', { packaged: false, env });
    assert.equal(s1.user.username, 'admin');
    assert.equal(s1.dataDir, env.MAGOEDU_DATA_DIR);
    assert.equal(sdk.check('ohdapnote', { packaged: false, env }), null);
    assert.equal(sdk.check('tajong', { packaged: false, env: { ...env, MAGOEDU_TICKET: `${ticket}x` } }), null);
    assert.equal(sdk.check('tajong', { packaged: false, env: { ...env, MAGOEDU_TICKET: undefined } }), null);
    assert.match(sdk.reason(), /통합 클라우드에서만/);
    assert.equal(sdk.RESTART_EXIT_CODE, 75);
  });
});

test('Node: 학원 공간 폴더와 열 때만 받는 파일 요청', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-sdk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const academyDir = path.join(dir, 'academy');
  const requestDir = path.join(dir, 'requests');
  const dev = { MAGOEDU_DEV: '1', MAGOEDU_DEV_DIR: path.join(dir, 'dev') };
  const s = sdk.check('ohdapnote', { packaged: false, env: { ...dev, MAGOEDU_USER_ID: 'u-1', MAGOEDU_ACADEMY_DIR: academyDir, MAGOEDU_REQUEST_DIR: requestDir } });
  assert.equal(s.user.id, 'u-1', '개발 모드에서도 계정을 바꿀 수 있음');
  assert.equal(s.academyDir, academyDir);
  fs.mkdirSync(path.join(academyDir, 'books', 'b1'), { recursive: true });
  fs.writeFileSync(path.join(academyDir, 'books', 'b1', 'have.pdf'), 'x');
  assert.deepEqual(await sdk.requestFiles(s, ['books/b1/have.pdf']), { ok: true, missing: [] }, '이미 있으면 바로');

  // 통합 클라우드 흉내: 요청을 읽고 받은 뒤 답을 쓴다
  const answered = [];
  const timer = setInterval(() => {
    for (const n of fs.existsSync(requestDir) ? fs.readdirSync(requestDir) : []) {
      if (!/^[\w-]+\.json$/.test(n)) continue;
      const { paths } = JSON.parse(fs.readFileSync(path.join(requestDir, n), 'utf8'));
      answered.push(paths);
      const missing = paths.filter((p) => p === 'books/b1/none.pdf');
      for (const p of paths) if (!missing.includes(p)) fs.writeFileSync(path.join(academyDir, ...p.split('/')), 'pdf');
      fs.writeFileSync(path.join(requestDir, n.replace(/\.json$/, '.done.json')), JSON.stringify({ ok: !missing.length, missing }));
      fs.rmSync(path.join(requestDir, n));
    }
  }, 30);
  t.after(() => clearInterval(timer));
  const r = await sdk.requestFiles(s, ['books/b1/have.pdf', 'books\\b1\\a.pdf', 'books/b1/none.pdf']);
  assert.deepEqual(r, { ok: false, missing: ['books/b1/none.pdf'] });
  assert.deepEqual(answered, [['books/b1/a.pdf', 'books/b1/none.pdf']], '없는 것만, / 로 바꿔서');
  assert.ok(fs.existsSync(path.join(academyDir, 'books', 'b1', 'a.pdf')));
  assert.deepEqual(fs.readdirSync(requestDir), [], '답은 읽고 지움');

  clearInterval(timer);
  const late = await sdk.requestFiles(s, ['books/b1/later.pdf'], { timeoutMs: 300 });
  assert.equal(late.ok, false);
  assert.match(late.error, /시간/);
  assert.deepEqual(fs.readdirSync(requestDir), [], '시간이 지나면 요청도 지움');

  // 받지 않은 파일 지우기: { remove } 요청
  const rm = sdk.removeFiles(s, ['books/b1/old.pdf'], { timeoutMs: 3000 });
  await new Promise((r) => setTimeout(r, 150));
  const [req] = fs.readdirSync(requestDir).filter((n) => /^[\w-]+\.json$/.test(n));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(requestDir, req), 'utf8')), { remove: ['books/b1/old.pdf'] });
  fs.writeFileSync(path.join(requestDir, req.replace(/\.json$/, '.done.json')), JSON.stringify({ ok: true, missing: [] }));
  assert.deepEqual(await rm, { ok: true, missing: [] });

  const none = sdk.check('ohdapnote', { packaged: false, env: dev });
  assert.equal(none.academyDir, '', '학원 공간이 없으면 빈 값');
  assert.equal((await sdk.requestFiles(none, ['books/b1/a.pdf'])).ok, false);
});

test('Node: 학원 학생 명단(academy-info.json)과 학생 고치기·웹 로그인 코드 요청', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-sdk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const infoFile = path.join(dir, 'app', 'academy-info.json');
  const requestDir = path.join(dir, 'requests');
  const s = sdk.check('ohdapnote', {
    packaged: false,
    env: { MAGOEDU_DEV: '1', MAGOEDU_DEV_DIR: path.join(dir, 'dev'), MAGOEDU_ACADEMY_INFO: infoFile, MAGOEDU_REQUEST_DIR: requestDir, MAGOEDU_SSO_CODE: 'msc_first' },
  });
  assert.equal(s.academyInfoFile, infoFile);
  assert.equal(s.ssoCode, 'msc_first');
  assert.equal(sdk.academyInfo(s), null, '아직 파일이 없으면 null');

  // 통합 클라우드 흉내: 파일을 새로 써서 바꿔치기
  const write = (info) => {
    fs.mkdirSync(path.dirname(infoFile), { recursive: true });
    fs.writeFileSync(`${infoFile}.tmp`, JSON.stringify(info));
    fs.renameSync(`${infoFile}.tmp`, infoFile);
  };
  write({ format: 1, students: [{ id: 's1', name: '홍길동', rev: 1 }], updatedAt: 1 });
  assert.equal(sdk.academyInfo(s).students[0].name, '홍길동');
  const seen = [];
  const stop = sdk.watchAcademyInfo(s, (info) => seen.push(info.updatedAt), { delayMs: 50 });
  t.after(stop);
  await new Promise((r) => setTimeout(r, 100));
  write({ format: 1, students: [], updatedAt: 2 });
  const end = Date.now() + 3000;
  while (!seen.length && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen, [2], '바뀌면 한 번');

  // 요청에 답하는 통합 클라우드 흉내
  const got = [];
  const timer = setInterval(() => {
    for (const n of fs.existsSync(requestDir) ? fs.readdirSync(requestDir) : []) {
      if (!/^[\w-]+\.json$/.test(n)) continue;
      const body = JSON.parse(fs.readFileSync(path.join(requestDir, n), 'utf8'));
      got.push(body);
      let answer;
      if (body.op === 'sso.code') answer = { ok: true, missing: [], ssoCode: 'msc_again', expiresAt: 123 };
      else if (body.op === 'students.save' && body.student.rev === 1) {
        answer = { ok: false, missing: [], error: '다른 사람이 먼저 고쳤어요.', errorCode: 'conflict', student: { id: 's1', name: '새 이름', rev: 2 } };
      } else answer = { ok: true, missing: [], student: { id: body.id || 'new-1', name: body.student?.name || '홍길동', rev: 1 } };
      fs.writeFileSync(path.join(requestDir, n.replace(/\.json$/, '.done.json')), JSON.stringify(answer));
      fs.rmSync(path.join(requestDir, n));
    }
  }, 20);
  t.after(() => clearInterval(timer));

  assert.deepEqual(await sdk.saveStudent(s, { name: '김철수' }), { ok: true, student: { id: 'new-1', name: '김철수', rev: 1 } });
  const c = await sdk.saveStudent(s, { id: 's1', name: '홍길동', rev: 1 });
  assert.deepEqual([c.ok, c.errorCode, c.student.rev], [false, 'conflict', 2], '먼저 고친 것을 같이 돌려줌');
  assert.equal((await sdk.deleteStudent(s, 's1')).ok, true);
  assert.equal((await sdk.restoreStudent(s, 's1')).ok, true);
  assert.deepEqual(await sdk.ssoCode(s), { ok: true, code: 'msc_again', expiresAt: 123 });
  assert.deepEqual(
    got.map((b) => b.op),
    ['students.save', 'students.save', 'students.delete', 'students.restore', 'sso.code'],
  );
  assert.equal(got[2].id, 's1');

  clearInterval(timer);
  const late = await sdk.ssoCode(s, { timeoutMs: 200 });
  assert.deepEqual([late.ok, late.errorCode, late.code], [false, 'timeout', undefined], '실패하면 code 는 없음 (오류는 errorCode)');
  const none = sdk.check('ohdapnote', { packaged: false, env: { MAGOEDU_DEV: '1', MAGOEDU_DEV_DIR: path.join(dir, 'dev2') } });
  assert.deepEqual([none.academyInfoFile, none.ssoCode, sdk.academyInfo(none)], ['', '', null]);
  assert.equal((await sdk.saveStudent(none, { name: 'x' })).errorCode, 'no_request_dir');
});

test('Node: 학원 AI 를 부를 곳(academyAi) — 서버 중계·학원 안 주소·예전 서버', () => {
  const s = { appId: 'ohdapnote', server: 'https://cloud.test/', ticket: 'MGT1.t' };
  const base = { provider: 'gemini', model: 'g1', model2: 'g2', rpm: 10, source: 'app' };
  assert.deepEqual(sdk.academyAi(s, { ai: { ...base, hasKey: true, relay: true } }), {
    ...base,
    baseUrl: 'https://cloud.test/api/ai/relay/ohdapnote',
    apiKey: 'MGT1.t',
  });
  assert.equal(sdk.academyAi({ ...s, ticket: '' }, { ai: { ...base, relay: true } }), null, '허가증이 없으면(개발 모드) 못 씀');
  const lan = sdk.academyAi(s, { ai: { provider: 'openai', direct: true, baseUrl: 'http://192.168.0.2:11434/v1' } });
  assert.deepEqual([lan.baseUrl, lan.apiKey], ['http://192.168.0.2:11434/v1', ''], '학원 안 주소는 각 PC 에서 키 없이');
  assert.equal(sdk.academyAi(s, { ai: { provider: 'gemini', apiKey: 'old-key' } }).apiKey, 'old-key', '키를 그대로 주던 예전 서버');
  assert.equal(sdk.academyAi(s, { ai: null }), null);
  assert.equal(sdk.academyAi(s, null), null);
});

test('Node: 통합 클라우드 없이 켰을 때 넘길지(shouldHandOff)', () => {
  assert.equal(sdk.shouldHandOff({ installed: true, env: {} }), true);
  assert.equal(sdk.shouldHandOff({ installed: false, env: {} }), false);
  assert.equal(sdk.shouldHandOff({ installed: true, env: { MAGOEDU_TICKET: 'MGT1.bad' } }), false, '통합 클라우드가 켰는데 확인이 안 되면 다시 넘기지 않음');
});
