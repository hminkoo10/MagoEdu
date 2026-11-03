'use strict';

// 통합 클라우드를 지울 때 정리 (src/main/uninstall.js): 켜 둔 프로그램 끄기, 설치한 프로그램·프로그램 바로 가기 지우기

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { makePaths } = require('../src/core/paths');
const { uninstallCleanup } = require('../src/main/uninstall');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('지울 때: 켜 둔 프로그램은 (창을 닫아도 안 꺼지면 강제로) 끄고, 설치한 프로그램과 통합 클라우드가 만든 바로 가기를 지움', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-uninstall-'));
  const paths = makePaths({ userData: path.join(dir, 'roaming'), localData: path.join(dir, 'local') });
  // 켜져 있는 프로그램 (창이 없어 닫아 달라는 말을 듣지 않음 → 강제로 꺼야 함)
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });
  t.after(() => {
    if (alive(child.pid)) process.kill(child.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = (id, rec) => {
    fs.mkdirSync(paths.app(id).root, { recursive: true });
    fs.writeFileSync(paths.app(id).running, JSON.stringify(rec));
  };
  write('tajong', { pid: child.pid, startedAt: Date.now() });
  write('ohdapnote', { pid: 999999, startedAt: Date.now() }); // 이미 꺼진 프로그램의 기록
  fs.mkdirSync(path.join(paths.app('ohdapnote').root, '0.3.2', 'resources'), { recursive: true });
  fs.writeFileSync(path.join(paths.app('ohdapnote').root, '0.3.2', 'resources', 'app.asar'), 'x');
  fs.mkdirSync(paths.downloadsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.downloadsDir, 'ohdapnote-0.3.3.zip'), 'x');
  // 로그인 정보·동기화한 데이터는 그대로 (지울지는 제거 프로그램에서 고름)
  fs.mkdirSync(paths.account('u1').app('ohdapnote').sync, { recursive: true });
  fs.writeFileSync(paths.configFile, '{}');

  const removed = [];
  const shortcuts = { remove: (name) => removed.push(name) };
  const config = { shortcuts: { tajong: { desktop: true, name: '마고 타종.lnk' }, ohdapnote: { desktop: false, name: '오답노트.lnk' }, gone: null } };

  const r = await uninstallCleanup({ paths, config, shortcuts, graceMs: 500 });
  assert.deepEqual(r.stopped, ['tajong']);
  for (let i = 0; i < 50 && alive(child.pid); i += 1) await new Promise((res) => setTimeout(res, 100));
  assert.equal(alive(child.pid), false, '켜 둔 프로그램이 꺼짐');
  assert.equal(fs.existsSync(paths.appsDir), false, '설치한 프로그램을 지움');
  assert.equal(fs.existsSync(paths.downloadsDir), false, '받다 만 파일을 지움');
  assert.equal(fs.existsSync(paths.localData), false, '빈 폴더도 지움');
  assert.equal(fs.existsSync(paths.account('u1').app('ohdapnote').sync), true, '동기화한 데이터는 남김');
  assert.equal(fs.existsSync(paths.configFile), true, '로그인·설정은 남김');
  assert.deepEqual(removed.sort(), ['마고 타종.lnk', '오답노트.lnk']);
  assert.deepEqual(r.shortcuts.sort(), ['마고 타종.lnk', '오답노트.lnk']);
});

test('지울 때: 설치한 프로그램·설정이 없어도 그냥 끝남', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-uninstall-'));
  try {
    const paths = makePaths({ userData: path.join(dir, 'roaming'), localData: path.join(dir, 'local') });
    const r = await uninstallCleanup({ paths, config: {}, shortcuts: null });
    assert.deepEqual(r, { stopped: [], removed: [], shortcuts: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
