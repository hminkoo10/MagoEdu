'use strict';

// 프로그램 실행과 감시
//   - 실행 허가증·계정 정보·데이터 폴더를 환경 변수로 넘긴다 (docs/INTEGRATION.md)
//   - 끝나면 알려 준다(동기화). 끝난 코드가 75 면 바로 다시 켠다(새 버전 적용).

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { writeJsonSync, readJsonSync } = require('./fsutil');

function buildEnv({ base = process.env, ticket, appId, user, appDirs, serverUrl, launcherVersion, trustFile }) {
  return {
    ...base,
    MAGOEDU_TICKET: ticket,
    MAGOEDU_APP_ID: appId,
    MAGOEDU_USER_ID: user.id,
    MAGOEDU_USERNAME: user.username,
    MAGOEDU_USER_NAME: user.name,
    MAGOEDU_ROLE: user.role,
    MAGOEDU_ACADEMY: user.academy?.name || '',
    MAGOEDU_DATA_DIR: appDirs.sync,
    MAGOEDU_LOCAL_DIR: appDirs.local,
    MAGOEDU_SERVER: serverUrl,
    MAGOEDU_TRUST_FILE: trustFile,
    MAGOEDU_LAUNCHER_VERSION: launcherVersion,
    MAGOEDU_LAUNCHER_PID: String(process.pid),
  };
}

class Runner extends EventEmitter {
  constructor({ paths, log = console, spawnImpl = spawn }) {
    super();
    this.paths = paths;
    this.log = log;
    this.spawn = spawnImpl;
    this.running = new Map(); // appId → { pid, child, startedAt, userId, version }
  }

  isRunning(appId) {
    const r = this.running.get(appId);
    if (r) return true;
    // 통합 클라우드를 다시 켰을 때, 그 전에 켜 둔 프로그램이 아직 돌고 있는지
    const rec = readJsonSync(this.paths.app(appId).running, null);
    if (!rec?.pid) return false;
    try {
      process.kill(rec.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  runningInfo(appId) {
    const r = this.running.get(appId);
    if (r) return { pid: r.pid, startedAt: r.startedAt, version: r.version, userId: r.userId };
    const rec = readJsonSync(this.paths.app(appId).running, null);
    return rec && this.isRunning(appId) ? rec : null;
  }

  launch({ appId, installed, env }) {
    if (this.isRunning(appId)) throw new Error('이미 켜져 있어요.');
    const m = installed.manifest;
    const exe = path.join(installed.dir, ...m.exe.split('/'));
    if (!fs.existsSync(exe)) throw new Error('실행 파일이 없어요. 다시 설치해 주세요.');
    const child = this.spawn(exe, m.args || [], {
      cwd: installed.dir,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    const rec = { pid: child.pid, startedAt: Date.now(), userId: env.MAGOEDU_USER_ID, version: installed.version };
    this.running.set(appId, { ...rec, child });
    try {
      writeJsonSync(this.paths.app(appId).running, rec);
    } catch {
      /* 무시 */
    }
    child.on('error', (err) => {
      this.running.delete(appId);
      this.emit('error', appId, err);
    });
    child.on('exit', (code) => {
      this.running.delete(appId);
      try {
        fs.rmSync(this.paths.app(appId).running, { force: true });
      } catch {
        /* 무시 */
      }
      this.emit('exit', appId, { code, restart: code === m.restartExitCode, userId: rec.userId });
    });
    this.emit('start', appId, rec);
    return rec;
  }

  stop(appId) {
    const r = this.running.get(appId);
    const pid = r?.pid || readJsonSync(this.paths.app(appId).running, null)?.pid;
    if (!pid) return false;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true });
      else process.kill(pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { Runner, buildEnv };
