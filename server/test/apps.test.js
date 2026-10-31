'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startServer, ADMIN_PASSWORD } = require('./helpers');
const { verifyTicket } = require('../src/security');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('프로그램: 직접 올린 묶음 파일, 내려받기, 실행 허가증', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { request: rq } = s;
  const admin = await s.login('admin', ADMIN_PASSWORD, 'admin-pc');

  const add = await rq('POST', '/api/admin/apps', {
    token: admin,
    body: { id: 'sample', name: '예제 프로그램', description: '시험용', source: { type: 'local' }, exe: 'Sample.exe' },
  });
  assert.equal(add.status, 200, JSON.stringify(add.data));

  const dir = path.join(s.dataDir, 'packages', 'sample');
  fs.mkdirSync(dir, { recursive: true });
  const v1 = Buffer.from('zip-v1');
  const v2 = Buffer.from('zip-v2-bigger');
  fs.writeFileSync(path.join(dir, 'Sample-1.0.0-win-x64.zip'), v1);
  fs.writeFileSync(path.join(dir, 'Sample-1.2.0-win-x64.zip'), v2);
  fs.writeFileSync(path.join(dir, 'Sample-1.2.0-win-x64.zip.md'), '- 새 기능');
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'ignore');

  await t.test('가장 높은 버전을 찾음', async () => {
    const r = await rq('POST', '/api/admin/apps/refresh', { token: admin, body: { id: 'sample' } });
    const app = r.data.apps.find((a) => a.id === 'sample');
    assert.equal(app.release.version, '1.2.0');
    assert.equal(app.release.sha256, sha(v2));
    assert.equal(app.release.notes, '- 새 기능');
    const list = await rq('GET', '/api/apps', { token: admin });
    const mine = list.data.apps.find((a) => a.id === 'sample');
    assert.equal(mine.release.size, v2.length);
    assert.equal(mine.release.localFile, undefined, '서버 안의 경로는 보여 주지 않음');
  });

  await t.test('로그인해야 받을 수 있음', async () => {
    assert.equal((await rq('GET', '/api/apps/sample/download')).status, 401);
    const dl = await rq('GET', '/api/apps/sample/download', { token: admin });
    assert.equal(dl.status, 200);
    assert.deepEqual(dl.data, v2);
  });

  await t.test('실행 허가증은 서버 공개 키로 확인됨', async () => {
    const meta = await rq('GET', '/api/meta');
    const r = await rq('POST', '/api/apps/sample/ticket', { token: admin });
    assert.equal(r.status, 200);
    const payload = verifyTicket(meta.data.keys, r.data.ticket);
    assert.ok(payload);
    assert.equal(payload.app, 'sample');
    assert.equal(payload.usr, 'admin');
    assert.equal(payload.dev, 'admin-pc');
    assert.equal(payload.iss, meta.data.serverId);
    assert.ok(payload.exp - payload.iat >= 6 * 24 * 3600);
    // 한 글자만 바꿔도 안 됨
    const [a, b, c] = r.data.ticket.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, app: 'other' })).toString('base64url');
    assert.equal(verifyTicket(meta.data.keys, `${a}.${forged}.${c}`), null);
    assert.equal(verifyTicket(meta.data.keys, `${a}.${b}.${c}`, Date.now() + 30 * 24 * 3600 * 1000), null, '기간이 지나면 안 됨');
  });

  await t.test('끈 프로그램은 목록·허가증 없음', async () => {
    await rq('PATCH', '/api/admin/apps/sample', { token: admin, body: { enabled: false } });
    const list = await rq('GET', '/api/apps', { token: admin });
    assert.equal(list.data.apps.find((a) => a.id === 'sample'), undefined);
    assert.equal((await rq('POST', '/api/apps/sample/ticket', { token: admin })).status, 404);
    const all = await rq('GET', '/api/admin/apps', { token: admin });
    assert.equal(all.data.apps.find((a) => a.id === 'sample').enabled, false);
  });

  await t.test('통합 클라우드 업데이트 파일 (직접 올린 것)', async () => {
    const ldir = path.join(s.dataDir, 'packages', 'launcher');
    fs.mkdirSync(ldir, { recursive: true });
    fs.writeFileSync(path.join(ldir, 'latest.yml'), 'version: 1.1.0\npath: MagoEduCloud-Setup-1.1.0.exe\n');
    fs.writeFileSync(path.join(ldir, 'MagoEduCloud-Setup-1.1.0.exe'), 'EXE');
    await rq('POST', '/api/admin/apps/refresh', { token: admin, body: {} });
    const yml = await rq('GET', '/updates/launcher/latest.yml');
    assert.equal(yml.status, 200);
    assert.match(yml.data.toString(), /version: 1\.1\.0/);
    const exe = await rq('GET', '/updates/launcher/MagoEduCloud-Setup-1.1.0.exe');
    assert.equal(exe.data.toString(), 'EXE');
    const page = await rq('GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.data.toString(), /구현민/);
    const info = await rq('GET', '/api/launcher');
    assert.equal(info.data.version, '1.1.0');
  });
});

