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
//   session.academyDir  // 학원 공간: 같은 학원 사람들이 함께 쓰는 데이터 (매니페스트에 shared, 학원이 없으면 '')
//   await cloud.requestFiles(session, ['books/b1/a.pdf'])  // 학원 공간의 '열 때만 받는' 파일 받기
//   await cloud.removeFiles(session, ['books/b1/a.pdf'])   // 받지 않은 파일을 서버에서 지우기 (교재를 지울 때)
//
// 학원 학생 명단·학원 AI (매니페스트 "academyInfo": true, 학원에 속한 계정):
//   cloud.academyInfo(session)              // { academy, me, members, students, purged, purgeDays, ai } (없으면 null)
//   const stop = cloud.watchAcademyInfo(session, (info) => ...)   // 바뀔 때마다
//   await cloud.saveStudent(session, { name: '홍길동', ... })   // 추가 (rev 를 주면 고치기) → { ok, student, error?, errorCode? }
//   await cloud.deleteStudent(session, id) / cloud.restoreStudent(session, id)
// 웹 프로그램 로그인 (매니페스트 "sso": "<웹 프로그램 ID>"):
//   session.ssoCode                         // 켤 때 받은 60초짜리 일회용 코드
//   await cloud.ssoCode(session)            // 다시 받기 → { ok, code, expiresAt, error?, errorCode? }
//
// 개발할 때(빌드 전)는 MAGOEDU_DEV=1 로 통합 클라우드 없이 켤 수 있다.
// (계정·폴더는 통합 클라우드와 같은 이름의 환경 변수로 바꿀 수 있음: MAGOEDU_USER_ID, MAGOEDU_ACADEMY_DIR …)

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
      user: {
        id: env.MAGOEDU_USER_ID || 'dev',
        username: env.MAGOEDU_USERNAME || 'dev',
        name: env.MAGOEDU_USER_NAME || '개발자',
        role: env.MAGOEDU_ROLE || 'admin',
        academy: env.MAGOEDU_ACADEMY || '',
      },
      dataDir: env.MAGOEDU_DATA_DIR || path.join(base, 'sync'),
      localDir: env.MAGOEDU_LOCAL_DIR || path.join(base, 'local'),
      academyId: env.MAGOEDU_ACADEMY_ID || '',
      academyDir: env.MAGOEDU_ACADEMY_DIR || '',
      requestDir: env.MAGOEDU_REQUEST_DIR || '',
      academyInfoFile: env.MAGOEDU_ACADEMY_INFO || '',
      ssoCode: env.MAGOEDU_SSO_CODE || '',
      server: env.MAGOEDU_SERVER || '', // 시험할 때 학원 AI 중계를 쓰려면 MAGOEDU_SERVER·MAGOEDU_TICKET
      ticket: env.MAGOEDU_TICKET || '',
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
    academyId: env.MAGOEDU_ACADEMY_ID || '',
    academyDir: env.MAGOEDU_ACADEMY_DIR || '', // 학원이 없거나 학원 공간을 쓰지 않는 프로그램은 ''
    requestDir: env.MAGOEDU_REQUEST_DIR || '',
    academyInfoFile: env.MAGOEDU_ACADEMY_INFO || '', // 학원 학생 명단·학원 AI (매니페스트 academyInfo, 학원이 없으면 '')
    ssoCode: env.MAGOEDU_SSO_CODE || '', // 웹 프로그램 일회용 로그인 코드 (매니페스트 sso, 인터넷이 없었으면 '')
    server: env.MAGOEDU_SERVER || '',
    ticket: env.MAGOEDU_TICKET, // 학원 AI 중계의 키 자리에 넣음 (academyAi)
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

/**
 * 학원 공간의 '열 때만 받는' 파일(매니페스트 shared.lazy)을 통합 클라우드에 받아 달라고 하고, 다 받을 때까지 기다린다.
 * paths: 학원 공간 안의 경로 ('/' 로 구분). 이미 있는 파일은 건너뛴다.
 * → { ok, missing: [받지 못한 경로], error? }   (서버에 없거나 인터넷이 끊겼거나 시간이 지남)
 */
