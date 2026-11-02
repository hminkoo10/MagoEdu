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
  const s = await startServer({ webDir: null }); // / 에서 내려받기 안내 페이지를 확인함
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

test('안드로이드 항목: 플랫폼, 내려받기 주소, 허가증 거절', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { request: rq } = s;
  const admin = await s.login('admin', ADMIN_PASSWORD);

  await t.test('기본 목록에 마고 타종 (안드로이드)', async () => {
    const r = await rq('GET', '/api/apps', { token: admin });
    const byId = Object.fromEntries(r.data.apps.map((a) => [a.id, a]));
    assert.equal(byId.tajong.platform, 'windows');
    assert.equal(byId['tajong-android'].platform, 'android');
    assert.equal(byId['tajong-android'].name, '마고 타종 (안드로이드)');
    assert.equal(byId['tajong-android'].autoLaunchDefault, false);
    assert.deepEqual(r.data.apps.map((a) => a.id).slice(0, 2), ['tajong', 'tajong-android'], '타종 바로 다음');
    const all = await rq('GET', '/api/admin/apps', { token: admin });
    const android = all.data.apps.find((a) => a.id === 'tajong-android');
    assert.deepEqual(android.source, { type: 'github', repo: 'hminkoo10/Mapl-Tajong', asset: '^MaplTajong-(\\d+\\.\\d+\\.\\d+)\\.apk$' });
    assert.equal(android.coldStorage.enabled, false);
  });

  await t.test('플랫폼 고르기 (운영자)', async () => {
    const add = await rq('POST', '/api/admin/apps', {
      token: admin,
      body: { id: 'phone', name: '폰 앱', platform: 'android', source: { type: 'local', asset: '^Phone-(\\d+\\.\\d+\\.\\d+)\\.apk$' } },
    });
    assert.equal(add.status, 200, JSON.stringify(add.data));
    assert.equal(add.data.app.platform, 'android');
    const bad = await rq('POST', '/api/admin/apps', { token: admin, body: { id: 'ios', name: 'X', platform: 'ios' } });
    assert.equal(bad.data.error.code, 'invalid_platform');
    const reserved = await rq('POST', '/api/admin/apps', { token: admin, body: { id: 'events', name: 'X' } });
    assert.equal(reserved.status, 400, '/api/sync/events 와 겹치는 ID');
    const def = await rq('POST', '/api/admin/apps', { token: admin, body: { id: 'pcapp', name: 'PC 앱', source: { type: 'local' } } });
    assert.equal(def.data.app.platform, 'windows', '기본은 windows');
    const patch = await rq('PATCH', '/api/admin/apps/pcapp', { token: admin, body: { name: 'PC 앱 2' } });
    assert.equal(patch.data.app.platform, 'windows', '고칠 때 platform 을 안 보내면 그대로');
  });

  const dir = path.join(s.dataDir, 'packages', 'phone');
  fs.mkdirSync(dir, { recursive: true });
  const apk = Buffer.from('PK-fake-apk');
  fs.writeFileSync(path.join(dir, 'Phone-1.0.0.apk'), apk);
  await rq('POST', '/api/admin/apps/refresh', { token: admin, body: { id: 'phone' } });

  await t.test('안드로이드 프로그램은 실행 허가증을 주지 않음', async () => {
    const r = await rq('POST', '/api/apps/phone/ticket', { token: admin });
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'wrong_platform');
  });

  await t.test('브라우저 내려받기: 10분짜리 서명 주소', async () => {
    assert.equal((await rq('POST', '/api/apps/phone/download-link')).status, 401);
    const link = await rq('POST', '/api/apps/phone/download-link', { token: admin });
    assert.equal(link.status, 200);
    assert.match(link.data.url, /^\/api\/apps\/phone\/download\?version=1\.0\.0&dl=\d+\.[\w-]{43}$/);
    assert.ok(link.data.expiresAt > Date.now() + 9 * 60 * 1000 && link.data.expiresAt <= Date.now() + 10 * 60 * 1000 + 1000);
    const dl = await rq('GET', link.data.url); // 로그인 정보 없이
    assert.equal(dl.status, 200);
    assert.deepEqual(dl.data, apk);
    assert.equal(dl.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.equal(dl.headers.get('content-disposition'), `attachment; filename="Phone-1.0.0.apk"; filename*=UTF-8''Phone-1.0.0.apk`);

    const sig = link.data.url.split('&dl=')[1];
    const [exp, mac] = sig.split('.');
    const forged = `${exp}.${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
    for (const url of [
      `/api/apps/phone/download?version=1.0.0&dl=${forged}`,
      `/api/apps/phone/download?version=1.0.0&dl=${Number(exp) + 600}.${mac}`, // 기간만 늘리기
      `/api/apps/phone/download?version=0.9.0&dl=${sig}`, // 다른 버전
      `/api/apps/pcapp/download?version=1.0.0&dl=${sig}`, // 다른 프로그램
      `/api/apps/phone/download?dl=${sig}`,
      `/api/apps/phone/download?version=1.0.0&dl=junk`,
    ]) {
      const r = await rq('GET', url);
      assert.equal(r.status, 403, url);
      assert.equal(r.data.error.code, 'invalid_link', url);
    }
    // 기간이 지난 주소 (서버 비밀값으로 직접 만들어 봄)
    const secret = s.app.deps.svc.meta('download_link_secret');
    const old = Math.floor(Date.now() / 1000) - 1;
    const oldMac = crypto.createHmac('sha256', secret).update(`dl1\nphone\n1.0.0\n${old}`).digest('base64url');
    const expired = await rq('GET', `/api/apps/phone/download?version=1.0.0&dl=${old}.${oldMac}`);
    assert.equal(expired.data.error.code, 'invalid_link');
    // 로그인 정보로 받아도 APK 종류
    const bearer = await rq('GET', '/api/apps/phone/download', { token: admin });
    assert.equal(bearer.headers.get('content-type'), 'application/vnd.android.package-archive');
  });

  await t.test('권한이 없으면 주소도 받을 수 없음', async () => {
    await rq('POST', '/api/users', {
      token: admin,
      body: { role: 'teacher', name: '선생', username: 'teach', password: 'pass1234', academyName: '학원', allowedApps: ['tajong'], mustChangePassword: false },
    });
    const tt = await s.login('teach', 'pass1234');
    assert.equal((await rq('POST', '/api/apps/phone/download-link', { token: tt })).status, 403);
  });
});

test('안드로이드 항목: 이미 쓰던 서버에는 고침(migration)으로 추가', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { openDb, MIGRATIONS } = require('../src/db');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'magoedu-mig-'));
  try {
    const file = path.join(dir, 'magoedu.db');
    const raw = new DatabaseSync(file);
    raw.exec(MIGRATIONS[0]);
    raw.exec('PRAGMA user_version = 1');
    raw
      .prepare(
        `INSERT INTO apps(id, name, sort, source, icon_url, exe, created_at, updated_at) VALUES ('tajong', '마고 타종', 3, '{"type":"local"}', 'https://x/icon.ico', 'Mataf.exe', 1, 1)`,
      )
      .run();
    raw.close();
    const db = openDb(file);
    const rows = db.all('SELECT id, sort, platform, source, icon_url, exe, cold_enabled, auto_launch_default, enabled FROM apps ORDER BY id');
    assert.equal(rows.length, 2);
    const [tj, android] = rows;
    assert.equal(tj.platform, 'windows');
    assert.equal(android.id, 'tajong-android');
    assert.equal(android.platform, 'android');
    assert.equal(android.sort, 3);
    assert.equal(android.icon_url, 'https://x/icon.ico');
    assert.deepEqual([android.exe, android.cold_enabled, android.auto_launch_default, android.enabled], ['', 0, 0, 1]);
    const re = new RegExp(JSON.parse(android.source).asset);
    assert.ok(re.test('MaplTajong-2.3.0.apk'));
    assert.ok(!re.test('MaplTajong-2.3.0-win-x64.zip'));
    assert.ok(!re.test('MaplTajong-2.3.0.apk.sha256'));
    db.close();

    // 처음 설치하는 서버(빈 목록)는 고침에서 넣지 않음 → 기본 목록(catalog.default.json)이 그대로 들어감
    const fresh = openDb(path.join(dir, 'fresh.db'));
    assert.equal(fresh.get('SELECT COUNT(*) AS n FROM apps').n, 0);
    fresh.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('안드로이드 항목: 같은 저장소의 PC zip 과 안드로이드 APK 를 서로 헷갈리지 않음', async (t) => {
  const zip = Buffer.from('desktop-zip');
  const apk = Buffer.from('android-apk');
  const gh = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${gh.address().port}`;
    const asset = (name, body) => ({ name, size: body.length, digest: `sha256:${sha(body)}`, browser_download_url: `${base}/dl/${name}`, url: `${base}/api/${name}` });
    if (req.url.startsWith('/repos/hminkoo10/Mapl-Tajong/releases')) {
      res.setHeader('content-type', 'application/json');
      // 안드로이드 Release 는 --latest=false 로 만들지만 목록에서는 보통 Release(미리보기 아님)로 보임
      res.end(
        JSON.stringify([
          { draft: false, prerelease: false, tag_name: 'android-v1.4.0', body: 'android', assets: [asset('MaplTajong-1.4.0.apk', apk), asset('MaplTajong-1.4.0.apk.sha256', Buffer.from('x'))] },
          { draft: false, prerelease: true, tag_name: 'android-v9.0.0', assets: [asset('MaplTajong-9.0.0.apk', apk)] },
          { draft: false, prerelease: false, tag_name: 'desktop-v2.2.0', body: 'desktop', assets: [asset('MaplTajong-2.2.0-win-x64.zip', zip), asset('MaplTajong-Setup-2.2.0.exe', zip)] },
        ]),
      );
      return;
    }
    if (req.url === '/api/MaplTajong-1.4.0.apk') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(apk);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  t.after(() => gh.close());

  const s = await startServer({ githubApi: `http://127.0.0.1:${gh.address().port}`, githubToken: 'ghp_test' });
  t.after(() => s.close());
  const admin = await s.login('admin', ADMIN_PASSWORD);
  for (const id of ['tajong', 'tajong-android']) await s.request('POST', '/api/admin/apps/refresh', { token: admin, body: { id } });
  const apps = (await s.request('GET', '/api/admin/apps', { token: admin })).data.apps;
  const tj = apps.find((a) => a.id === 'tajong');
  const an = apps.find((a) => a.id === 'tajong-android');
  assert.equal(tj.release.fileName, 'MaplTajong-2.2.0-win-x64.zip');
  assert.equal(tj.release.version, '2.2.0');
  assert.equal(an.release.fileName, 'MaplTajong-1.4.0.apk', '미리보기는 건너뛰고, 더 높은 PC 버전 zip 은 안 고름');
  assert.equal(an.release.version, '1.4.0');
  assert.equal(an.release.sha256, sha(apk));

  const link = await s.request('POST', '/api/apps/tajong-android/download-link', { token: admin });
  const dl = await s.request('GET', link.data.url);
  assert.equal(dl.status, 200);
  assert.deepEqual(dl.data, apk);
  assert.equal(dl.headers.get('content-type'), 'application/vnd.android.package-archive', '서버가 대신 받아 보낼 때 APK 종류로');
  assert.match(dl.headers.get('content-disposition'), /filename="MaplTajong-1\.4\.0\.apk"/);
});

test('통합 클라우드 업데이트: 방금 나온 버전도 ‘확인’하면 바로 보임, 바뀐 게 없으면 GitHub 304', async (t) => {
  let version = '1.0.4';
  let full = 0; // 304 가 아닌 응답 수
  const gh = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${gh.address().port}`;
    if (req.url.startsWith('/repos/owner/cloud/releases')) {
      const etag = `"v${version}"`;
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        return res.end();
      }
      full++;
      res.setHeader('content-type', 'application/json');
      res.setHeader('etag', etag);
      const setup = `MagoEduCloud-Setup-${version}.exe`;
      return res.end(
        JSON.stringify([
          {
            draft: false,
            prerelease: false,
            tag_name: `cloud-v${version}`,
            assets: [
              { name: setup, size: 3, browser_download_url: `${base}/dl/${setup}`, url: `${base}/api/exe` },
              { name: 'latest.yml', size: 40, browser_download_url: `${base}/dl/latest.yml?v=${version}`, url: `${base}/api/yml` },
            ],
          },
        ]),
      );
    }
    if (req.url.startsWith('/dl/latest.yml')) return res.end(`version: ${new URL(req.url, 'http://x').searchParams.get('v')}\n`);
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  t.after(() => gh.close());
  const s = await startServer({ githubApi: `http://127.0.0.1:${gh.address().port}`, launcherRepo: 'owner/cloud' });
  t.after(() => s.close());
  const catalog = s.app.deps.catalog;

  assert.match((await s.request('GET', '/updates/launcher/latest.yml')).data.toString(), /version: 1\.0\.4/);
  assert.equal(full, 1);
  // 1분 안에 다시 물으면 GitHub 에 묻지 않음
  await s.request('GET', '/updates/launcher/latest.yml');
  assert.equal(full, 1);

  // 새 버전이 나옴 → 1분이 지난 뒤 ‘확인’하면 관리자가 새로 고치지 않아도 바로 보임
  version = '1.0.5';
  catalog._launcherCheckedAt = 0;
  assert.match((await s.request('GET', '/updates/launcher/latest.yml')).data.toString(), /version: 1\.0\.5/);
  assert.equal(full, 2);
  assert.equal((await s.request('GET', '/api/launcher')).data.version, '1.0.5');

  // 바뀐 게 없으면 304 를 받고 그대로
  catalog._launcherCheckedAt = 0;
  assert.match((await s.request('GET', '/updates/launcher/latest.yml')).data.toString(), /version: 1\.0\.5/);
  assert.equal(full, 2, '304 는 다시 받지 않음');
});
