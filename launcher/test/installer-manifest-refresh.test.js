'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Installer } = require('../src/core/installer');
const { makePaths } = require('../src/core/paths');

function setup(t, manifest = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-manifest-refresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = makePaths({ userData: path.join(root, 'roaming'), localData: path.join(root, 'local') });
  const installer = new Installer({ paths });
  const ap = paths.app('ohdapnote');
  const appDir = path.join(ap.root, '0.4.37');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'ohdapnote.exe'), 'exe');
  fs.writeFileSync(path.join(ap.installed), JSON.stringify({
    id: 'ohdapnote',
    name: '오답노트',
    version: '0.4.37',
    manifest: { id: 'ohdapnote', version: '0.4.37', exe: 'ohdapnote.exe', stopArgs: ['--quit'] },
  }));
  if (manifest !== null) fs.writeFileSync(path.join(appDir, 'magoedu-app.json'), JSON.stringify(manifest));
  return { installer, ap, appDir };
}

test('설치 정보: 예전 런처가 적은 installed.json 이라도 설치 폴더의 magoedu-app.json 에서 새 항목(viewOnly)을 읽음', async (t) => {
  const { installer } = setup(t, {
    id: 'ohdapnote',
    version: '0.4.37',
    exe: 'ohdapnote.exe',
    viewOnly: true,
    shared: { include: ['**/*.db'] },
  });
  const info = await installer.installed('ohdapnote');
  assert.equal(info.manifest.viewOnly, true);
  assert.deepEqual(info.manifest.shared, { include: ['**/*.db'], exclude: [], lazy: [] });
  assert.equal((await installer.listInstalled()).ohdapnote.manifest.viewOnly, true);
});

test('설치 정보: 다시 읽기만 하고 installed.json 은 고치지 않음', async (t) => {
  const { installer, ap } = setup(t, { viewOnly: true, exe: 'ohdapnote.exe' });
  const before = fs.readFileSync(ap.installed);
  await installer.installed('ohdapnote');
  assert.deepEqual(fs.readFileSync(ap.installed), before);
});

test('설치 정보: 설치 폴더에 magoedu-app.json 이 없으면 installed.json 그대로', async (t) => {
  const { installer } = setup(t, null);
  const info = await installer.installed('ohdapnote');
  assert.equal(info.manifest.viewOnly, false);
  assert.equal(info.manifest.exe, 'ohdapnote.exe');
  assert.deepEqual(info.manifest.stopArgs, ['--quit']);
});

test('설치 정보: magoedu-app.json 이 깨졌으면 installed.json 그대로', async (t) => {
  const { installer, appDir } = setup(t, { viewOnly: true });
  fs.writeFileSync(path.join(appDir, 'magoedu-app.json'), '{invalid');
  const info = await installer.installed('ohdapnote');
  assert.equal(info.manifest.viewOnly, false);
});

test('설치 정보: 다시 읽은 실행 파일 이름이 다르면 installed.json 그대로', async (t) => {
  const { installer } = setup(t, { viewOnly: true, exe: 'other.exe' });
  const info = await installer.installed('ohdapnote');
  assert.equal(info.manifest.viewOnly, false);
  assert.equal(info.manifest.exe, 'ohdapnote.exe');
});

test('설치 정보: magoedu-app.json 에 실행 파일 이름이 없으면 installed.json 의 이름을 씀', async (t) => {
  const { installer } = setup(t, { viewOnly: true });
  const info = await installer.installed('ohdapnote');
  assert.equal(info.manifest.viewOnly, true);
  assert.equal(info.manifest.exe, 'ohdapnote.exe');
});
