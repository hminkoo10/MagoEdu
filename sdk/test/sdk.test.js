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
