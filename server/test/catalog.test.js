'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createCloudServer, loadConfig } = require('../src/app');

async function fixture(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-catalog-'));
  const state = { version: '1.2.3', status: 200, headers: {}, assetStatus: 200, assetHeaders: {} };
  const requests = [];
  const warnings = [];
  const gh = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (state.disconnect) return req.socket.destroy();
    const base = `http://127.0.0.1:${gh.address().port}`;
    const api = req.url.startsWith('/repos/');
    const status = api ? state.status : state.assetStatus;
    if (status !== 200) {
      res.writeHead(status, api ? state.headers : state.assetHeaders);
      return res.end('unavailable');
    }
    const etag = `"${req.url}-${state.version}"`;
    if (req.headers['if-none-match'] === etag) {
      state.notModified = (state.notModified || 0) + 1;
      res.writeHead(304);
      return res.end();
    }
    res.setHeader('etag', etag);
    if (api) {
      const asset = (name) => ({ name, size: 10, browser_download_url: `${base}/dl/${name}`, url: `${base}/api/${name}` });
      const assets = req.url.includes('/cloud/')
        ? [asset(`MagoEduCloud-Setup-${state.version}.exe`), asset('latest.yml')]
        : [asset(`Tool-${state.version}.zip`), asset(`Tool-${state.version}.zip.sha256`)];
      res.setHeader('content-type', 'application/json');
      if (state.invalid) return res.end('{"message":"not a release list"}');
      return res.end(JSON.stringify(state.empty ? [] : [{
        tag_name: `v${state.version}`, body: '새 버전 안내', published_at: '2026-10-01T00:00:00Z',
        html_url: `${base}/release`, assets,
      }]));
    }
    res.end(req.url.endsWith('.sha256') ? 'a'.repeat(64) : `version: ${state.version}\n`);
  });
  await new Promise((resolve) => gh.listen(0, '127.0.0.1', resolve));
  const config = loadConfig({}, {
    dataDir, adminPassword: 'admin-pass-1234', launcherRepo: 'owner/cloud',
    githubApi: `http://127.0.0.1:${gh.address().port}`, catalogFile: path.join(dataDir, 'catalog.json'),
    background: false, quiet: true, ...overrides,
  });
  fs.writeFileSync(config.catalogFile, '[]');
  let app;
  let base;
  async function restart() {
    if (app) await app.close();
    app = createCloudServer(config);
    app.deps.log.warn = (...args) => warnings.push(args.join(' '));
    const addr = await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${addr.port}`;
  }
  t.after(async () => {
    if (app) await app.close();
    await new Promise((resolve) => gh.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await restart();
  app.deps.catalog.upsert({ id: 'tool', name: '도구', source: { type: 'github', repo: 'owner/tool', asset: '^Tool-(\\d+\\.\\d+\\.\\d+)\\.zip$' } });
  return {
    dataDir, config, state, requests, warnings, restart,
    get catalog() { return app.deps.catalog; },
    get db() { return app.deps.db; },
    request: (url, options = {}) => fetch(base + url, { redirect: 'manual', ...options }),
  };
}

test('GitHub 캐시: 재시작 직후 런처와 앱 버전을 복원하고 바로 내려받음', async (t) => {
  const s = await fixture(t);
  await s.catalog.refreshAll();
  const launcher = s.catalog.launcher;
  const release = s.catalog.get('tool').release;
  // SQLite 버전 정보가 없어도 JSON 에서 복원한다.
  s.db.run('UPDATE apps SET release = NULL, release_checked_at = NULL WHERE id = ?', 'tool');
  s.state.status = 403;
  s.state.headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 3600) };
  const before = s.requests.length;
  await s.restart();
  assert.deepEqual(s.catalog.launcher, launcher);
  assert.deepEqual(s.catalog.get('tool').release, release);
  const yml = await s.request('/updates/launcher/latest.yml');
  assert.equal(yml.status, 200);
  assert.equal(await yml.text(), launcher.ymlText);
  const setup = await s.request(`/updates/launcher/${launcher.setupName}`);
  assert.equal(setup.status, 302);
  assert.equal(setup.headers.get('location'), launcher.assets[launcher.setupName].url);
  assert.equal((await (await s.request('/api/launcher')).json()).notes, launcher.notes);
  assert.equal(s.requests.length, before, '시작 직후에는 GitHub 를 기다리지 않음');
});

test('GitHub 호출 한도: 403 뒤 이전 버전 유지, 전체 호출 중단, reset 뒤 재개', async (t) => {
  const s = await fixture(t);
  await s.catalog.refreshAll();
  const launcher = s.catalog.launcher;
  const release = s.catalog.get('tool').release;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  s.state.status = 403;
  s.state.headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(now / 1000) + 60) };
  const before = s.requests.length;
  await s.catalog.refreshAll();
  await s.catalog.refreshAll();
  await s.catalog.freshLauncher(0);
  assert.equal(s.requests.length, before + 1, '앱 하나가 한도에 걸리면 다른 API 도 중단');
  assert.deepEqual(s.catalog.launcher, launcher);
  assert.deepEqual(s.catalog.get('tool').release, release);
  assert.equal(s.warnings.length, 1, '한도 안내는 한 번만');
  await s.restart();
  await s.catalog.refreshAll();
  await s.catalog.freshLauncher(0);
  assert.equal(s.requests.length, before + 1, '재시작해도 reset 전에는 호출하지 않음');
  now += 61000;
  s.state.status = 200;
  s.state.version = '1.2.4';
  await s.catalog.refreshAll();
  assert.equal(s.catalog.launcher.version, '1.2.4');
  assert.equal(s.catalog.get('tool').release.version, '1.2.4');
});

test('GitHub ETag: 토큰 유지, URL 별 조건부 요청, 재시작 후 304 본문 재사용', async (t) => {
  const s = await fixture(t, { githubToken: 'test-token' });
  await s.catalog.refreshAll();
  const launcher = s.catalog.launcher;
  const release = s.catalog.get('tool').release;
  const before = s.requests.length;
  await s.restart();
  await s.catalog.refreshAll();
  const requests = s.requests.slice(before);
  assert.equal(requests.length, 4, '릴리스 두 개와 yml/SHA-256 파일');
  assert.equal(s.state.notModified, 4);
  for (const req of requests) {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    assert.equal(req.headers['if-none-match'], `"${req.url}-1.2.3"`);
    assert.ok(!req.url.startsWith('/dl/'), '토큰이 있으면 API 로 파일을 받음');
  }
  assert.deepEqual(s.catalog.launcher, launcher);
  assert.deepEqual(s.catalog.get('tool').release, release);
});

test('GitHub 캐시: 잘못된 JSON 과 내부 필드는 무시', async (t) => {
  const s = await fixture(t);
  await s.catalog.refreshAll();
  const file = path.join(s.dataDir, 'github-cache.json');
  const good = fs.readFileSync(file, 'utf8');
  const malformed = ['{broken', 'null', '[]', '{}'];
  for (const change of [
    (c) => { c.version = 999; },
    (c) => { c.launcher.release.assets = []; },
    (c) => { c.launcher.release.assets['latest.yml'].localFile = 'unexpected'; },
    (c) => { c.launcher.release.ymlText = 42; },
    (c) => { c.apps.tool.release.sha256 = 'wrong'; },
    (c) => { c.apps.tool.checkedAt = 'yesterday'; },
    (c) => { c.responses[Object.keys(c.responses)[0]].body = [null]; },
    (c) => { c.responses[Object.keys(c.responses)[0]].etag = 'bad\r\nheader'; },
    (c) => { c.limitedUntil = 'tomorrow'; },
  ]) {
    const c = JSON.parse(good);
    change(c);
    malformed.push(JSON.stringify(c));
  }
  for (const body of malformed) {
    fs.writeFileSync(file, body);
    s.db.run('UPDATE apps SET release = NULL, release_checked_at = NULL WHERE id = ?', 'tool');
    await s.restart();
    assert.equal(s.catalog.launcher, null);
    assert.equal(s.catalog.get('tool').release, null);
  }
  const before = s.requests.length;
  await s.catalog.refreshAll();
  assert.equal(s.catalog.launcher.version, '1.2.3');
  assert.ok(s.requests.slice(before).every((r) => !r.headers['if-none-match']));
});

test('GitHub 호출 한도: Retry-After 초와 HTTP 날짜를 따름', async (t) => {
  for (const format of ['seconds', 'date']) await t.test(format, async (t) => {
    const s = await fixture(t);
    await s.catalog.refreshAll();
    let now = Math.ceil(Date.now() / 1000) * 1000;
    t.mock.method(Date, 'now', () => now);
    const reset = now + 1000;
    s.state.status = 429;
    s.state.headers = { 'retry-after': format === 'seconds' ? '1' : new Date(reset).toUTCString() };
    const before = s.requests.length;
    await s.catalog.refreshAll();
    now = reset - 1;
    await s.catalog.freshLauncher(0);
    await s.catalog.refreshApp('tool');
    assert.equal(s.requests.length, before + 1);
    assert.equal(s.warnings.length, 1);
    now = reset;
    s.state.status = 200;
    s.state.version = '1.2.4';
    await s.catalog.refreshAll();
    assert.equal(s.catalog.launcher.version, '1.2.4');
    assert.equal(s.catalog.get('tool').release.version, '1.2.4');
  });
});

test('GitHub 파일 API 의 호출 한도도 공유하며 제한 중 토큰 다운로드는 재시도 안내', async (t) => {
  const s = await fixture(t, { githubToken: 'test-token' });
  await s.catalog.refreshAll();
  s.state.version = '1.2.4';
  s.state.assetStatus = 429;
  s.state.assetHeaders = { 'retry-after': '120' };
  const before = s.requests.length;
  await s.catalog.refreshAll();
  assert.equal(s.requests.length, before + 2, '앱 목록과 SHA 파일까지만 요청');
  assert.equal(s.catalog.get('tool').release.version, '1.2.3');
  assert.equal(s.catalog.launcher.version, '1.2.3');
  const setup = await s.request(`/updates/launcher/${s.catalog.launcher.setupName}`);
  assert.equal(setup.status, 503);
  assert.ok(Number(setup.headers.get('retry-after')) > 0);
  assert.equal((await s.request('/updates/launcher/latest.yml')).status, 200);
  assert.equal(s.requests.length, before + 2);
  assert.equal(s.warnings.length, 1);
});

test('GitHub 장애: 403/5xx/네트워크/잘못된 응답은 이전 버전을 지우지 않음', async (t) => {
  const s = await fixture(t);
  await s.catalog.refreshAll();
  const launcher = s.catalog.launcher;
  const release = s.catalog.get('tool').release;
  s.state.version = '1.2.4';
  for (const failure of [{ status: 403 }, { status: 500 }, { disconnect: true }, { invalid: true }, { assetStatus: 503 }]) {
    Object.assign(s.state, { status: 200, assetStatus: 200, disconnect: false, invalid: false }, failure);
    await s.catalog.refreshAll();
    assert.deepEqual(s.catalog.launcher, launcher);
    assert.deepEqual(s.catalog.get('tool').release, release);
    await s.restart();
    assert.deepEqual(s.catalog.launcher, launcher);
    assert.deepEqual(s.catalog.get('tool').release, release);
  }
  // 정상 응답으로 배포가 없다고 확인한 경우만 null 로 바꿈.
  Object.assign(s.state, { status: 200, assetStatus: 200, empty: true, version: '1.2.5' });
  await s.catalog.refreshAll();
  await s.restart();
  assert.equal(s.catalog.launcher, null);
  assert.equal(s.catalog.get('tool').release, null);
});

test('GitHub 캐시보다 로컬 packages 우선, 호출 제한 중에도 로컬 갱신 가능', async (t) => {
  const s = await fixture(t);
  await s.catalog.refreshAll();
  s.state.status = 403;
  s.state.headers = { 'x-ratelimit-remaining': '0' }; // reset 이 없으면 1분 뒤 재시도
  await s.catalog.refreshApp('tool');
  const dir = path.join(s.dataDir, 'packages', 'launcher');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: 1.0.0\n');
  fs.writeFileSync(path.join(dir, 'MagoEduCloud-Setup-1.0.0.exe'), 'local exe');
  const appDir = path.join(s.dataDir, 'packages', 'tool');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'Tool-1.0.0.zip'), 'local zip');
  s.catalog.upsert({ id: 'tool', source: { type: 'local' } });
  const before = s.requests.length;
  await s.restart();
  assert.equal(s.catalog.launcher.version, '1.0.0', '시작 직후에도 로컬 우선');
  await s.catalog.refreshAll();
  assert.equal(s.catalog.get('tool').release.localFile, path.join(appDir, 'Tool-1.0.0.zip'));
  const setup = await s.request('/download/launcher');
  assert.equal(setup.status, 200);
  assert.equal(await setup.text(), 'local exe');
  assert.equal(s.requests.length, before);
  const cache = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'github-cache.json'), 'utf8'));
  assert.equal(cache.launcher.release.version, '1.2.3', 'GitHub 캐시에 로컬 경로를 섞지 않음');
});

test('GitHub 캐시 교체 실패: 기존 JSON 을 온전히 남김', async (t) => {
  const s = await fixture(t);
  await s.catalog.refreshAll();
  const file = path.join(s.dataDir, 'github-cache.json');
  const before = fs.readFileSync(file, 'utf8');
  t.mock.method(fs, 'renameSync', () => { throw new Error('시험용 교체 실패'); });
  s.state.version = '1.2.4';
  await s.catalog.refreshAll();
  assert.equal(s.catalog.launcher.version, '1.2.4', '저장 실패가 정상 응답을 지우지는 않음');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(s.dataDir).filter((name) => name.endsWith('.tmp')), []);
});
