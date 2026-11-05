'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let electron;
try { electron = require('electron'); } catch { /* 없으면 건너뜀 */ }

test('업데이트 화면: 실제 Electron에서 설정·카드 반응, 대기·오류·재시도, 글자 크기·폭 확인', { skip: !electron && 'electron 이 없음' }, () => {
  const root = fs.mkdtempSync(path.join(__dirname, '.update-ui-'));
  try {
    const env = { ...process.env, TEMP: root, TMP: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(electron, [path.join(__dirname, 'lib/selfupdate-ui.cjs'), root], {
      env, encoding: 'utf8', timeout: 45000, windowsHide: true,
    });
    assert.equal(r.status, 0, `${r.error || ''}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /UPDATE_UI_OK/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
