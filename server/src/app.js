'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { openDb } = require('./db');
const { Router, sendJson, sendError, clientIp, serveStatic } = require('./http');
const { HttpError, intOr, normalizeUsername, randomPassword } = require('./util');
const { hashPassword, loadOrCreateSigningKey, loadOrCreateSecret } = require('./security');
const { createServices } = require('./services');
const { BlobStore } = require('./storage');
const { Catalog } = require('./catalog');
const { createJobs } = require('./jobs');
const { EventHub } = require('./events');
const { createStudents } = require('./students');
const { createJoinCodes } = require('./join-codes');

const VERSION = require('../package.json').version;
// 자동 배포 때 넣는 빌드 정보 (어느 커밋인지) — 배포 후 새 코드가 켜졌는지 확인하는 데 씀
const BUILD = (() => {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'build.json'), 'utf8'));
    return { commit: String(b.commit || ''), builtAt: b.builtAt || null };
  } catch {
    return null;
  }
})();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// 웹 화면 폴더: 배포본은 server/web, 저장소에서 개발할 때는 launcher/src/renderer
const WEB_DIRS = [path.join(__dirname, '..', 'web'), path.join(__dirname, '..', '..', 'launcher', 'src', 'renderer')];
const ADMIN_PASSWORD_FILE = 'INITIAL_ADMIN_PASSWORD.txt';

function loadConfig(env = process.env, overrides = {}) {
  return {
    port: intOr(env.PORT, 8470, 0, 65535),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    libraryDir: path.resolve(env.LIBRARY_DIR || '/var/lib/mago-library'),
    adminUsername: env.ADMIN_USERNAME || 'admin',
    adminPassword: env.ADMIN_PASSWORD || '',
    githubToken: env.GITHUB_TOKEN || '',
    githubApi: (env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, ''),
    githubOidcJwksUrl: 'https://token.actions.githubusercontent.com/.well-known/jwks',
    launcherRepo: env.LAUNCHER_REPO === undefined ? 'hminkoo10/MagoEdu' : env.LAUNCHER_REPO,
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    catalogRefreshMinutes: intOr(env.CATALOG_REFRESH_MINUTES, 10, 1, 24 * 60),
    maxFileBytes: intOr(env.MAX_FILE_MB, 2048, 1) * 1024 * 1024,
    catalogFile: env.CATALOG_FILE || path.join(__dirname, '..', 'catalog.default.json'),
    studentPurgeDays: intOr(env.STUDENT_PURGE_DAYS, 30, 1, 3650), // 지운 학생을 완전히 지우기까지
    neisApiKey: env.NEIS_API_KEY || '', // 없어도 학교 검색 가능 (나이스가 최대 5건만 반환)
    aiRelayPerTenMinutes: intOr(env.AI_RELAY_PER_10_MIN, 600, 1, 100000), // 학원 AI 중계: 사람·프로그램마다 10분에
    inquiryWebhookAllowLocal: env.INQUIRY_WEBHOOK_ALLOW_LOCAL === '1',
    aiRelayAllowPrivate: env.AI_RELAY_ALLOW_PRIVATE === '1', // 시험용: 서버 안쪽 주소로도 중계
    // 없으면 내려받기 안내 페이지(public)만
    webDir: WEB_DIRS.find((d) => fs.existsSync(path.join(d, 'index.html'))) || null,
    background: true, // 주기 작업·프로그램 목록 자동 새로 고침
    quiet: false,
    ...overrides,
  };
}

function makeLog(quiet) {
  const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (quiet) return { info() {}, warn() {}, error() {} };
  return {
    info: (...a) => console.log(stamp(), ...a),
    warn: (...a) => console.warn(stamp(), ...a),
    error: (...a) => console.error(stamp(), ...a),
  };
}

