'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Installer } = require('../src/core/installer');
const { makePaths } = require('../src/core/paths');

test('설치 복구: 임시 다운로드·압축 해제만 정리하고 설치·실행 버전과 다른 파일은 보존', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-recover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = makePaths({ userData: path.join(root, 'roaming'), localData: path.join(root, 'local') });
  const installer = new Installer({ paths });
  await installer.recover(); // 처음 켤 때는 폴더가 없어도 됨
  const ap = paths.app('bell');
  const removed = [path.join(paths.downloadsDir, 'bell-2.0.zip'), path.join(paths.downloadsDir, 'bell-2.0.zip.part'), path.join(ap.root, '2.0.partial', 'half')];
  const kept = [
    path.join(ap.root, '1.1.partial', 'app.exe'), path.join(ap.root, '1.0.partial', 'app.exe'),
    path.join(ap.root, '0.9', 'app.exe'), path.join(ap.root, 'notes.partial'),
    path.join(paths.downloadsDir, 'notes.txt'), path.join(paths.downloadsDir, 'keep-1.zip', 'note'),
    paths.account('user').app('bell').state,
  ];
  for (const file of [...removed, ...kept]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'keep');
  }
  fs.writeFileSync(ap.installed, JSON.stringify({ version: '1.1.partial' }));
  fs.writeFileSync(ap.running, JSON.stringify({ version: '1.0.partial' }));
  const linked = path.join(paths.appsDir, 'linked');
  const outside = path.join(root, 'outside');
  const outsideFile = path.join(outside, '2.0.partial', 'keep');
  fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
  fs.writeFileSync(outsideFile, 'keep');
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await installer.recover();
  for (const file of removed) assert.equal(fs.existsSync(file), false, file);
  for (const file of [...kept, ap.installed, ap.running, outsideFile]) assert.equal(fs.existsSync(file), true, file);
  await installer.recover();
  assert.equal((await installer.installed('bell')).version, '1.1.partial');
});
