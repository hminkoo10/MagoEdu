'use strict';

// 마고에듀 통합 클라우드 연결 (Electron·Node 프로그램용) - 구현민 개발
//
// 각 프로그램은 통합 클라우드에서 켜졌을 때만 동작한다. (개별 설치·실행 불가)
// 통합 클라우드가 넘겨준 실행 허가증(MAGOEDU_TICKET)을 서버 공개 키(trust.json)로 확인한다.
//
//   const cloud = require('./magoedu-cloud');
//   const session = cloud.check('ohdapnote', { packaged: app.isPackaged });
//   if (!session) {
//     dialog.showMessageBoxSync({ message: cloud.reason() });
//     cloud.openCloud('ohdapnote');
//     app.exit(0);
//   }
//   session.dataDir   // 같은 아이디면 어느 컴퓨터에서든 같은 데이터 (서버와 동기화)
//   session.localDir  // 이 컴퓨터에만 두는 데이터
//
// 개발할 때(빌드 전)는 MAGOEDU_DEV=1 로 통합 클라우드 없이 켤 수 있다.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RESTART_EXIT_CODE = 75; // 이 값으로 끝내면 통합 클라우드가 바로 다시 켠다 (새 버전 적용)
const TICKET_PREFIX = 'MGT1';
const CLOUD_DIR_NAME = 'MagoEduCloud';
let lastReason = '';

function defaultTrustFile() {
  let base;
  if (process.platform === 'win32') base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  else if (process.platform === 'darwin') base = path.join(os.homedir(), 'Library', 'Application Support');
  else base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, CLOUD_DIR_NAME, 'trust.json');
}

function trustFile(packaged, env = process.env) {
  // 빌드한 프로그램은 정해진 위치만 믿는다 (개발 중에만 환경 변수로 바꿀 수 있음)
  if (!packaged && env.MAGOEDU_TRUST_FILE) return env.MAGOEDU_TRUST_FILE;
  return defaultTrustFile();
}

function loadKeys(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (data.keys || []).filter((k) => k && k.kid && k.x);
  } catch {
    return [];
  }
}

function verifyTicket(ticket, keys, { appId, now = Date.now() } = {}) {
  const parts = String(ticket || '').split('.');
  if (parts.length !== 3 || parts[0] !== TICKET_PREFIX) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const k = keys.find((x) => x.kid === payload.kid);
  if (!k) return null;
  let ok = false;
  try {
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x }, format: 'jwk' });
    ok = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), pub, Buffer.from(parts[2], 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null;
  if (appId && payload.app !== appId) return null;
  return payload;
}

/** 통합 클라우드에서 켜졌는지 확인. 아니면 null (이유는 reason()) */
function check(appId, { packaged = true, env = process.env } = {}) {
  if (!packaged && env.MAGOEDU_DEV === '1') {
    const base = env.MAGOEDU_DEV_DIR || path.join(process.cwd(), '.magoedu-dev');
    const s = {
      appId,
      dev: true,
      user: { id: 'dev', username: 'dev', name: '개발자', role: 'admin', academy: '' },
      dataDir: env.MAGOEDU_DATA_DIR || path.join(base, 'sync'),
      localDir: env.MAGOEDU_LOCAL_DIR || path.join(base, 'local'),
      server: '',
      expiresAt: 0,
    };
    fs.mkdirSync(s.dataDir, { recursive: true });
    fs.mkdirSync(s.localDir, { recursive: true });
    lastReason = '';
    return s;
  }
  if (!env.MAGOEDU_TICKET) {
    lastReason = '이 프로그램은 마고에듀 통합 클라우드에서만 켤 수 있어요.\n통합 클라우드에 로그인한 뒤 ‘열기’를 눌러 주세요.';
    return null;
  }
  const keys = loadKeys(trustFile(packaged, env));
  if (!keys.length) {
    lastReason = '마고에듀 통합 클라우드에 한 번 로그인해 주세요.';
    return null;
  }
  const payload = verifyTicket(env.MAGOEDU_TICKET, keys, { appId });
  if (!payload) {
    lastReason = '실행 허가가 확인되지 않았어요. 통합 클라우드에서 다시 켜 주세요.\n(인터넷 없이 쓸 수 있는 기간이 지났다면 인터넷에 연결해 주세요.)';
    return null;
  }
  if (!env.MAGOEDU_DATA_DIR || !env.MAGOEDU_LOCAL_DIR) {
    lastReason = '통합 클라우드에서 다시 켜 주세요.';
    return null;
  }
  const s = {
    appId,
    dev: false,
    user: { id: payload.sub, username: payload.usr, name: payload.nam, role: payload.rol, academy: env.MAGOEDU_ACADEMY || '' },
    dataDir: env.MAGOEDU_DATA_DIR,
    localDir: env.MAGOEDU_LOCAL_DIR,
    server: env.MAGOEDU_SERVER || '',
    launcherVersion: env.MAGOEDU_LAUNCHER_VERSION || '',
    expiresAt: payload.exp * 1000,
    payload,
  };
  fs.mkdirSync(s.dataDir, { recursive: true });
  fs.mkdirSync(s.localDir, { recursive: true });
  lastReason = '';
  return s;
}

function reason() {
  return lastReason;
}

/** 통합 클라우드를 연다. appId 를 주면 그 프로그램을 켜 달라고 한다. */
function openCloud(appId) {
  const url = appId ? `magoedu://launch/${appId}` : 'magoedu://open';
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

function parseVersion(v) {
  const n = String(v || '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .slice(0, 4)
    .map(Number);
  while (n.length < 3) n.push(0);
  return n;
}

function newer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 4; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

/** 통합 클라우드가 새 버전을 받아 두었으면 그 버전 (프로그램을 75 로 끝내면 새 버전으로 다시 켜짐) */
function newerVersionInstalled(appId, currentVersion) {
  const base =
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), CLOUD_DIR_NAME)
      : path.join(path.dirname(defaultTrustFile()), 'local');
  try {
    const info = JSON.parse(fs.readFileSync(path.join(base, 'apps', appId, 'installed.json'), 'utf8'));
    return info.version && newer(info.version, currentVersion) ? info.version : null;
  } catch {
    return null;
  }
}

module.exports = { check, reason, verifyTicket, openCloud, newerVersionInstalled, RESTART_EXIT_CODE, defaultTrustFile };
