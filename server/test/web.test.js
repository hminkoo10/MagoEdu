'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');

test('웹 화면: 앱 화면 코드를 그대로 내보냄', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { request: rq } = s;

  await t.test('/ 는 웹 화면 index', async () => {
    const r = await rq('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/html/);
    assert.ok(r.data.toString('utf8').includes('js/app.js'));
    assert.equal(r.headers.get('cache-control'), 'private, no-cache');
  });

  await t.test('바뀌지 않았으면 304 (배포하면 바로 새 파일)', async () => {
    const first = await rq('GET', '/logo.png');
    assert.equal(first.headers.get('cache-control'), 'private, no-cache', 'Cloudflare 가 오래 보관하게 바꾸지 않게');
    const etag = first.headers.get('etag');
    assert.ok(etag);
    const again = await rq('GET', '/logo.png', { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get('etag'), etag);
    const other = await rq('GET', '/logo.png', { headers: { 'if-none-match': 'W/"0-0"' } });
    assert.equal(other.status, 200);
  });

  await t.test('HTML 보안 헤더', async () => {
    const r = await rq('GET', '/index.html');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'none'");
    assert.equal(r.headers.get('referrer-policy'), 'same-origin');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });

  await t.test('JS·CSS 종류', async () => {
    const js = await rq('GET', '/js/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /^text\/javascript/);
    assert.equal(js.headers.get('x-frame-options'), null, 'HTML 이 아니면 틀 막기 헤더 없음');
    const web = await rq('GET', '/js/web-cloud.js');
    assert.equal(web.status, 200);
    assert.match(web.headers.get('content-type'), /^text\/javascript/);
    const css = await rq('GET', '/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /^text\/css/);
  });

  await t.test('로고와 파비콘 모두 손글씨 ‘클라우드’ 앱 아이콘', async () => {
    const web = path.join(__dirname, '..', '..', 'launcher', 'src', 'renderer');
    const page = (await rq('GET', '/')).data.toString('utf8');
    assert.ok(page.includes('href="favicon.ico"'));
    const logo = await rq('GET', '/logo.png');
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    assert.deepEqual(logo.data, fs.readFileSync(path.join(web, 'logo.png')));
    const icon = await rq('GET', '/favicon.ico');
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/x-icon');
    assert.deepEqual(icon.data, fs.readFileSync(path.join(web, 'favicon.ico')));
    assert.equal((await rq('GET', '/logo.svg')).status, 404, '예전 ‘마고’ 로고는 없음');
  });

  await t.test('폴더 밖 파일은 404', async () => {
    for (const p of [
      '/..%2F..%2Fserver%2Fpackage.json',
      '/..%2Fpackage.json',
      '/..%2F..%2F..%2Fserver%2Fpackage.json',
      '/js/..%2F..%2F..%2F..%2Fserver%2Fpackage.json',
      '/..%5C..%5Cserver%5Cpackage.json',
      '/%2e%2e%2f%2e%2e%2fserver%2fpackage.json',
    ]) {
      const r = await rq('GET', p);
      assert.equal(r.status, 404, p);
      assert.equal(r.data.error.code, 'not_found', p);
    }
  });

  await t.test('/api/ 없는 주소는 JSON 404', async () => {
    const r = await rq('GET', '/api/없는주소');
    assert.equal(r.status, 404);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.equal(r.data.error.code, 'not_found');
    assert.equal((await rq('GET', '/api/index.html')).status, 404, '/api/ 아래는 정적 파일을 찾지 않음');
  });
});

test('웹 화면: 글꼴은 일주일 보관', async (t) => {
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-web-'));
  fs.mkdirSync(path.join(webDir, 'vendor', 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>웹</title>');
  fs.writeFileSync(path.join(webDir, 'vendor', 'fonts', 'Font.woff2'), 'font');
  const s = await startServer({ webDir });
  t.after(async () => {
    await s.close();
    fs.rmSync(webDir, { recursive: true, force: true });
  });

  const font = await s.request('GET', '/vendor/fonts/Font.woff2');
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.equal(font.headers.get('cache-control'), 'public, max-age=604800');
  assert.equal((await s.request('GET', '/')).data.toString('utf8'), '<!doctype html><title>웹</title>');
});

test('웹 화면이 없으면 지금처럼 내려받기 안내 페이지', async (t) => {
  const s = await startServer({ webDir: null });
  t.after(() => s.close());
  const r = await s.request('GET', '/');
  assert.equal(r.status, 200);
  const html = r.data.toString('utf8');
  assert.ok(html.includes('/download/launcher'));
  assert.ok(!html.includes('js/app.js'));
  assert.ok(html.includes('translate(137 262)'), '로고는 ‘마고’ 글자가 있는 앱 아이콘');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});
