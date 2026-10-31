'use strict';

// Electron 화면 시험 도우미: 실제 서버를 띄우고, 통합 클라우드를 Playwright 로 켠다.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { startServer, ADMIN_PASSWORD } = require('../../../server/test/helpers');
const { makeZip } = require('../lib/zipwriter');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'test', 'out');

async function startAll({ adminPassword } = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer(adminPassword === undefined ? {} : { adminPassword });
  // 시험용 프로그램 두 개
  const exe = '#!/bin/sh\nsleep 2\nexit 0\n';
  for (const [id, name, file, desc, color] of [
    ['tajong', '마고 타종', 'MaplTajong', '정해진 시간에 학원 종을 울려 주는 타종 프로그램', '#F76B15'],
    ['ohdapnote', '오답노트', 'OhdapNote', '문제집과 답지를 올리면 틀린 문제만 모아 PDF로 만들어 주는 오답노트', '#FF8A33'],
  ]) {
    server.app.deps.catalog.upsert({ id, name, description: desc, color, source: { type: 'local' }, iconUrl: '' });
    const dir = path.join(server.dataDir, 'packages', id);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = { format: 1, id, exe: 'run.sh', sync: { include: ['**'], groups: [{ pattern: 'projects/*', cold: true }] } };
    fs.writeFileSync(path.join(dir, `${file}-1.0.0-win-x64.zip`), makeZip({ 'magoedu-app.json': JSON.stringify(manifest), 'run.sh': exe }));
    await server.app.deps.catalog.refreshApp(id);
  }
  const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-ui-'));
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [ROOT, '--no-sandbox'],
    env: {
      ...process.env,
      MAGOEDU_CLOUD_TEST: '1',
      MAGOEDU_CLOUD_NO_UPDATE: '1',
      MAGOEDU_CLOUD_USER_DATA: path.join(userRoot, 'roaming'),
      MAGOEDU_CLOUD_LOCAL_DATA: path.join(userRoot, 'local'),
    },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1200, height: 780 });
  return {
    server,
    app,
    page,
    errors,
    ADMIN_PASSWORD,
    async shot(name) {
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
