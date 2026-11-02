'use strict';

// Electron 으로 만든 프로그램(묶음 안에 resources/app.asar)을 통합 클라우드 안(Electron)에서 설치·업데이트·삭제할 수 있는지.
// Electron 의 fs 는 .asar 파일을 폴더처럼 다뤄서, 보통 fs 로는 풀지도(Invalid package) 지우지도 못한다.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeZip } = require('./lib/zipwriter');

let electron = null;
try {
  electron = require('electron'); // node 에서는 실행 파일 경로
} catch {
  /* 없으면 건너뜀 */
}

/** 파일 하나(a.txt)가 든 진짜 형식의 작은 asar */
function tinyAsar() {
  const json = Buffer.from(JSON.stringify({ files: { 'a.txt': { size: 1, offset: '0' } } }));
  const pad = (4 - (json.length % 4)) % 4;
  const header = Buffer.alloc(8 + json.length + pad);
  header.writeUInt32LE(4 + json.length + pad, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  return Buffer.concat([size, header, Buffer.from('x')]);
}

test('Electron 안에서 app.asar 가 든 묶음 설치 → 업데이트(예전 버전 지움) → 삭제', { skip: !electron && 'electron 이 없음' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-asar-'));
  const manifest = { format: 1, id: 'eapp', exe: 'EApp.exe' };
  for (const v of ['1.0.0', '1.1.0']) {
    fs.writeFileSync(
      path.join(dir, `${v}.zip`),
      makeZip({ 'magoedu-app.json': JSON.stringify({ ...manifest, version: v }), 'EApp.exe': 'x', 'resources/app.asar': tinyAsar(), 'resources/app.asar.unpacked/n.node': 'n' }),
    );
  }
  const script = path.join(dir, 'run.js');
  fs.writeFileSync(
    script,
    `
const path = require('node:path');
const ofs = require('original-fs');
const { Installer } = require(${JSON.stringify(path.join(__dirname, '../src/core/installer'))});
const { makePaths } = require(${JSON.stringify(path.join(__dirname, '../src/core/paths'))});
const dir = ${JSON.stringify(dir)};
const paths = makePaths({ userData: path.join(dir, 'roaming'), localData: path.join(dir, 'local') });
const api = { download: async (url, dest) => ofs.copyFileSync(path.join(dir, new URL(url, 'http://x').searchParams.get('version') + '.zip'), dest) };
const warns = [];
const inst = new Installer({ paths, log: { warn: (...a) => warns.push(a.join(' ')) } });
const app = (v) => ({ id: 'eapp', name: 'E', release: { version: v } });
(async () => {
  const out = { electron: process.versions.electron };
  const a = await inst.install(api, app('1.0.0'));
  out.asar1 = ofs.statSync(path.join(a.dir, 'resources', 'app.asar')).size;
  const b = await inst.install(api, app('1.1.0'));
  out.version = b.version;
  out.oldLeft = ofs.existsSync(a.dir);
  await inst.uninstall('eapp');
  out.rootLeft = ofs.existsSync(paths.app('eapp').root);
  out.warns = warns;
  console.log(JSON.stringify(out));
})().catch((err) => { console.log(JSON.stringify({ error: err.message })); });
`,
  );
  const r = spawnSync(electron, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60000 });
  fs.rmSync(dir, { recursive: true, force: true });
  const line = (r.stdout || '').trim().split(/\r?\n/).pop();
  assert.ok(line, `출력 없음: ${r.stderr}`);
  const out = JSON.parse(line);
  assert.equal(out.error, undefined, out.error);
  assert.ok(out.electron);
  assert.equal(out.asar1, tinyAsar().length, 'app.asar 를 그대로 풂');
  assert.equal(out.version, '1.1.0');
  assert.equal(out.oldLeft, false, '예전 버전 폴더를 지움');
  assert.equal(out.rootLeft, false, '삭제하면 폴더가 남지 않음');
  assert.deepEqual(out.warns, []);
});
