'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let electron;
try { electron = require('electron'); } catch { /* 없으면 건너뜀 */ }
// 화면 없는 리눅스(CI)에서는 Electron 창을 띄울 수 없음 — 화면 시험은 test:ui(xvfb)에서
const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

test('업데이트 화면: 실제 Electron에서 설정·카드 반응, 대기·오류·재시도, 글자 크기·폭 확인', { skip: (!electron && 'electron 이 없음') || (noDisplay && '화면(DISPLAY)이 없음') }, () => {
  const root = fs.mkdtempSync(path.join(__dirname, '.update-ui-'));
  try {
    const env = { ...process.env, TEMP: root, TMP: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(electron, [path.join(__dirname, 'lib/selfupdate-ui.cjs'), root, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], {
      env, encoding: 'utf8', timeout: 45000, windowsHide: true,
    });
    assert.equal(r.status, 0, `${r.error || ''}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /UPDATE_UI_OK/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
