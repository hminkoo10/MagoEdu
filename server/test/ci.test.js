'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, ADMIN_PASSWORD } = require('./helpers');
const { Catalog } = require('../src/catalog');

const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (pair, kid) => ({ ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });
const repo = 'owner/tool';
const endpoint = '/api/ci/releases';
const asset = (name) => ({ name, size: 123, sha256: 'AB'.repeat(32) });
const source = (ext, extra = {}) => ({ type: 'github', repo, asset: `^Tool-(\\d+\\.\\d+\\.\\d+)\\.${ext}$`, ...extra });

function notification(version = '1.2.3') {
  return {
    tag: `cloud-v${version}`, version, notes: '새 버전 안내',
    assets: [asset(`Tool-${version}.zip`), asset(`Tool-${version}.apk`),
      asset(`MagoEduCloud-Setup-${version}.exe`), asset('latest.yml'), asset(`MagoEduCloud-Setup-${version}.exe.blockmap`)],
    latestYml: `version: ${version}\npath: MagoEduCloud-Setup-${version}.exe\nsha512: test\n`,
  };
}

function token(claims = {}, header = {}, pair = key) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const head = encode({ alg: 'RS256', kid: 'key-1', ...header });
  const body = encode({ iss: 'https://token.actions.githubusercontent.com', aud: 'mago.milky.kr',
    exp: now + 300, nbf: now - 5, iat: now - 5, repository: repo, ref: 'refs/heads/main', ...claims });
  return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), pair.privateKey).toString('base64url')}`;
}

async function fixture(t) {
  const requests = [];
  const state = { keys: [jwk(key, 'key-1')], status: 200 };
  const gh = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(req.url === '/jwks' ? state.status : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: state.keys }));
  });
  await new Promise((resolve) => gh.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gh.address().port}`;
  const s = await startServer({ githubApi: base, githubOidcJwksUrl: `${base}/jwks`, launcherRepo: repo });
  t.after(async () => {
    await s.close();
    await new Promise((resolve) => gh.close(resolve));
  });
  const { catalog } = s.app.deps;
  catalog.upsert({ id: 'tool', name: '도구', source: source('zip') });
  catalog.upsert({ id: 'phone', name: '휴대폰', platform: 'android', source: source('apk') });
  catalog.upsert({ id: 'other', name: '다른 저장소', source: source('zip', { repo: 'owner/other' }) });
  catalog.upsert({ id: 'tagged', name: '다른 태그', source: source('zip', { tagPrefix: 'desktop-' }) });
  catalog.upsert({ id: 'local', name: '로컬', source: { type: 'local' } });
  return { ...s, catalog, requests, state,
    post: (body = notification(), jwt = token()) => s.request('POST', endpoint, { body, token: jwt }),
  };
}