async function requestFiles(session, paths, { timeoutMs = 120000 } = {}) {
  const want = [...new Set(paths.map((p) => String(p).replace(/\\/g, '/')))];
  const need = want.filter((p) => !session.academyDir || !fs.existsSync(path.join(session.academyDir, ...p.split('/'))));
  if (!need.length) return { ok: true, missing: [] };
  if (!session.requestDir) return { ok: false, missing: need, error: '학원 공간을 쓰지 않아요.' };
  return ask(session, { paths: need }, timeoutMs);
}

/**
 * 학원 공간에서 이 컴퓨터에 받지 않은 파일을 서버에서 지워 달라고 한다 (폴더에 없는 파일은 지울 수 없으니).
 * 있는 파일은 그냥 폴더에서 지우면 된다. → { ok, missing: [서버에 남은 경로], error? }
 */
async function removeFiles(session, paths, { timeoutMs = 120000 } = {}) {
  const list = [...new Set(paths.map((p) => String(p).replace(/\\/g, '/')))];
  if (!list.length || !session.requestDir) return { ok: !list.length, missing: list };
  return ask(session, { remove: list }, timeoutMs);
}

/** 학원 학생 명단·학원 AI. 파일이 없거나 읽을 수 없으면 null */
function academyInfo(session) {
  if (!session.academyInfoFile) return null;
  try {
    return JSON.parse(fs.readFileSync(session.academyInfoFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 학원 AI 를 부를 곳 (키는 통합 클라우드 서버에만 있음). 학원 AI 가 없으면 null
 * → { provider, model, model2, rpm, source, baseUrl, apiKey }: 그 AI 의 주소·키 자리에 그대로 넣어 부르면 된다.
 *   relay: baseUrl 은 서버의 중계 주소, apiKey 는 실행 허가증 (서버가 진짜 키로 바꿔 보냄)
 *   direct: 학원 안 주소(192.168.x.x 등)라 각 PC 에서 바로 (키 없음)
 */
function academyAi(session, info = academyInfo(session)) {
  const ai = info?.ai;
  if (!ai?.provider) return null;
  const out = { provider: ai.provider, model: ai.model || '', model2: ai.model2 || '', rpm: ai.rpm ?? null, source: ai.source || '' };
  if (ai.relay) {
    if (!session.server || !session.ticket) return null;
    return { ...out, baseUrl: `${session.server.replace(/\/+$/, '')}/api/ai/relay/${encodeURIComponent(session.appId)}`, apiKey: session.ticket };
  }
  if (ai.direct) return { ...out, baseUrl: ai.baseUrl || '', apiKey: '' };
  return { ...out, baseUrl: ai.baseUrl || '', apiKey: ai.apiKey || '' }; // 키를 그대로 주던 예전 서버
}

/** 학원 학생 명단·학원 AI 가 바뀔 때마다 cb(info). 그만 볼 때는 돌려준 함수를 부른다 */
function watchAcademyInfo(session, cb, { delayMs = 200 } = {}) {
  if (!session.academyInfoFile) return () => {};
  const file = session.academyInfoFile;
  let timer = null;
  let last = academyInfo(session)?.updatedAt ?? null;
  const fire = () => {
    timer = null;
    const info = academyInfo(session);
    if (!info || info.updatedAt === last) return;
    last = info.updatedAt;
    cb(info);
  };
  let w = null;
  try {
    // 파일은 새로 써서 바꿔치기하므로 폴더를 본다
    fs.mkdirSync(path.dirname(file), { recursive: true });
    w = fs.watch(path.dirname(file), (_type, name) => {
      if (name && String(name) !== path.basename(file)) return;
      clearTimeout(timer);
      timer = setTimeout(fire, delayMs);
    });
    w.on('error', () => {});
  } catch {
    /* 지켜볼 수 없으면 아래 주기 확인만 */
  }
  const poll = setInterval(fire, 30 * 1000); // 알림을 놓쳐도
  poll.unref?.();
  return () => {
    clearTimeout(timer);
    clearInterval(poll);
    w?.close();
  };
}

/**
 * 학생 추가·고치기. student.rev 가 있으면 고치기(그사이 다른 사람이 고쳤으면 errorCode 'conflict' + 지금 student),
 * 없으면 추가 (id 를 주면 그 ID 로, 이미 있으면 그대로 돌려줌). 인터넷이 필요하다.
 * → { ok, student?, error?, errorCode? }
 */
function saveStudent(session, student, opts) {
  return op(session, { op: 'students.save', student }, opts);
}

/** 학생 지우기 (정한 날짜 안에는 학원 사람 누구나 되살릴 수 있음) → { ok, student?, error?, errorCode? } */
function deleteStudent(session, id, opts) {
  return op(session, { op: 'students.delete', id }, opts);
}

function restoreStudent(session, id, opts) {
  return op(session, { op: 'students.restore', id }, opts);
}

/** 웹 프로그램 일회용 로그인 코드 다시 받기 (60초) → { ok, code?, expiresAt?, error?, errorCode? } */
async function ssoCode(session, opts) {
  const r = await op(session, { op: 'sso.code' }, opts);
  return r.ok ? { ok: true, code: r.ssoCode, expiresAt: r.expiresAt } : r;
}

async function op(session, body, { timeoutMs = 30000 } = {}) {
  if (!session.requestDir) return { ok: false, error: '통합 클라우드에서 다시 켜 주세요.', errorCode: 'no_request_dir' };
  const { ok, error, errorCode, missing, ...rest } = await ask(session, body, timeoutMs);
  // errorCode: 서버 오류 코드(conflict·student_deleted …) 또는 offline·timeout
  return { ok, ...rest, ...(ok ? {} : { error: error || '하지 못했어요.', errorCode: errorCode || 'failed' }) };
}

/** requests/<rid>.json 을 쓰면 통합 클라우드가 처리한 뒤 <rid>.done.json { ok, missing, error?, ... } 으로 답한다 */
async function ask(session, body, timeoutMs) {
  const all = [...(body.paths || []), ...(body.remove || [])];
  const rid = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const req = path.join(session.requestDir, `${rid}.json`);
  const done = path.join(session.requestDir, `${rid}.done.json`);
  fs.mkdirSync(session.requestDir, { recursive: true });
  fs.writeFileSync(`${req}.tmp`, JSON.stringify(body));
  fs.renameSync(`${req}.tmp`, req);
  const end = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 100));
    let answer = null;
    try {
      answer = JSON.parse(fs.readFileSync(done, 'utf8'));
    } catch {
      /* 아직 */
    }
    if (answer) {
      fs.rmSync(done, { force: true });
      return { ...answer, ok: !!answer.ok, missing: answer.missing || [] };
    }
    if (Date.now() > end) {
      fs.rmSync(req, { force: true });
      return { ok: false, missing: all, error: '시간 안에 끝나지 않았어요.', errorCode: 'timeout' };
    }
  }
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

/**
 * 통합 클라우드에서 켜지 않았을 때(check 가 null) 안내 없이 통합 클라우드에 넘겨서 켜 달라고 할지.
 * installed: 통합 클라우드가 설치되어 있는지 (magoedu:// 주소를 열 수 있음 — Electron 은 app.getApplicationNameForProtocol).
 * 통합 클라우드가 켰는데 확인이 안 된 것(MAGOEDU_TICKET 이 있음)은 다시 넘기지 않음 (서로 계속 켜지 않게) → 안내
 */
function shouldHandOff({ installed, env = process.env } = {}) {
  return !!installed && !env.MAGOEDU_TICKET;
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

module.exports = {
  check,
  reason,
  requestFiles,
  removeFiles,
  academyInfo,
  academyAi,
  watchAcademyInfo,
  saveStudent,
  deleteStudent,
  restoreStudent,
  ssoCode,
  verifyTicket,
  openCloud,
  shouldHandOff,
  newerVersionInstalled,
  RESTART_EXIT_CODE,
  defaultTrustFile,
};