function createCloudServer(config = loadConfig()) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const log = makeLog(config.quiet);
  const db = openDb(path.join(config.dataDir, 'magoedu.db'));
  const svc = createServices({ db, config, log });
  const keys = loadOrCreateSigningKey(path.join(config.dataDir, 'keys'));
  const blobs = new BlobStore(config.dataDir, db, log);
  const catalog = new Catalog({ db, config, log });
  catalog.seed(config.catalogFile);

  if (!svc.meta('server_id')) svc.setMeta('server_id', crypto.randomUUID());

  let seq = db.get('SELECT MAX((SELECT COALESCE(MAX(seq), 0) FROM files), (SELECT COALESCE(MAX(seq), 0) FROM shared_files)) AS n').n;
  const nextSeq = () => {
    seq += 1;
    return seq;
  };

  // 실시간 알림 (시험할 때는 간격을 줄일 수 있음)
  const events = new EventHub({
    svc,
    log,
    pingMs: config.eventPingMs,
    recheckMs: config.eventRecheckMs,
    perSession: config.eventStreamsPerSession,
    maxTotal: config.maxEventStreams,
  });

  const deps = {
    db,
    joinCodes: createJoinCodes(db),
    svc,
    events,
    keys,
    blobs,
    catalog,
    config,
    log,
    nextSeq,
    version: VERSION,
    build: BUILD,
    startedAt: Date.now(),
    trustKeys: () => [{ kid: keys.kid, alg: 'Ed25519', x: keys.x }],
    onPasswordChanged(user) {
      if (user.role === 'admin') fs.rmSync(path.join(config.dataDir, ADMIN_PASSWORD_FILE), { force: true });
    },
  };
  deps.inquiries = require('./inquiries').createInquiries(deps);
  deps.students = createStudents({
    inquiries: deps.inquiries,
    db,
    svc,
    blobs,
    events,
    catalog,
    nextSeq,
    log,
    aiKey: loadOrCreateSecret(path.join(config.dataDir, 'keys'), 'ai.key'),
    purgeDays: config.studentPurgeDays,
  });
  deps.jobs = createJobs({ db, svc, blobs, catalog, log, nextSeq, events, students: deps.students, inquiries: deps.inquiries });
  try {
    deps.students.importLegacy(); // 예전 오답노트 학생·학원 AI (다시 해도 안전)
  } catch (err) {
    log.warn('[학생 명단] 예전 오답노트 데이터를 가져오지 못했어요', err.message);
  }

  const initialAdmin = seedAdmin(db, config, log);

  const router = new Router();
  require('./routes/auth').register(router, deps);
  require('./routes/users').register(router, deps);
  require('./routes/admin').register(router, deps);
  require('./routes/inquiries').register(router, deps);
  require('./routes/apps').register(router, deps);
  require('./routes/ci').register(router, deps);
  require('./routes/sync').register(router, deps);
  require('./routes/shared').register(router, deps);
  require('./routes/library').register(router, deps);
  require('./routes/students').register(router, deps);
  require('./routes/schools').register(router, deps);
  deps.guardianKey = loadOrCreateSecret(path.join(config.dataDir, 'keys'), 'guardian.key');
  require('./routes/guardians').register(router, deps);
  require('./routes/student-accounts').register(router, deps);
  require('./routes/student-notes').register(router, deps);
  require('./routes/sso').register(router, deps);
  require('./routes/ai-relay').register(router, deps);

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendError(res, new HttpError(400, '잘못된 주소예요.'));
      return;
    }
    res.setHeader('x-content-type-options', 'nosniff');
    const ctx = {
      req,
      res,
      url,
      path: url.pathname,
      query: url.searchParams,
      ip: clientIp(req, config.trustProxy),
      params: {},
      auth: null,
    };
    try {
      svc.guardStudentSession(ctx);
      const m = router.match(req.method, url.pathname);
      if (!m) {
        if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
          const rel = decodeURIComponent(url.pathname.slice(1)) + (url.pathname.endsWith('/') ? 'index.html' : '');
          // 웹 화면 먼저, 그다음 public
          if (config.webDir && serveStatic(req, res, config.webDir, rel)) return;
          if (serveStatic(req, res, PUBLIC_DIR, rel)) return;
          if (!url.pathname.endsWith('/')) {
            for (const dir of [config.webDir, PUBLIC_DIR].filter(Boolean)) {
              const index = path.resolve(dir, rel, 'index.html');
              if (!index.startsWith(path.resolve(dir) + path.sep)) continue;
              let stat;
              try {
                stat = fs.statSync(index);
              } catch {
                continue;
              }
              if (!stat.isFile()) continue;
              res.writeHead(302, { location: `${url.pathname}/${url.search}` });
              res.end();
              return;
            }
          }
        }
        throw new HttpError(404, '찾을 수 없어요.', 'not_found');
      }
      if (m.methodNotAllowed) throw new HttpError(405, '지원하지 않는 요청이에요.', 'method_not_allowed');
      ctx.params = m.params;
      const result = await m.handler(ctx);
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
    } catch (err) {
      if (!(err instanceof HttpError)) log.error('[오류]', req.method, url.pathname, err);
      if (!res.headersSent) sendError(res, err);
      else res.destroy();
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  server.requestTimeout = 0; // 큰 파일을 천천히 올려도 끊지 않음
  server.headersTimeout = 60 * 1000;

  if (config.background) {
    catalog.start();
    deps.jobs.start();
  }

  return {
    server,
    deps,
    initialAdmin,
    routes: router.routes.map(({ method, pattern }) => ({ method, pattern })),
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    async close() {
      catalog.stop();
      deps.jobs.stop();
      events.close(); // 열린 실시간 연결 때문에 끄기가 늦어지지 않게
      blobs.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      db.close();
    },
  };
}

/** 운영자 계정이 하나도 없으면 하나 만든다 */
function seedAdmin(db, config, log) {
  if (db.get("SELECT 1 FROM users WHERE role = 'admin'")) return null;
  const username = normalizeUsername(config.adminUsername || 'admin');
  const generated = !config.adminPassword;
  const password = config.adminPassword || randomPassword();
  const now = Date.now();
  db.run(
    `INSERT INTO users(uid, username, name, role, password_hash, must_change_password, created_at, updated_at, password_changed_at)
     VALUES (?, ?, '운영자', 'admin', ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    username,
    hashPassword(password),
    generated ? 1 : 0,
    now,
    now,
    now,
  );
  if (generated) {
    const file = path.join(config.dataDir, ADMIN_PASSWORD_FILE);
    fs.writeFileSync(
      file,
      [
        '마고에듀 통합 클라우드 - 처음 운영자 계정',
        '',
        `아이디: ${username}`,
        `비밀번호: ${password}`,
        '',
        '처음 로그인하면 비밀번호를 새로 정하게 되고, 바꾸면 이 파일은 자동으로 지워져요.',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    log.info('');
    log.info('┌──────────────────────────────────────────────┐');
    log.info('│  운영자 계정을 만들었어요                    │');
    log.info(`│  아이디   : ${username.padEnd(33)}│`);
    log.info(`│  비밀번호 : ${password.padEnd(33)}│`);
    log.info('│  처음 로그인하면 비밀번호를 새로 정해요.     │');
    log.info('└──────────────────────────────────────────────┘');
    log.info(`(같은 내용을 ${file} 에도 적어 두었어요)`);
  }
  return { username, password, generated };
}

module.exports = { createCloudServer, loadConfig, VERSION, BUILD };