test('CI 릴리스: 앱·APK·런처 갱신, 조회·다운로드·감사 기록·디스크 복원', async (t) => {
  const s = await fixture(t);
  const { db, config, log } = s.app.deps;
  db.run("UPDATE apps SET release_error = '이전 조회 실패' WHERE id = 'tool'");
  s.catalog.launcherError = '이전 조회 실패';
  const body = notification();
  const before = Date.now();
  const res = await s.post(body);
  assert.equal(res.status, 200);
  assert.deepEqual([...res.data.updated].sort(), ['launcher', 'phone', 'tool']);
  const app = s.catalog.get('tool');
  assert.deepEqual(app.release, {
    version: body.version, fileName: 'Tool-1.2.3.zip', size: 123, sha256: 'ab'.repeat(32),
    url: `https://github.com/${repo}/releases/download/cloud-v1.2.3/Tool-1.2.3.zip`, tag: body.tag,
    releaseUrl: `https://github.com/${repo}/releases/tag/cloud-v1.2.3`, notes: body.notes, publishedAt: app.release.publishedAt,
  });
  assert.ok(app.release.publishedAt >= before && app.release.publishedAt <= Date.now());
  assert.equal(app.releaseCheckedAt, app.release.publishedAt);
  assert.equal(app.releaseError, null);
  assert.equal(s.catalog.get('phone').release.fileName, 'Tool-1.2.3.apk');
  for (const id of ['other', 'tagged', 'local']) assert.equal(s.catalog.get(id).release, null);
  assert.equal(s.catalog.launcherError, null);
  const launcher = s.catalog.launcher;
  assert.equal(launcher.version, body.version);
  assert.equal(launcher.ymlText, body.latestYml);
  assert.equal(launcher.notes, body.notes);
  assert.equal(Object.keys(launcher.assets).length, body.assets.length);
  const yml = await s.request('GET', '/updates/launcher/latest.yml');
  assert.equal(yml.status, 200);
  assert.equal(yml.data.toString(), body.latestYml);
  assert.match(yml.headers.get('content-type'), /text\/yaml/);
  const admin = await s.login('admin', ADMIN_PASSWORD);
  assert.equal((await s.request('GET', '/api/apps', { token: admin })).data.apps.find((a) => a.id === 'tool').release.version, body.version);
  for (const githubToken of ['', 'test-token']) {
    config.githubToken = githubToken;
    for (const url of ['/download/launcher', `/updates/launcher/${launcher.setupName}`, '/api/apps/tool/download']) {
      const dl = await s.request('GET', url, { token: admin });
      assert.equal(dl.status, 302, 'CI 파일에는 API 주소가 없으므로 항상 공개 다운로드 주소 사용');
      assert.match(dl.headers.get('location'), /^https:\/\/github.com\/owner\/tool\/releases\/download\/cloud-v1.2.3\//);
    }
  }
  config.githubToken = '';
  const audit = db.get("SELECT * FROM audit WHERE action = 'release.ci'");
  assert.equal(audit.actor, `GitHub Actions (${repo})`);
  assert.deepEqual(JSON.parse(audit.detail), { repo, version: body.version, updated: res.data.updated });
  const cache = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'github-cache.json'), 'utf8'));
  assert.deepEqual(cache.apps.tool.release, app.release);
  assert.deepEqual(cache.launcher.release, launcher);
  db.run("UPDATE apps SET release = NULL, release_checked_at = NULL WHERE id = 'tool'");
  const restored = new Catalog({ db, config, log });
  assert.deepEqual(restored.get('tool').release, app.release);
  assert.deepEqual(restored.launcher, launcher);
  assert.deepEqual(s.requests, ['/jwks'], '릴리스 API·자산 조회 없음');
});

test('CI OIDC: 잘못된 클레임·서명·형식은 401, 상태 변경 없음', async (t) => {
  const s = await fixture(t);
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    ['aud', token({ aud: 'other' })], ['iss', token({ iss: 'https://evil.example' })],
    ['expired', token({ exp: now - 60 })], ['nbf', token({ nbf: now + 60 })],
    ['iat', token({ iat: now + 60 })], ['missing exp', token({ exp: undefined })],
    ['missing nbf', token({ nbf: undefined })], ['missing iat', token({ iat: undefined })],
    ['numeric string', token({ exp: String(now + 300) })], ['missing repository', token({ repository: undefined })],
    ['pull request', token({ ref: 'refs/pull/1/merge' })], ['missing ref', token({ ref: undefined })],
    ['feature branch', token({ ref: 'refs/heads/feature' })],
    ['bad signature', token({}, {}, otherKey)], ['alg', token({}, { alg: 'HS256' })],
    ['missing kid', token({}, { kid: undefined })], ['unknown kid', token({}, { kid: 'missing' })],
    ['crit', token({}, { crit: ['unsupported'] })], ['malformed', 'broken.token'], ['missing token', ''],
  ];
  for (const [name, jwt] of cases) await t.test(name, async () => {
    assert.equal((await s.post(notification(), jwt)).status, 401);
  });
  assert.equal(s.catalog.get('tool').release, null);
  assert.equal(s.catalog.launcher, null);
  assert.equal(s.app.deps.db.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'release.ci'").n, 0);
  assert.ok(s.requests.length <= 1, '알 수 없는 kid 로 JWKS 호출을 늘리지 못함');
});

test('CI OIDC: release/ 브랜치에서 배포한 알림도 받음 (타종 PC 는 release/desktop-v* 브랜치로 배포)', async (t) => {
  const s = await fixture(t);
  assert.equal((await s.post(notification(), token({ ref: 'refs/heads/release/desktop-v1.2.3' }))).status, 200);
});

