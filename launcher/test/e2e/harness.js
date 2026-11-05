'use strict';

// Electron 화면 시험 도우미: 실제 서버를 띄우고, 통합 클라우드를 Playwright 로 켠다.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { startServer, ADMIN_PASSWORD } = require('../../../server/test/helpers');
const { makeZip } = require('../lib/zipwriter');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(os.tmpdir(), 'magoedu-ui-out');

async function startAll({ adminPassword } = {}) {
  if (process.env.MAGOEDU_E2E_SCREENSHOTS !== '0') fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer(adminPassword === undefined ? {} : { adminPassword });
  // 시험용 프로그램 두 개
  const windows = process.platform === 'win32';
  const exe = windows ? fs.readFileSync(process.execPath) : '#!/bin/sh\nsleep 6\nexit 0\n';
  const executable = windows ? 'test-node.exe' : 'run.sh';
  for (const [id, name, file, desc, color] of [
    ['tajong', '마고 타종', 'MaplTajong', '정해진 시간에 학원 종을 울려 주는 타종 프로그램', '#F76B15'],
    ['ohdapnote', '오답노트', 'OhdapNote', '문제집과 답지를 올리면 틀린 문제만 모아 PDF로 만들어 주는 오답노트', '#FF8A33'],
  ]) {
    server.app.deps.catalog.upsert({ id, name, description: desc, color, source: { type: 'local' }, iconUrl: '' });
    const dir = path.join(server.dataDir, 'packages', id);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = { format: 1, id, exe: executable, ...(windows ? { args: ['-e', 'setTimeout(() => {}, 6000)'] } : {}), sync: { include: ['**'], groups: [{ pattern: 'projects/*', cold: true }] } };
    fs.writeFileSync(path.join(dir, `${file}-1.0.0-win-x64.zip`), makeZip({ 'magoedu-app.json': JSON.stringify(manifest), [executable]: exe }));
    await server.app.deps.catalog.refreshApp(id);
  }
  // 안드로이드 항목(기본 목록)도 아이콘을 받으러 가지 않게
  server.app.deps.catalog.upsert({ id: 'tajong-android', iconUrl: '' });
  const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-ui-'));
  // 빈 주소는 설치 기본값으로 대체되므로, 시작부터 로컬 시험 서버로 고정.
  fs.mkdirSync(path.join(userRoot, 'roaming'), { recursive: true });
  fs.writeFileSync(path.join(userRoot, 'roaming', 'config.json'), JSON.stringify({ serverUrl: server.base }));
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [ROOT, '--no-sandbox'],
    env: {
      ...process.env,
      MAGOEDU_CLOUD_TEST: '1',
      MAGOEDU_CLOUD_NO_UPDATE: '1',
      MAGOEDU_CLOUD_USER_DATA: path.join(userRoot, 'roaming'),
      MAGOEDU_CLOUD_LOCAL_DATA: path.join(userRoot, 'local'),
      APPDATA: path.join(userRoot, 'appdata'),
      LOCALAPPDATA: path.join(userRoot, 'localappdata'),
    },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 800 });
  return {
    server,
    app,
    page,
    errors,
    ADMIN_PASSWORD,
    async shot(name) {
      if (process.env.MAGOEDU_E2E_SCREENSHOTS === '0') {
        if (name === '04-installed' && process.env.MAGOEDU_REVIEW_DIR) {
          await page.waitForFunction(() => !document.querySelector('.toast:not(.out)'));
          const png = await page.screenshot({ scale: 'css', animations: 'disabled' });
          require('node:assert/strict').ok(png.length < 400 * 1024);
          fs.mkdirSync(process.env.MAGOEDU_REVIEW_DIR, { recursive: true });
          fs.writeFileSync(path.join(process.env.MAGOEDU_REVIEW_DIR, '프로그램-1280.png'), png);
        }
        return;
      }
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    },
    async close() {
      await app.close().catch(() => {});
      await server.close();
      fs.rmSync(userRoot, { recursive: true, force: true });
    },
  };
}

module.exports = { startAll, OUT };