test('프로그램: GitHub Releases 에서 새 버전 찾기', async (t) => {
  // 가짜 GitHub
  const zip = Buffer.from('github-zip');
  let ghToken = null;
  const gh = http.createServer((req, res) => {
    ghToken = req.headers.authorization || null;
    const base = `http://127.0.0.1:${gh.address().port}`;
    if (req.url.startsWith('/repos/owner/tool/releases')) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify([
          { draft: false, prerelease: true, tag_name: 'v9.0.0', body: 'beta', assets: [{ name: 'Tool-9.0.0-win-x64.zip', size: 1, browser_download_url: `${base}/dl/beta`, url: `${base}/api/beta` }] },
          {
            draft: false,
            prerelease: false,
            tag_name: 'v2.0.0',
            body: '- 2.0',
            html_url: 'https://example/rel/2',
            published_at: '2026-10-01T00:00:00Z',
            assets: [
              { name: 'Tool-2.0.0-win-x64.zip', size: zip.length, browser_download_url: `${base}/dl/zip`, url: `${base}/api/zip` },
              { name: 'Tool-2.0.0-win-x64.zip.sha256', size: 80, browser_download_url: `${base}/dl/sha`, url: `${base}/api/sha` },
              { name: 'Tool-Setup-2.0.0.exe', size: 5, browser_download_url: `${base}/dl/exe`, url: `${base}/api/exe` },
            ],
          },
          {
            draft: false,
            prerelease: false,
            tag_name: 'v1.0.0',
            assets: [{ name: 'Tool-1.0.0-win-x64.zip', size: 3, digest: `sha256:${'a'.repeat(64)}`, browser_download_url: `${base}/dl/old`, url: `${base}/api/old` }],
          },
        ]),
      );
      return;
    }
    if (req.url === '/dl/sha' || req.url === '/api/sha') return res.end(`${sha(zip)}  Tool-2.0.0-win-x64.zip\n`);
    if (req.url === '/api/zip') return res.end(zip);
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  t.after(() => gh.close());

  for (const token of ['', 'ghp_test']) {
    await t.test(token ? '토큰이 있으면 서버가 대신 받아서 보냄' : '공개 저장소면 GitHub 주소로 넘김', async () => {
      const s = await startServer({ githubApi: `http://127.0.0.1:${gh.address().port}`, githubToken: token });
      try {
        const admin = await s.login('admin', ADMIN_PASSWORD);
        await s.request('POST', '/api/admin/apps', {
          token: admin,
          body: { id: 'tool', name: 'Tool', source: { type: 'github', repo: 'owner/tool', asset: '^Tool-(\\d+\\.\\d+\\.\\d+)-win-x64\\.zip$' } },
        });
        const r = await s.request('POST', '/api/admin/apps/refresh', { token: admin, body: { id: 'tool' } });
        const app = r.data.apps.find((a) => a.id === 'tool');
        assert.equal(app.release.version, '2.0.0', '미리보기(prerelease)는 건너뜀');
        assert.equal(app.release.sha256, sha(zip), '.sha256 파일에서 값을 읽음');
        assert.equal(app.release.notes, '- 2.0');
        const dl = await s.request('GET', '/api/apps/tool/download', { token: admin });
        if (token) {
          assert.equal(dl.status, 200);
          assert.deepEqual(dl.data, zip);
          assert.equal(ghToken, 'Bearer ghp_test');
        } else {
          assert.equal(dl.status, 302);
          assert.match(dl.headers.get('location'), /\/dl\/zip$/);
        }
      } finally {
        await s.close();
      }
    });
  }

  await t.test('잘못된 저장소 이름·규칙은 거절', async () => {
    const s = await startServer();
    try {
      const admin = await s.login('admin', ADMIN_PASSWORD);
      const r1 = await s.request('POST', '/api/admin/apps', { token: admin, body: { id: 'x1', name: 'X', source: { type: 'github', repo: 'bad repo', asset: '(x)' } } });
      assert.equal(r1.status, 400);
      const r2 = await s.request('POST', '/api/admin/apps', { token: admin, body: { id: 'x2', name: 'X', source: { type: 'github', repo: 'a/b', asset: 'no-group' } } });
      assert.equal(r2.status, 400);
      const r3 = await s.request('POST', '/api/admin/apps', { token: admin, body: { id: 'Bad ID', name: 'X' } });
      assert.equal(r3.status, 400);
    } finally {
      await s.close();
    }
  });
});