test('CI OIDC: JWKS 캐시·동시 요청·키 교체·만료·오류 시 분당 재조회 제한', async (t) => {
  const s = await fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  assert.ok((await Promise.all([s.post(), s.post(), s.post()])).every((r) => r.status === 200));
  assert.equal(s.requests.length, 1);
  s.state.keys = [jwk(otherKey, 'key-2')];
  const rotated = () => token({ ref: 'refs/tags/cloud-v1.2.3' }, { kid: 'key-2' }, otherKey);
  assert.equal((await s.post(notification(), rotated())).status, 401);
  assert.equal(s.requests.length, 1);
  now += 60000;
  assert.equal((await s.post(notification(), rotated())).status, 200);
  assert.equal(s.requests.length, 2);
  assert.equal((await s.post()).status, 401, '교체 전 키는 제거');
  now += 3600000;
  s.state.status = 503;
  assert.equal((await s.post(notification(), rotated())).status, 401);
  assert.equal((await s.post(notification(), rotated())).status, 401);
  assert.equal(s.requests.length, 3);
  now += 60000;
  s.state.status = 200;
  assert.equal((await s.post(notification(), rotated())).status, 200);
  assert.equal(s.requests.length, 4);
});

test('CI 릴리스: 미등록 저장소 404, 본문의 저장소 위장은 400, 기존 상태 유지', async (t) => {
  const s = await fixture(t);
  await s.post();
  const previous = s.catalog.get('tool').release;
  const launcher = s.catalog.launcher;
  assert.equal((await s.post(notification('9.0.0'), token({ repository: 'attacker/tool' }))).status, 404);
  assert.equal((await s.post({ ...notification('9.0.0'), repository: repo }, token({ repository: 'attacker/tool' }))).status, 400);
  assert.deepEqual(s.catalog.get('tool').release, previous);
  assert.deepEqual(s.catalog.launcher, launcher);
});

