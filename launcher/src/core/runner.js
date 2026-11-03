'use strict';

// 프로그램 실행과 감시
//   - 실행 허가증·계정 정보·데이터 폴더를 환경 변수로 넘긴다 (docs/INTEGRATION.md)
//   - 끝나면 알려 준다(동기화). 끝난 코드가 75 면 바로 다시 켠다(새 버전 적용).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { writeJsonSync, readJsonSync } = require('./fsutil');

const STOP_GRACE_MS = 10 * 1000; // 끄기: 창 닫기 신호 뒤 이만큼 기다렸다가 강제로 끔
const FOCUS_PROBE_MS = 5000;
const FOCUS_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MagoEduWindow {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr window);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  public delegate bool EnumWindowsProc(IntPtr window, IntPtr extra);
  public static bool Focus(int pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((window, extra) => {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner != pid || GetWindowTextLength(window) == 0 || (GetWindowLong(window, -20) & 0x80) != 0) return true;
      // 숨긴 창(트레이)을 여기서 띄우면 프로그램은 숨긴 줄 알아서, 보이는 창(최소화 포함)만. 숨긴 창은 두 번째 실행으로 연다
      if (IsWindowVisible(window)) { found = window; return false; }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return false;
    ShowWindowAsync(found, IsIconic(found) ? 9 : 5);
    for (int i = 0; i < 20; i++) {
      if (IsWindowVisible(found)) {
        if (GetForegroundWindow() == found || SetForegroundWindow(found)) return true;
      }
      System.Threading.Thread.Sleep(25);
    }
    return false;
  }
}
'@
$targetPid = [int]$env:MAGOEDU_FOCUS_PID
if ([MagoEduWindow]::Focus($targetPid)) { exit 0 }
# 묶음 실행 파일이 실제 창을 자식 프로세스에 둔 경우 (PyInstaller 등)
foreach ($child in (Get-CimInstance Win32_Process -Filter "ParentProcessId = $targetPid" -ErrorAction SilentlyContinue)) {
  if ([MagoEduWindow]::Focus([int]$child.ProcessId)) { exit 0 }
}
exit 1
`;

function focusWindowByPid(pid, { platform = process.platform, execImpl = execFile } = {}) {
  if (platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      execImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(FOCUS_SCRIPT, 'utf16le').toString('base64')], {
        env: { ...process.env, MAGOEDU_FOCUS_PID: String(pid) },
        timeout: 8000,
        windowsHide: true,
      }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

function killFocusProbe(child) {
  if (process.platform !== 'win32') {
    child.kill('SIGKILL');
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, (err) => err ? reject(err) : resolve());
  });
}

function sanitizeRunning(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid > 0x7fffffff) return null;
  const out = { pid: value.pid };
  if (Number.isSafeInteger(value.startedAt) && value.startedAt >= 0 && value.startedAt <= Date.now() + 24 * 60 * 60 * 1000) out.startedAt = value.startedAt;
  if (typeof value.version === 'string' && /^[0-9A-Za-z._-]{1,80}$/.test(value.version)) out.version = value.version;
  if (typeof value.userId === 'string' && value.userId.length <= 80 && !/[\u0000-\u001f]/.test(value.userId)) out.userId = value.userId;
  return out;
}

function readRunning(file) {
  return sanitizeRunning(readJsonSync(file, null));
}

function buildEnv({ base = process.env, ticket, appId, user, appDirs, academy = false, requests = academy, academyInfo = false, ssoCode = '', dataKey = '', serverUrl, launcherVersion, trustFile }) {
  return {
    ...base,
    MAGOEDU_TICKET: ticket,
    MAGOEDU_APP_ID: appId,
    MAGOEDU_USER_ID: user.id,
    MAGOEDU_USERNAME: user.username,
    MAGOEDU_USER_NAME: user.name,
    MAGOEDU_ROLE: user.role,
    MAGOEDU_ACADEMY: user.academy?.name || '',
    MAGOEDU_ACADEMY_ID: academy && user.academy ? String(user.academy.id) : '',
    MAGOEDU_ACADEMY_DIR: academy && user.academy ? appDirs.academy : '', // 학원 공간 (학원이 없거나 쓰지 않는 프로그램은 빈 값)
    MAGOEDU_REQUEST_DIR: requests ? appDirs.requests : '', // 프로그램이 통합 클라우드에 부탁하는 곳 (학원 공간 파일·학생 명단·로그인 코드)
    MAGOEDU_ACADEMY_INFO: academyInfo && user.academy ? appDirs.academyInfo : '', // 학원 학생 명단·학원 AI (매니페스트 academyInfo)
    MAGOEDU_SSO_CODE: ssoCode || '', // 웹 프로그램 일회용 로그인 코드 (매니페스트 sso, 60초)
    MAGOEDU_DATA_DIR: appDirs.sync,
    MAGOEDU_LOCAL_DIR: appDirs.local,
    MAGOEDU_DATA_KEY: dataKey || '', // 설정 파일 서명 키 (매니페스트 dataSigning 인 프로그램만, 아니면 빈 값)
    MAGOEDU_SERVER: serverUrl,
    MAGOEDU_TRUST_FILE: trustFile,
    MAGOEDU_LAUNCHER_VERSION: launcherVersion,
    MAGOEDU_LAUNCHER_PID: String(process.pid),
  };
}

class Runner extends EventEmitter {
  constructor({ paths, log = console, spawnImpl = spawn, focusImpl = focusWindowByPid, killImpl = killFocusProbe }) {
    super();
    this.paths = paths;
    this.log = log;
    this.spawn = spawnImpl;
    this.focusImpl = focusImpl;
    this.killFocusProbe = killImpl;
    this.focusing = new Map();
    this.running = new Map(); // appId → { pid, child, startedAt, userId, version }
  }

  isRunning(appId) {
    const r = this.running.get(appId);
    if (r) return true;
    // 통합 클라우드를 다시 켰을 때, 그 전에 켜 둔 프로그램이 아직 돌고 있는지
    const rec = readRunning(this.paths.app(appId).running);
    if (!rec?.pid) return false;
    // 컴퓨터를 다시 켠 뒤라면 예전 기록 (같은 번호를 다른 프로그램이 쓰고 있을 수 있음)
    const bootedAt = Date.now() - os.uptime() * 1000;
    if (rec.startedAt && rec.startedAt < bootedAt - 60 * 1000) {
      fs.rmSync(this.paths.app(appId).running, { force: true });
      return false;
    }
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
    const rec = readRunning(this.paths.app(appId).running);
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
    this.running.set(appId, { ...rec, child, env, installed });
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

  /** 먼저 기존 창을 찾고, 필요하면 같은 실행에 두 번째 실행을 전달한다. 연타는 한 번으로 합침 */
  focus({ appId, timeoutMs = FOCUS_PROBE_MS }) {
    if (this.focusing.has(appId)) return this.focusing.get(appId);
    const work = this._focus(appId, timeoutMs).finally(() => this.focusing.delete(appId));
    this.focusing.set(appId, work);
    return work;
  }

  async _focus(appId, timeoutMs) {
    const info = this.runningInfo(appId);
    if (!info?.pid) return { focused: false };
    const focus = () => Promise.resolve().then(() => this.focusImpl(info.pid)).catch(() => false);
    if (await focus()) return { focused: true };
    const r = this.running.get(appId);
    // 다시 켠 런처는 원래 환경을 모르므로 PID로만 복구. 업데이트된 exe를 대신 실행하지 않음
    if (r?.pid === info.pid && r.env && r.installed && r.installed.manifest.singleInstance !== false && !r.focusRelayFailed) {
      const { installed, env } = r;
      const m = installed.manifest;
      const exe = path.join(installed.dir, ...m.exe.split('/'));
      try {
        if (!fs.existsSync(exe)) throw new Error('실행 파일이 없어요.');
        const probe = this.spawn(exe, m.args || [], {
          cwd: installed.dir,
          env,
          detached: false,
          stdio: 'ignore',
          windowsHide: false,
        });
        const probeExited = await new Promise((resolve) => {
          let done = false;
          let timer;
          const finish = (exited) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(exited);
          };
          timer = setTimeout(() => finish(false), timeoutMs);
          probe.once('exit', () => finish(true));
          probe.once('error', () => finish(true));
        });
        if (!probeExited) {
          r.focusRelayFailed = true;
          await this.killFocusProbe(probe);
        }
      } catch (err) {
        this.log.warn?.(`[창 복구] ${appId}: 두 번째 실행 전달 실패`, err.message);
      }
    }
    if (this.runningInfo(appId)?.pid !== info.pid) return { focused: false };
    return { focused: !!(await focus()) };
  }

  stop(appId, { graceMs = STOP_GRACE_MS } = {}) {
    const r = this.running.get(appId);
    const pid = r?.pid || readRunning(this.paths.app(appId).running)?.pid;
    if (!pid) return false;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true });
      else process.kill(pid, 'SIGTERM');
    } catch {
      return false;
    }
    // 창을 닫으면 트레이로 숨기만 하는 프로그램(타종)도 있어서, 잠시 뒤에도 켜져 있으면 강제로 끈다
    setTimeout(() => {
      if (!this.isRunning(appId) || this.runningInfo(appId)?.pid !== pid) return;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        else process.kill(pid, 'SIGKILL');
      } catch {
        /* 이미 꺼짐 */
      }
    }, graceMs).unref();
    return true;
  }
}

module.exports = { Runner, buildEnv, sanitizeRunning, focusWindowByPid };
