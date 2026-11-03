'use strict';

// 통합 클라우드를 지울 때 정리
//   설치 파일의 제거 프로그램이 `MagoEduCloud.exe --uninstall-cleanup` 으로 부른다 (업데이트·다시 설치할 때는 부르지 않음 — build/installer.nsh).
//   1) 통합 클라우드로 켠 프로그램(타종·오답노트 …)을 끈다: 먼저 창을 닫아 달라고 하고, 그래도 켜져 있으면 강제로
//   2) 설치한 프로그램(apps)과 받다 만 파일(downloads)을 지운다 (끈 다음에 — 파일이 잠기지 않게)
//   3) 통합 클라우드가 만든 프로그램 바로 가기(바탕 화면·시작 메뉴)를 지운다
//   (magoedu:// 주소와 자동 실행 등록은 main.js 에서 Electron 으로 지움.
//    로그인 정보·동기화한 데이터(userData)는 제거 프로그램에서 '데이터도 지우기'를 고른 경우에만 NSIS 가 지움)

// Electron 안에서는 .asar 파일을 폴더처럼 다루는 fs 대신 원래 fs (프로그램 폴더에 app.asar 가 있음 — core/installer.js 와 같은 이유)
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const { spawnSync } = require('node:child_process');
const { Runner } = require('../core/runner');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 프로그램과 그 프로그램이 띄운 프로세스까지 끈다 (force: 강제로) */
function killTree(pid, force) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, timeout: 10000 });
  else {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      /* 이미 꺼짐 */
    }
  }
}

/**
 * config: 통합 클라우드 설정 (config.shortcuts = { 프로그램 ID: { name: 바로 가기 파일 이름 } })
 * shortcuts: Shortcuts (설치한 통합 클라우드에서만, 없으면 바로 가기는 건너뜀)
 * → { stopped: [끈 프로그램 ID], removed: [지운 폴더], shortcuts: [지운 바로 가기 이름] }
 */
async function uninstallCleanup({ paths, config, shortcuts, runner = new Runner({ paths }), kill = killTree, graceMs = 5000, log = console }) {
  let ids = [];
  try {
    ids = fs.readdirSync(paths.appsDir);
  } catch {
    /* 설치한 프로그램 없음 */
  }
  const running = ids.map((id) => [id, runner.runningInfo(id)]).filter(([, r]) => r?.pid);
  for (const [, r] of running) kill(r.pid, false);
  const until = Date.now() + graceMs;
  while (Date.now() < until && running.some(([id]) => runner.isRunning(id))) await sleep(200);
  for (const [id, r] of running) if (runner.isRunning(id)) kill(r.pid, true);

  const removed = [];
  for (const dir of [paths.appsDir, paths.downloadsDir]) {
    if (!fs.existsSync(dir)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); // 방금 끈 프로그램이 잠깐 파일을 잡고 있을 수 있음
      removed.push(dir);
    } catch (err) {
      log.warn?.('[지우기] 폴더를 지우지 못했어요', dir, err.code || err.message);
    }
  }
  try {
    fs.rmdirSync(paths.localData); // 비었으면
  } catch {
    /* 다른 것이 남아 있음 */
  }

  const names = Object.values(config?.shortcuts || {})
    .map((rec) => rec?.name)
    .filter(Boolean);
  if (shortcuts) for (const name of names) shortcuts.remove(name);
  return { stopped: running.map(([id]) => id), removed, shortcuts: shortcuts ? names : [] };
}

module.exports = { uninstallCleanup };