test('CI 릴리스: 본문 검증 실패는 400, 일부 항목만 갱신하지 않음', async (t) => {
  const s = await fixture(t);
  const edits = [
    ['version', (b) => { b.version = '1.2'; }], ['tag path', (b) => { b.tag = '../v1.2.3'; }],
    ['version newline', (b) => { b.version += '\n'; }], ['tag newline', (b) => { b.tag += '\n'; }],
    ['tag encoding', (b) => { b.tag = 'v%2f1.2.3'; }], ['notes', (b) => { b.notes = 1; }],
    ['assets', (b) => { b.assets = {}; }], ['empty assets', (b) => { b.assets = []; }],
    ['null asset', (b) => { b.assets = [null]; }], ['duplicate', (b) => { b.assets.push(b.assets[0]); }],
    ['slash', (b) => { b.assets[0].name = 'x/file.zip'; }], ['backslash', (b) => { b.assets[0].name = 'x\\file.zip'; }],
    ['dotdot', (b) => { b.assets[0].name = 'file..zip'; }], ['name encoding', (b) => { b.assets[0].name = 'x%2f.zip'; }],
    ['name newline', (b) => { b.assets[0].name += '\n'; }],
    ['size fraction', (b) => { b.assets[0].size = 1.5; }], ['size negative', (b) => { b.assets[0].size = -1; }],
    ['size string', (b) => { b.assets[0].size = '12'; }], ['size unsafe', (b) => { b.assets[0].size = 2 ** 53; }],
    ['sha', (b) => { b.assets[0].sha256 = 'z'.repeat(64); }], ['short sha', (b) => { b.assets[0].sha256 = 'a'.repeat(63); }],
    ['sha newline', (b) => { b.assets[0].sha256 += '\n'; }],
    ['asset url', (b) => { b.assets[0].url = 'https://evil.example'; }],
    ['yml type', (b) => { b.latestYml = {}; }], ['yml blank', (b) => { b.latestYml = ' '; }],
    ['yml bytes', (b) => { b.latestYml = '한'.repeat(22000); }],
    ['missing yml', (b) => { delete b.latestYml; }], ['missing yml asset', (b) => { b.assets.splice(3, 1); }],
    ['missing setup', (b) => { b.assets.splice(2, 1); }],
    ['wrong setup version', (b) => { b.assets[2].name = 'MagoEduCloud-Setup-9.0.0.exe'; }],
    ['wrong app version', (b) => { b.assets[0].name = 'Tool-9.0.0.zip'; }],
  ];
  for (const [name, edit] of edits) await t.test(name, async () => {
    const body = notification();
    edit(body);
    assert.equal((await s.post(body)).status, 400);
  });
  for (const body of [null, [], 'text', 3]) assert.equal((await s.post(body)).status, 400);
  assert.equal((await s.request('POST', endpoint, { token: token(), raw: '{bad', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await s.request('POST', endpoint, { token: token(), raw: '{}' })).status, 400);
  assert.equal((await s.post({ ...notification(), notes: 'x'.repeat(128 * 1024) })).status, 400);
  // Content-Length 가 없는 전송도 같은 상한을 지킨다.
  const status = await new Promise((resolve, reject) => {
    const req = http.request(s.base + endpoint, { method: 'POST', headers: {
      authorization: `Bearer ${token()}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked',
    } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write('x'.repeat(128 * 1024));
    req.end('x');
  });
  assert.equal(status, 400);
  assert.equal(s.catalog.get('tool').release, null);
  assert.equal(s.catalog.launcher, null);
  assert.equal(fs.existsSync(path.join(s.dataDir, 'github-cache.json')), false);
});

test('CI 릴리스: 앱 전용 알림·태그 규칙·지연된 구버전·런처 저장소 제한', async (t) => {
  const s = await fixture(t);
  const body = notification();
  delete body.latestYml;
  body.assets = body.assets.slice(0, 2);
  body.tag = 'desktop-v1.2.3';
  assert.deepEqual((await s.post(body)).data.updated.sort(), ['phone', 'tagged', 'tool']);
  assert.equal(s.catalog.launcher, null);
  await s.post();
  assert.deepEqual((await s.post(notification('1.0.0'))).data.updated, []);
  assert.equal(s.catalog.get('tool').release.version, '1.2.3');
  assert.equal(s.catalog.launcher.version, '1.2.3');
  assert.equal((await s.post(notification(), token({ repository: 'owner/other' }))).status, 400);
  assert.equal(s.catalog.get('other').release, null, '잘못된 런처 알림이면 앱도 변경하지 않음');
  const launcherOnly = notification('1.3.0');
  launcherOnly.assets = launcherOnly.assets.slice(2);
  assert.deepEqual((await s.post(launcherOnly)).data.updated, ['launcher']);
  const maxYml = { ...launcherOnly, latestYml: 'x'.repeat(64 * 1024) };
  assert.equal((await s.post(maxYml)).status, 200, 'latest.yml 은 64 KB 까지 허용');
});

test('CI 기본 모드: 수동·요청·백그라운드 갱신은 GitHub API 호출 없이 캐시 유지, 로컬 갱신 가능', async (t) => {
  const s = await fixture(t);
  assert.equal((await s.request('GET', '/updates/launcher/latest.yml')).status, 404);
  await s.catalog.refreshAll();
  assert.deepEqual(s.requests, []);
  await s.post();
  const previous = s.catalog.get('tool').release;
  const launcher = s.catalog.launcher;
  const localDir = path.join(s.dataDir, 'packages', 'local');
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(localDir, 'Local-1.0.0.zip'), 'local');
  await s.catalog.refreshApp('tool');
  await s.catalog.refreshAll();
  await s.catalog.freshLauncher(0);
  const scheduled = [];
  t.mock.method(global, 'setTimeout', (fn) => { scheduled.push(fn); return { unref() {} }; });
  t.mock.method(global, 'setInterval', (fn) => { scheduled.push(fn); return { unref() {} }; });
  s.catalog.start();
  assert.equal(scheduled.length, 2);
  for (const kick of scheduled) await kick();
  s.catalog.stop();
  assert.deepEqual(s.catalog.get('tool').release, previous);
  assert.deepEqual(s.catalog.launcher, launcher);
  assert.equal(s.catalog.get('local').release.version, '1.0.0');
  assert.deepEqual(s.requests, ['/jwks']);
});
