'use strict';

// 통합 클라우드의 상태를 한곳에서 관리한다 (화면은 이 상태를 받아 그리기만 함)

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { ApiClient, ApiError, normalizeServerUrl } = require('../core/api');
const { Installer } = require('../core/installer');
const { SyncEngine } = require('../core/sync');
const { compileRules } = require('../core/rules');
const { detectLegacy, importLegacy } = require('../core/legacy');
const { writeTrust, TicketStore, verifyTicket } = require('../core/tickets');
const { Runner, buildEnv } = require('../core/runner');
const { EventStream } = require('../core/events');
const { readJsonSync, writeJson, formatBytes, dirSize } = require('../core/fsutil');

const SYNC_EVERY = 5 * 60 * 1000; // 실시간 알림이 끊겨 있어도 이 간격으로는 맞춤
const APPS_EVERY = 30 * 60 * 1000;
const NOTICES_EVERY = 10 * 60 * 1000;
const WATCH_EVERY = 15 * 1000;
const REMOTE_DELAY = 300; // 다른 기기에서 바뀌었다는 알림 → 잠깐 모았다가 받기
const LOCAL_DELAY = 1000; // 이 컴퓨터에서 파일이 바뀜 → 쓰기가 끝나길 잠깐 기다렸다가 올리기
const QUEUE_MAX_WAIT = 5000; // 계속 바뀌어도 이보다 오래 미루지는 않음
const REQUEST_DELAY = 100; // 프로그램이 학원 공간 파일을 달라고 함 → 바로 받기
const STOP_WAIT = 15 * 1000; // 로그아웃·계정 바꿈: 켜 둔 프로그램이 꺼지길 이만큼까지 기다림 (runner 는 10초 뒤 강제로 끔)
const REQUEST_RE = /^[A-Za-z0-9_-]{1,64}\.json$/; // requests/<rid>.json (답은 <rid>.done.json)
const ACADEMY_INFO_DELAY = 300; // 학원 명단·AI 가 바뀌었다는 알림 → 잠깐 모았다가 academy-info.json 다시 쓰기

// 동기화 폴더를 지켜볼 때 건너뛰는 것: 통합 클라우드·프로그램의 임시 파일
const IGNORE_LOCAL = [/(^|\/)\.sync-state\.json$/, /^conflicts(\/|$)/, /\.tmp$/i, /\.magoedu-dl(\.part)?$/i, /(^|\/)\.magoedu/];

/**
 * 프로그램이 적은 요청들: requests/<rid>.json
 *   '이 파일 받아 줘'(paths)·'받지 않은 채로 지워 줘'(remove), 또는 할 일(op: students.save 등, 내용은 body)
 */
async function readRequests(dir) {
  const names = await fsp.readdir(dir).catch(() => []);
  const out = [];
  for (const n of names) {
    if (!REQUEST_RE.test(n)) continue;
    try {
      const body = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'));
      const list = (v) => (Array.isArray(v) ? v : []).filter((p) => typeof p === 'string');
      out.push({ rid: n.slice(0, -5), op: typeof body?.op === 'string' ? body.op : null, body, paths: list(body?.paths), remove: list(body?.remove) });
    } catch {
      /* 쓰는 중 → 다음에 */
    }
  }
  return out;
}

/** 요청마다 <rid>.done.json { ok, missing[, error] } 을 쓰고 요청은 지운다 */
async function answerRequests(dir, reqs, missing, error = null) {
  const miss = new Set(missing || []);
  for (const r of reqs) {
    const all = [...r.paths, ...r.remove];
    const m = error ? all : all.filter((p) => miss.has(p));
    await writeJson(path.join(dir, `${r.rid}.done.json`), { ok: !error && !m.length, missing: m, ...(error ? { error } : {}) });
    await fsp.rm(path.join(dir, `${r.rid}.json`), { force: true });
  }
}

/** PC(Windows)에서 설치·실행하는 프로그램인지 (안드로이드 항목은 내려받기 안내만, 웹 프로그램은 브라우저로) */
const isDesktop = (a) => (a?.platform || 'windows') === 'windows';
const notDesktop = (a) =>
  a.platform === 'web' ? `${a.name}은(는) 웹 프로그램이라 설치 없이 브라우저에서 열어요.` : `${a.name}은(는) 휴대폰에서 내려받아 설치해요.`;

class Cloud extends EventEmitter {
  constructor({ paths, store, version, log, platform = process.platform, shortcuts = null, startedAtLogin = false }) {
    super();
    this.paths = paths;
    this.store = store;
    this.version = version;
    this.log = log;
    this.platform = platform;
    this.shortcuts = shortcuts; // 바탕 화면·시작 메뉴 바로 가기 (설치한 통합 클라우드에서만)
    // '윈도우 시작 시 실행' 프로그램은 윈도우가 켜지면서 통합 클라우드가 켜졌을 때만, 처음 로그인한 뒤 한 번 켠다
    // (켜져 있던 중에 통합 클라우드 창을 열거나 다시 로그인할 때는 켜지 않음)
    this.autoLaunchPending = startedAtLogin;
    this.phase = 'boot'; // boot | setup | login | ready
    this.user = null;
    this.dataKey = null; // 설정 파일 서명 키 (서버마다 하나, 로그인 정보와 함께 암호화해 둠)
    this.authMessage = null;
    this.online = true;
    this.apps = []; // 서버 목록
    this.installed = {}; // id → 설치 정보
    this.tasks = new Map(); // id → { kind, phase, progress, text }
    this.syncInfo = {}; // id → { status, at, ... }
    this.notices = [];
    this.storage = null;
    this.icons = {}; // id → data URL
    this.update = { status: 'idle' };
    this.locks = new Map();
    this.installTasks = new Map(); // 실행 중·잠금 대기 중인 설치 수 (화면용 tasks 와 별개)
    this.restarting = new Set(); // 종료 코드에 따라 다시 켜는 동안에도 자체 업데이트는 기다림
    this.timers = [];
    this.adopted = new Map(); // 통합 클라우드를 다시 켜기 전에 실행한 프로그램 id → 그때 기록 (버전·계정)
    this.settled = false; // 로그인한 뒤 세션 확인·목록 새로 고침이 끝났는지
    this.events = null; // 서버 실시간 알림
    this.watchers = new Map(); // id → [동기화 폴더·학원 공간·요청 폴더 지켜보기]
    this.syncQueue = new Map(); // id → 곧 할 동기화
    this.ops = new Map(); // id → 프로그램이 부탁한 일(학생 명단·로그인 코드)을 차례로
    this.academyStamp = 0; // 학원 명단·AI 가 바뀔 때마다 하나씩 (화면이 다시 불러옴)
    this._academyInfoTimer = null;
    this._syncing = {};
    this._syncAgain = {};
    this.installer = new Installer({ paths, log });
    this.runner = new Runner({ paths, log });
    this.runner.on('exit', (id, info) => this._onAppExit(id, info));
    this.runner.on('error', (id, err) => this._toast(`${this._name(id)}을(를) 켜지 못했어요: ${err.message}`, 'error'));
    this.api = this._makeApi(store.config.serverUrl, null);
    this._emitTimer = null;
  }

  _makeApi(serverUrl, token) {
    const api = new ApiClient({
      serverUrl,
      token,
      device: { id: this.store.config.deviceId, name: this.store.config.deviceName, platform: this.platform, version: this.version },
    });
    api.onAuthLost = (err) => this._authLost(err);
    return api;
  }

  // ---------------------------------------------------------------- 상태
  snapshot() {
    const cfg = this.store.config;
    const acc = this.user ? this.store.accountSettings(this.user.id) : null;
    return {
      version: this.version,
      developer: '구현민',
      phase: this.phase,
      online: this.online,
      authMessage: this.authMessage,
      config: {
        serverUrl: cfg.serverUrl,
        defaultServerUrl: this.store.defaults?.serverUrl || '',
        deviceName: cfg.deviceName,
        autoStart: cfg.autoStart,
        closeToTray: cfg.closeToTray,
        autoUpdateApps: cfg.autoUpdateApps,
        lastUsername: cfg.lastUsername,
      },
      user: this.user,
      storage: this.storage,
      notices: this.notices,
      unreadNotices: acc ? this.notices.filter((n) => n.id > (acc.noticesSeen || 0)).length : 0,
      update: this.update,
      shortcuts: !!this.shortcuts,
      academyStamp: this.academyStamp,
      apps: this.apps.map((a) => this._appView(a, acc)),
    };
  }

  _appView(a, acc) {
    const inst = this.installed[a.id] || null;
    const running = this.runner.isRunning(a.id);
    const runInfo = running ? this.runner.runningInfo(a.id) : null;
    const updateAvailable = !!(inst && a.release && this.installer.needsUpdate(inst, a));
    return {
      id: a.id,
      name: a.name,
      description: a.description,
      color: a.color,
      platform: a.platform || 'windows',
      url: a.url || null, // 웹 프로그램 주소
      icon: this.icons[a.id] || null,
      release: a.release,
      coldStorage: a.coldStorage,
      installed: inst ? { version: inst.version, installedAt: inst.installedAt } : null,
      running,
      runningVersion: runInfo?.version || null,
      restartForUpdate: !!(running && inst && runInfo?.version && runInfo.version !== inst.version),
      updateAvailable,
      task: this.tasks.get(a.id) || null,
      autoLaunch: acc ? acc.autoLaunch[a.id] ?? a.autoLaunchDefault : false,
      desktopShortcut: this._shortcutRec(a.id).desktop,
      sync: this.syncInfo[a.id] || null,
    };
  }

  emitState() {
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      this.emit('state', this.snapshot());
    }, 40);
  }

  _toast(text, kind = 'info') {
    this.emit('toast', { text, kind });
  }

  _name(id) {
    return this.apps.find((a) => a.id === id)?.name || id;
  }

  _setTask(id, task) {
    if (task) this.tasks.set(id, task);
    else this.tasks.delete(id);
    this.emitState();
  }

  async _lock(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    let release;
    const next = new Promise((r) => {
      release = r;
    });
    this.locks.set(id, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // ---------------------------------------------------------------- 시작
  async init() {
    await this.installer.recover();
    this.installed = await this.installer.listInstalled();
    for (const id of Object.keys(this.installed)) if (this.runner.isRunning(id)) this.adopted.set(id, this.runner.runningInfo(id) || {});
    const session = this.store.loadSession();
    const cfg = this.store.config;
    if (session && session.token && normalizeServerUrl(session.serverUrl) === normalizeServerUrl(cfg.serverUrl)) {
      this.api = this._makeApi(cfg.serverUrl, session.token);
      this.user = session.user;
      this.dataKey = session.dataKey || null;
      this.phase = 'ready';
      this._loadCachedCatalog();
      this.emitState();
      this._afterLogin({ fromSession: true }).catch((err) => this.log.warn('[시작]', err.message));
    } else {
      this.phase = cfg.serverUrl ? 'login' : 'setup';
      this.emitState();
    }
  }

  _catalogCache() {
    return this.user ? path.join(this.paths.account(this.user.id).root, 'catalog.json') : null;
  }

  _loadCachedCatalog() {
    const c = this._catalogCache() && readJsonSync(this._catalogCache(), null);
    if (c) {
      this.apps = c.apps || [];
      this.notices = c.notices || [];
      this.icons = c.icons || {};
    }
  }

  async _saveCachedCatalog() {
    const file = this._catalogCache();
    if (!file) return;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ apps: this.apps, notices: this.notices, icons: this.icons }));
  }

  // ---------------------------------------------------------------- 서버 주소
  async setServer(url) {
    const serverUrl = normalizeServerUrl(url);
    if (!serverUrl) throw new Error('서버 주소를 확인해 주세요. (예: http://192.168.0.10:8470)');
    const api = this._makeApi(serverUrl, null);
    const meta = await api.meta();
    if (!meta || meta.name !== '마고에듀 통합 클라우드') throw new Error('마고에듀 통합 클라우드 서버가 아니에요.');
    if (this.phase === 'ready') await this.logout();
    this.store.setConfig({ serverUrl });
    this.api = api;
    this.phase = 'login';
    this.authMessage = null;
    this.emitState();
    this.emit('server-changed', serverUrl);
    return { serverUrl, version: meta.version };
  }

  // ---------------------------------------------------------------- 로그인
  async login(username, password) {
    const api = this._makeApi(this.store.config.serverUrl, null);
    const r = await api.login(username, password);
    this.api = api;
    this.store.setConfig({ lastUsername: r.user.username });
    await this._loggedIn(r);
    return r.user;
  }

  checkCode(code) {
    return this._makeApi(this.store.config.serverUrl, null).checkCode(code);
  }

  async signup(fields) {
    const api = this._makeApi(this.store.config.serverUrl, null);
    const r = await api.signup(fields);
    this.api = api;
    this.store.setConfig({ lastUsername: r.user.username });
    await this._loggedIn(r);
    return r.user;
  }

  async _loggedIn(r) {
    // 다른 계정으로 켜 둔 프로그램은 끈다 (그 계정으로 계속 돌면서 이 계정의 것처럼 보이지 않게)
    await this._stopApps((info) => info.userId !== r.user.id);
    this.user = r.user;
    this.authMessage = null;
    this.phase = 'ready';
    this.online = true;
    this.dataKey = null;
    this._saveSession();
    await this._trust(r.server);
    this._loadCachedCatalog();
    this.emitState();
    await this._afterLogin({ fromSession: false });
  }

  async _trust(server) {
    if (!server?.keys?.length) return;
    await writeTrust(this.paths.trustFile, { serverUrl: this.store.config.serverUrl, serverId: server.id, keys: server.keys });
  }

  async _afterLogin({ fromSession }) {
    this.settled = false;
    this._startTimers();
    this._startRealtime();
    if (fromSession) await this.refreshMe().catch(() => {});
    await this._refreshDataKey();
    await Promise.all([this.refreshApps().catch(() => {}), this.refreshNotices().catch(() => {})]);
    if (this.phase !== 'ready') return;
    this.settled = true; // 바로 가기(magoedu://launch)로 부른 프로그램은 이때 켬
    this.emit('ready');
    // 데이터 동기화가 오래 걸려도 중단된 프로그램 업데이트는 바로 다시 받는다
    this._autoUpdate();
    await this.syncAll({ quiet: true }).catch(() => {});
    if (this.autoLaunchPending) {
      this.autoLaunchPending = false;
      this._autoLaunch();
    }
  }

  async logout() {
    // 이 계정으로 켠 프로그램은 끄고, 끄면서 저장한 데이터까지 올린 뒤 로그아웃한다
    // (다른 계정으로 로그인했는데 예전 계정으로 계속 돌고, 통합 클라우드에도 '이미 켜져 있음'으로 남지 않게)
    const uid = this.user?.id;
    if (uid) {
      const stopped = await this._stopApps((info) => !info.userId || info.userId === uid);
      await Promise.all(stopped.map((id) => this.syncApp(id, { quiet: true }).catch(() => {})));
    }
    this._stopTimers();
    this._stopRealtime();
    this.settled = false;
    try {
      await this.api.logout();
    } catch {
      /* 인터넷이 없어도 로그아웃 */
    }
    this.store.clearSession();
    this.user = null;
    this.dataKey = null;
    this.apps = [];
    this.notices = [];
    this.storage = null;
    this.syncInfo = {};
    this.phase = 'login';
    this.emitState();
  }

  /** 조건에 맞는 계정으로 켠 프로그램을 끄고, 꺼질 때까지 기다린다. 끈 프로그램 ID 목록 */
  async _stopApps(match) {
    const ids = Object.keys(this.installed).filter((id) => this.runner.isRunning(id) && match(this.runner.runningInfo(id) || {}));
    for (const id of ids) this.runner.stop(id);
    const end = Date.now() + STOP_WAIT;
    while (ids.some((id) => this.runner.isRunning(id)) && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
    for (const id of ids) if (!this.runner.isRunning(id)) this.adopted.delete(id);
    if (ids.length) this.emitState();
    return ids;
  }

  _authLost(err) {
    if (this.phase !== 'ready') return;
    // 사용 중지된 계정으로 켠 프로그램은 끈다 (로그인이 끊긴 것만이면 그대로 둠: 다시 로그인하면 이어서 씀)
    if (err.code === 'account_suspended') {
      const uid = this.user?.id;
      this._stopApps((info) => !info.userId || info.userId === uid).catch(() => {});
    }
    this._stopTimers();
    this._stopRealtime();
    this.settled = false;
    this.store.clearSession();
    this.user = null;
    this.dataKey = null;
    this.apps = [];
    this.notices = [];
    this.phase = 'login';
    this.authMessage = err.message;
    this.emitState();
  }

  _online(ok) {
    if (this.online !== ok) {
      this.online = ok;
      this.emitState();
    }
  }

  async _call(fn) {
    try {
      const r = await fn();
      this._online(true);
      return r;
    } catch (err) {
      if (err instanceof ApiError && err.offline) this._online(false);
      throw err;
    }
  }

  // ---------------------------------------------------------------- 내 계정
  async refreshMe() {
    const r = await this._call(() => this.api.get('/api/me'));
    this.user = r.user;
    this.storage = { usageBytes: r.user.usageBytes, quotaBytes: r.user.quotaBytes };
    this._saveSession();
    await this._trust(r.server);
    this.emitState();
    return r.user;
  }

  _saveSession() {
    this.store.saveSession({ serverUrl: this.store.config.serverUrl, token: this.api.token, user: this.user, dataKey: this.dataKey || undefined });
  }

  /** 설정 파일 서명 키를 받아 둔다. 예전 서버(404)면 없음. 인터넷이 없으면 받아 둔 것을 씀 */
  async _refreshDataKey() {
    try {
      const r = await this._call(() => this.api.get('/api/me/data-key'));
      if (this.user && r.dataKey !== this.dataKey) {
        this.dataKey = r.dataKey;
        this._saveSession();
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404 && this.user) {
        this.dataKey = null;
        this._saveSession();
      }
    }
    return this.dataKey;
  }

  async changePassword(currentPassword, newPassword, logoutOthers = true) {
    await this._call(() => this.api.patch('/api/me/password', { currentPassword, newPassword, logoutOthers }));
    return this.refreshMe();
  }

  async changeUsername(username, password) {
    await this._call(() => this.api.patch('/api/me/username', { username, password }));
    const u = await this.refreshMe();
    this.store.setConfig({ lastUsername: u.username });
    return u;
  }

  async changeName(name) {
    await this._call(() => this.api.patch('/api/me/name', { name }));
    return this.refreshMe();
  }

  /** 관리 화면에서 쓰는 서버 요청 (로그인 정보를 붙여서) */
  async apiCall(method, p, body) {
    if (!/^\/api\//.test(p)) throw new Error('잘못된 요청');
    const m = String(method).toUpperCase();
    const opts = body !== undefined && m !== 'GET' ? { json: body } : {};
    return this._call(() => this.api.request(m, p, opts));
  }

  // ---------------------------------------------------------------- 목록·공지
  async refreshApps() {
    const r = await this._call(() => this.api.get('/api/apps'));
    this.apps = r.apps;
    this.installed = await this.installer.listInstalled();
    this._watchAll();
    this._ensureShortcuts();
    await this._loadIcons();
    await this._saveCachedCatalog();
    this.emitState();
    return this.apps;
  }

  async _loadIcons() {
    const dir = path.join(this.paths.userData, 'icons');
    await fsp.mkdir(dir, { recursive: true });
    await Promise.all(
      this.apps.map(async (a) => {
        if (this.icons[a.id] && this._iconFresh?.[a.id]) return;
        try {
          const res = await fetch(`${this.api.serverUrl}${a.iconUrl}`, { signal: AbortSignal.timeout(10000) });
          if (!res.ok) return;
          const buf = Buffer.from(await res.arrayBuffer());
          const type = res.headers.get('content-type') || 'image/png';
          this.icons[a.id] = `data:${type};base64,${buf.toString('base64')}`;
          this._iconFresh = { ...(this._iconFresh || {}), [a.id]: true };
        } catch {
          /* 아이콘 없이 */
        }
      }),
    );
  }

  async refreshNotices() {
    const r = await this._call(() => this.api.get('/api/notices'));
    this.notices = r.notices;
    this.emitState();
    return this.notices;
  }

  markNoticesSeen() {
    if (!this.user) return;
    const max = Math.max(0, ...this.notices.map((n) => n.id));
    this.store.setAccountSettings(this.user.id, { noticesSeen: max });
    this.emitState();
  }

  async refreshStorage() {
    const r = await this._call(() => this.api.get('/api/sync'));
    this.storage = { usageBytes: r.usageBytes, quotaBytes: r.quotaBytes, apps: r.apps, academy: r.academy || null };
    this.emitState();
    return r;
  }

  // ---------------------------------------------------------------- 설치·삭제
  _app(id) {
    const a = this.apps.find((x) => x.id === id);
    if (!a) throw new Error('프로그램을 찾을 수 없어요.');
    return a;
  }

  install(id, { quiet = false } = {}) {
    this.installTasks.set(id, (this.installTasks.get(id) || 0) + 1);
    const job = this._lock(id, async () => {
      let app = this._app(id);
      if (!isDesktop(app)) throw new Error(notDesktop(app));
      const before = this.installed[id];
      const kind = before ? 'update' : 'install';
      this._setTask(id, { kind, phase: 'download', progress: 0, text: '받는 중' });
      try {
        const running = this.runner.runningInfo(id);
        const run = (a) => this.installer.install(this.api, a, {
          keep: running?.version ? [running.version] : [],
          onProgress: (p) =>
            this._setTask(id, {
              kind,
              phase: p.phase,
              progress: p.total ? p.done / p.total : 0,
              text:
                p.phase === 'download'
                  ? `받는 중 ${p.total ? Math.floor((p.done / p.total) * 100) : 0}% · ${formatBytes(p.done)}${p.total ? ` / ${formatBytes(p.total)}` : ''}`
                  : '설치하는 중',
            }),
        });
        let inst;
        try {
          inst = await run(app);
        } catch (err) {
          // 목록을 받아 둔 뒤 새 버전이 나오면 서버는 예전 버전을 주지 않는다 → 목록을 새로 받아 최신 버전으로 다시
          if (!(err instanceof ApiError && err.code === 'no_release')) throw err;
          await this.refreshApps();
          app = this._app(id);
          if (!app.release) throw err;
          if (before && !this.installer.needsUpdate(before, app)) {
            this._setTask(id, null);
            return before;
          }
          inst = await run(app);
        }
        this.installed[id] = inst;
        this._writeShortcuts(id); // 새 버전 폴더의 아이콘으로
        this._watchAll();
        this._setTask(id, null);
        if (!quiet || !before) this._toast(before ? `${app.name}을(를) ${inst.version} 버전으로 업데이트했어요` : `${app.name}을(를) 설치했어요`, 'success');
        if (running && before) this._toast(`${app.name}을(를) 다시 켜면 새 버전으로 바뀌어요`, 'info');
        return inst;
      } catch (err) {
        this._setTask(id, null);
        throw err;
      }
    });
    const settled = () => {
      const count = this.installTasks.get(id) || 0;
      if (count <= 1) this.installTasks.delete(id);
      else this.installTasks.set(id, count - 1);
      this.emit('app-task-settled');
    };
    job.then(settled, settled);
    return job;
  }

  uninstall(id, { removeData = false } = {}) {
    return this._lock(id, async () => {
      if (this.runner.isRunning(id)) throw new Error('프로그램이 켜져 있어요. 먼저 꺼 주세요.');
      this._setTask(id, { kind: 'uninstall', phase: 'remove', progress: 0, text: '삭제하는 중' });
      try {
        this._unwatch(id); // 지켜보는 동안에는 Windows 가 폴더를 지우지 못하게 함
        await this.installer.uninstall(id);
        delete this.installed[id];
        this._removeShortcuts(id);
        if (removeData && this.user) {
          await fsp.rm(this.paths.account(this.user.id).app(id).root, { recursive: true, force: true });
          delete this.syncInfo[id];
        }
      } finally {
        this._setTask(id, null);
        this._watchAll();
      }
      this._toast(`${this._name(id)}을(를) 삭제했어요`, 'success');
    });
  }

  async appDataInfo(id) {
    if (!this.user) return null;
    const dirs = this.paths.account(this.user.id).app(id);
    const [sync, local] = await Promise.all([dirSize(dirs.sync), dirSize(dirs.local)]);
    return { sync, local, dirs };
  }

  // ---------------------------------------------------------------- 동기화
  _engine(id) {
    const inst = this.installed[id];
    if (!inst || !this.user) return null;
    const dirs = this.paths.account(this.user.id).app(id);
    return new SyncEngine({ api: this.api, appId: id, dirs, rules: compileRules(inst.manifest.sync), log: this.log });
  }

  /** 학원 공간도 맞추는지: 매니페스트에 shared 가 있고 학원에 속한 계정 */
  _usesAcademy(id) {
    return !!(this.installed[id]?.manifest.shared && this.user?.academy);
  }

  _academyEngine(id) {
    if (!this._usesAcademy(id)) return null;
    const dirs = this.paths.account(this.user.id).app(id);
    return new SyncEngine({
      api: this.api,
      appId: id,
      base: `/api/sync/${encodeURIComponent(id)}/academy`,
      dirs: { sync: dirs.academy, conflicts: dirs.academyConflicts, state: dirs.academyState },
      rules: compileRules(this.installed[id].manifest.shared),
      log: this.log,
    });
  }

  /** 프로그램이 requests/ 로 부탁할 수 있는지: 학원 공간·학생 명단·웹 로그인 코드 중 하나라도 쓰면 */
  _usesRequests(id) {
    const m = this.installed[id]?.manifest;
    return !!m && (this._usesAcademy(id) || !!(m.academyInfo && this.user?.academy) || !!m.sso);
  }

  /**
   * 학원 공간을 맞춘다. 프로그램이 달라고 한(requests) 열 때만 받는 파일도 이때 받고 답을 쓴다.
   * 할 일(op)은 먼저 끝낸다 (막 추가한 학생의 파일이 '명단에 없는 학생'으로 밀리지 않게).
   */
  async _syncAcademy(id, onProgress) {
    if (this._usesRequests(id)) await this._runOps(id);
    const engine = this._academyEngine(id);
    if (!engine) return null;
    const dir = this.paths.account(this.user.id).app(id).requests;
    const reqs = (await readRequests(dir)).filter((r) => !r.op);
    try {
      const r = await engine.run({ onProgress, want: new Set(reqs.flatMap((q) => q.paths)), drop: new Set(reqs.flatMap((q) => q.remove)) });
      await answerRequests(dir, reqs, r.missing);
      return r;
    } catch (err) {
      await answerRequests(dir, reqs, null, err.message).catch(() => {});
      throw err;
    }
  }

  /**
   * 한 프로그램을 맞춘다. 이미 도는 중이면 그것을 기다린다.
   * fresh: 도는 중인 동기화가 이미 서버 목록·내 파일을 읽었을 수 있으니, 끝난 뒤 한 번 더 (여러 번 불러도 한 번만)
   */
  syncApp(id, { quiet = false, fresh = false } = {}) {
    const engine = this._engine(id);
    if (!engine) return Promise.resolve(null);
    const running = this._syncing[id];
    if (running) {
      if (!fresh) return running;
      if (!this._syncAgain[id]) {
        this._syncAgain[id] = running.then(() => {
          delete this._syncAgain[id];
          return this.syncApp(id, { quiet });
        });
      }
      return this._syncAgain[id];
    }
    const prev = this.syncInfo[id] || {};
    this.syncInfo[id] = { ...prev, status: 'syncing', progress: null };
    this.emitState();
    const job = (async () => {
      try {
        const onProgress = (p) => {
          if (p.phase === 'transfer') {
            this.syncInfo[id] = { ...this.syncInfo[id], progress: p.total ? p.done / p.total : null, text: `${p.done}/${p.total}` };
            this.emitState();
          }
        };
        const r = await engine.run({ onProgress });
        const a = await this._syncAcademy(id, onProgress);
        this._online(true);
        const moved = (x) => x.uploaded + x.downloaded + x.deletedLocal + x.deletedRemote;
        const conflicts = [...r.conflicts, ...(a ? a.conflicts : [])];
        const errors = [...r.errors, ...(a ? a.errors : [])];
        this.syncInfo[id] = {
          status: errors.length ? 'partial' : 'ok',
          at: r.at,
          localOnly: r.localOnly,
          conflicts: conflicts.length ? conflicts : prev.conflicts || [],
          quotaExceeded: r.quotaExceeded || !!a?.quotaExceeded,
          errors: errors.slice(0, 5),
          moved: moved(r) + (a ? moved(a) : 0),
          seq: r.seq,
          academySeq: a ? a.seq : null, // 학원 공간은 따로 (실시간 알림 scope: 'academy')
        };
        if (r.usageBytes !== null) this.storage = { ...(this.storage || {}), usageBytes: r.usageBytes, quotaBytes: r.quotaBytes };
        if (r.conflicts.length && !quiet) {
          this._toast(`${this._name(id)}: 다른 컴퓨터와 동시에 고친 파일 ${r.conflicts.length}개는 따로 보관했어요`, 'warning');
        }
        if (r.quotaExceeded) this._toast('서버 저장 공간이 꽉 차서 일부 파일을 올리지 못했어요', 'warning');
        if (a?.quotaExceeded) this._toast('학원 공간이 꽉 차서 일부 파일을 올리지 못했어요. 운영자에게 학원 용량을 늘려 달라고 해 주세요', 'warning');
        if (a?.reverted.length) {
          this._toast(`${this._name(id)}: 고칠 권한이 없는 학원 공용 파일 ${a.reverted.length}개는 원래대로 되돌렸어요 (내 것은 따로 보관)`, 'warning');
        }
        if (a?.conflicts.length) {
          this._toast(`${this._name(id)}: 다른 사람과 동시에 고친 학원 공용 파일 ${a.conflicts.length}개는 서버 것으로 맞추고 내 것은 따로 보관했어요`, 'warning');
        }
        return r;
      } catch (err) {
        const offline = err instanceof ApiError && err.offline;
        if (offline) this._online(false);
        this.syncInfo[id] = { ...prev, status: offline ? 'offline' : 'error', error: err.message, at: prev.at || null };
        if (!quiet && !offline) this._toast(`${this._name(id)} 동기화 실패: ${err.message}`, 'error');
        return null;
      } finally {
        delete this._syncing[id];
        this.emitState();
      }
    })();
    this._syncing[id] = job;
    return job;
  }

  /** 동기화하는 프로그램: 설치했고 지금 목록에 있는 PC 프로그램 */
  _syncIds() {
    return Object.keys(this.installed).filter((id) => this.apps.some((a) => a.id === id && isDesktop(a)));
  }

  async syncAll({ quiet = false } = {}) {
    for (const id of this._syncIds()) await this.syncApp(id, { quiet });
  }

  // ---------------------------------------------------------------- 실시간 동기화
  // 서버 알림(다른 기기에서 바뀜)과 동기화 폴더 지켜보기(이 컴퓨터에서 바뀜)로 바로 맞추고, 5분마다 맞추기는 그대로 둔다.
  _startRealtime() {
    this._stopRealtime();
    const stream = new EventStream({ api: this.api, log: this.log });
    stream.on('hello', () => {
      this._online(true);
      for (const id of this._syncIds()) this._queueSync(id, REMOTE_DELAY); // 끊긴 동안 바뀐 것
      this._queueAcademyInfo();
    });
    stream.on('change', (e) => this._onRemoteChange(e));
    stream.on('academy', () => {
      this.academyStamp += 1;
      this.emitState();
      this._queueAcademyInfo();
    });
    this.events = stream;
    stream.start();
    this._watchAll();
  }

  _stopRealtime() {
    this.events?.stop();
    this.events = null;
    clearTimeout(this._academyInfoTimer);
    this._academyInfoTimer = null;
    for (const id of [...this.watchers.keys()]) this._unwatch(id);
    for (const q of this.syncQueue.values()) clearTimeout(q.timer);
    this.syncQueue.clear();
  }

  _onRemoteChange(e) {
    const id = e?.appId;
    if (!id || !this._syncIds().includes(id)) return;
    if (e.deviceId && e.deviceId === this.store.config.deviceId) return; // 이 컴퓨터가 올린 것
    const have = e.scope === 'academy' ? this.syncInfo[id]?.academySeq : this.syncInfo[id]?.seq;
    if (typeof e.seq === 'number' && e.seq <= (have || 0)) return; // 이미 받은 것
    this._queueSync(id, REMOTE_DELAY);
  }

  /** 잠깐 모았다가 한 번 맞춘다 (도는 중인 동기화가 있으면 끝난 뒤 한 번 더) */
  _queueSync(id, delay) {
    const now = Date.now();
    let q = this.syncQueue.get(id);
    if (!q) {
      q = { first: now, timer: null };
      this.syncQueue.set(id, q);
    }
    clearTimeout(q.timer);
    q.timer = setTimeout(() => {
      this.syncQueue.delete(id);
      if (this.phase === 'ready') this.syncApp(id, { quiet: true, fresh: true });
    }, Math.max(0, Math.min(delay, q.first + QUEUE_MAX_WAIT - now)));
    q.timer.unref?.();
  }

  /** 설치한 프로그램의 동기화 폴더를 지켜본다 (프로그램이 파일을 쓰면 1초쯤 뒤에 올림) */
  _watchAll() {
    if (!this.events || this.phase !== 'ready' || !this.user) return;
    const want = new Set(this._syncIds());
    for (const id of [...this.watchers.keys()]) if (!want.has(id)) this._unwatch(id);
    for (const id of want) if (!this.watchers.has(id)) this._watch(id);
  }

  _watch(id) {
    const dirs = this.paths.account(this.user.id).app(id);
    const list = [];
    const watch = (dir, recursive, onName) => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const w = fs.watch(dir, { recursive }, (_type, name) => onName(name ? String(name).replace(/\\/g, '/') : ''));
        w.on('error', () => this._unwatch(id)); // 폴더가 지워짐 등 → 다음 목록 새로 고침 때 다시
        w.unref?.();
        list.push(w);
      } catch (err) {
        this.log.warn?.(`[동기화] ${id} 폴더를 지켜보지 못했어요 (5분마다 맞춤)`, err.message);
      }
    };
    const changed = (rel) => {
      if (rel && IGNORE_LOCAL.some((re) => re.test(rel))) return;
      this._queueSync(id, LOCAL_DELAY);
    };
    watch(dirs.sync, true, changed);
    if (this._usesAcademy(id)) watch(dirs.academy, true, changed);
    if (this._usesRequests(id)) {
      watch(dirs.requests, false, (n) => {
        // 새 요청만 (답 <rid>.done.json 을 쓰거나 요청을 지운 것은 건너뜀)
        if (!REQUEST_RE.test(n) || !fs.existsSync(path.join(dirs.requests, n))) return;
        this._runOps(id).then(() => {
          if (this._usesAcademy(id)) this._queueSync(id, REQUEST_DELAY); // 파일 받기·지우기 요청
        });
      });
    }
    if (list.length) this.watchers.set(id, list);
  }

  _unwatch(id) {
    const list = this.watchers.get(id);
    if (!list) return;
    this.watchers.delete(id);
    for (const w of list) {
      try {
        w.close();
      } catch {
        /* 이미 닫힘 */
      }
    }
  }

  // ---------------------------------------------------------------- 예전 데이터
  async legacyDetect(id) {
    const inst = this.installed[id];
    if (!inst || !this.user) return [];
    const dirs = this.paths.account(this.user.id).app(id);
    const found = await detectLegacy(inst.manifest, { appDirs: dirs, pcMarkerFile: this.paths.legacyFile });
    const dismissed = this.store.accountSettings(this.user.id).legacyDismissed[id] || [];
    return found.map((f) => ({ ...f, dismissed: dismissed.includes(f.id) }));
  }

  async legacyImport(id, legacyId) {
    const inst = this.installed[id];
    if (!inst || !this.user) throw new Error('프로그램을 먼저 설치해 주세요.');
    if (this.runner.isRunning(id)) throw new Error('프로그램을 끈 뒤에 가져와 주세요.');
    const dirs = this.paths.account(this.user.id).app(id);
    this._setTask(id, { kind: 'legacy', phase: 'copy', progress: 0, text: '예전 데이터를 가져오는 중' });
    try {
      const r = await importLegacy(inst.manifest, legacyId, {
        appDirs: dirs,
        pcMarkerFile: this.paths.legacyFile,
        accountLabel: `${this.user.name} (${this.user.username})`,
        onProgress: (d, t) => this._setTask(id, { kind: 'legacy', phase: 'copy', progress: t ? d / t : 0, text: `예전 데이터를 가져오는 중 ${d}/${t}` }),
      });
      this._setTask(id, null);
      this.syncApp(id, { quiet: true });
      return r;
    } catch (err) {
      this._setTask(id, null);
      throw err;
    }
  }

  legacyDismiss(id, legacyId) {
    if (!this.user) return;
    const s = this.store.accountSettings(this.user.id);
    const list = new Set(s.legacyDismissed[id] || []);
    list.add(legacyId);
    this.store.setAccountSettings(this.user.id, { legacyDismissed: { ...s.legacyDismissed, [id]: [...list] } });
  }

  // ---------------------------------------------------------------- 프로그램이 부탁한 일·학원 명단
  /** requests/ 의 할 일(op)을 차례로 처리한다 (지켜보기와 동기화가 같이 불러도 한 번씩) */
  _runOps(id) {
    const job = (this.ops.get(id) || Promise.resolve()).then(() => this._doOps(id)).catch((err) => this.log.warn?.(`[요청] ${id}`, err.message));
    this.ops.set(id, job);
    job.then(() => {
      if (this.ops.get(id) === job) this.ops.delete(id);
    });
    return job;
  }

  async _doOps(id) {
    if (!this.user || !this._usesRequests(id)) return;
    const dir = this.paths.account(this.user.id).app(id).requests;
    const reqs = (await readRequests(dir)).filter((r) => r.op);
    let students = false;
    for (const r of reqs) {
      let answer;
      try {
        answer = { ok: true, missing: [], ...(await this._op(id, r.op, r.body)) };
        if (r.op.startsWith('students.')) students = true;
      } catch (err) {
        const code = err instanceof ApiError && err.offline ? 'offline' : err.code || null;
        answer = { ok: false, missing: [], error: err.message, errorCode: code, ...(err.extra?.student ? { student: err.extra.student } : {}) };
      }
      await writeJson(path.join(dir, `${r.rid}.done.json`), answer);
      await fsp.rm(path.join(dir, `${r.rid}.json`), { force: true });
    }
    if (students) {
      // 서버 알림을 기다리지 않고 바로 새 명단으로 (프로그램이 방금 고친 학생을 곧바로 보게)
      await this._writeAcademyInfoAll([id]);
      if (this._usesAcademy(id)) this._queueSync(id, REQUEST_DELAY); // 명단에 없어 미뤄 둔 학생 파일
    }
  }

  /** 할 일 하나 → 답에 더할 내용 ({ student } | { ssoCode, expiresAt }). 실패는 던진다 */
  async _op(id, op, body) {
    const manifest = this.installed[id].manifest;
    if (op === 'sso.code') {
      if (!manifest.sso) throw new Error('이 프로그램은 웹 로그인을 쓰지 않아요.');
      return this._ssoCode(manifest.sso);
    }
    if (!['students.save', 'students.delete', 'students.restore'].includes(op)) throw new Error(`모르는 요청이에요: ${op}`);
    if (!manifest.academyInfo) throw new Error('이 프로그램은 학생 명단을 쓰지 않아요.');
    if (!this.user.academy) throw new Error('학원에 속한 계정만 학생 명단을 쓸 수 있어요.');
    const s = body?.student || {};
    const sid = encodeURIComponent(String(body?.id || s.id || ''));
    if (op === 'students.delete') return this._call(() => this.api.del(`/api/students/${sid}`));
    if (op === 'students.restore') return this._call(() => this.api.post(`/api/students/${sid}/restore`, {}));
    const fields = {};
    for (const k of ['name', 'school', 'grade', 'memo', 'teacherId']) if (s[k] !== undefined) fields[k] = s[k];
    if (fields.teacherId === undefined && s.teacher !== undefined) fields.teacherId = s.teacher ? s.teacher.id : null;
    // rev 가 있으면 고치기(그사이 다른 사람이 고쳤으면 409 conflict + 지금 것), 없으면 추가(그 ID 로)
    const r = Number.isInteger(s.rev)
      ? await this._call(() => this.api.patch(`/api/students/${sid}`, { ...fields, baseRev: s.rev }))
      : await this._call(() => this.api.post('/api/students', { ...fields, ...(s.id ? { id: s.id } : {}) }));
    return { student: r.student };
  }

  /** 웹 프로그램(카탈로그 ID)에 이 계정으로 로그인할 일회용 코드 (60초) */
  async _ssoCode(appId) {
    const r = await this._call(() => this.api.post('/api/sso/authorize', { appId }));
    return { ssoCode: r.code, expiresAt: r.expiresAt };
  }

  /** 학원 학생 명단·학원 AI 를 academy-info.json 으로 (매니페스트 academyInfo, 학원에 속한 계정). 실패하면 지난번 파일 그대로 */
  async _writeAcademyInfo(id) {
    const user = this.user;
    if (!user?.academy || !this.installed[id]?.manifest.academyInfo) return;
    const [list, members, ai] = await Promise.all([
      this._call(() => this.api.get('/api/students')),
      this._call(() => this.api.get('/api/academy/members')),
      // 그 프로그램 것 → 학원 기본 (없거나 볼 수 없으면 null)
      this._call(() => this.api.get(`/api/academy/ai?app=${encodeURIComponent(id)}`)).catch((err) => {
        if (err instanceof ApiError && err.offline) throw err;
        return { ai: null };
      }),
    ]);
    if (this.user?.id !== user.id) return; // 그사이 로그아웃
    await writeJson(this.paths.account(user.id).app(id).academyInfo, {
      format: 1,
      academy: user.academy,
      me: { id: user.id, name: user.name, role: user.role },
      members: members.members,
      students: list.students, // 지운 학생 포함 (deletedAt)
      purged: list.purged, // 완전히 지운 학생 ID
      purgeDays: list.purgeDays,
      ai: ai.ai,
      updatedAt: Date.now(),
    });
  }

  /** 켜져 있는 학생 명단 프로그램들의 academy-info.json 을 새로 쓴다 (also: 켜져 있지 않아도 쓸 프로그램) */
  async _writeAcademyInfoAll(also = []) {
    const ids = Object.keys(this.installed).filter((id) => this.installed[id].manifest.academyInfo && (also.includes(id) || this.runner.isRunning(id)));
    for (const id of ids) {
      await this._writeAcademyInfo(id).catch((err) => this.log.warn?.(`[학원 명단] ${id}`, err.message));
    }
  }

  _queueAcademyInfo() {
    clearTimeout(this._academyInfoTimer);
    this._academyInfoTimer = setTimeout(() => {
      this._academyInfoTimer = null;
      if (this.phase === 'ready') this._writeAcademyInfoAll();
    }, ACADEMY_INFO_DELAY);
    this._academyInfoTimer.unref?.();
  }

  // ---------------------------------------------------------------- 실행
  async _ticket(id, uid) {
    const store = new TicketStore(this.paths.account(uid).tickets);
    try {
      const r = await this._call(() => this.api.post(`/api/apps/${encodeURIComponent(id)}/ticket`, {}));
      await store.put(id, r.ticket, r.expiresAt);
      return r.ticket;
    } catch (err) {
      if (!(err instanceof ApiError && err.offline)) throw err;
      const trust = readJsonSync(this.paths.trustFile, null);
      const cached = await store.get(id, trust?.keys || []);
      if (cached) return cached.ticket;
      throw new Error('서버에 연결할 수 없고, 인터넷 없이 쓸 수 있는 기간도 지났어요. 인터넷에 연결한 뒤 다시 해 주세요.');
    }
  }

  /**
   * 켜기. 예전 데이터가 있으면 먼저 물어봐야 하므로 { needsLegacy } 를 돌려줄 수 있다.
   */
  async launch(id, { skipLegacyCheck = false } = {}) {
    if (!this.user) throw new Error('로그인이 필요해요.');
    const uid = this.user.id;
    // 기다리는 사이 로그인이 끊기거나(예: 계정 사용 중지) 다른 계정으로 바뀌었으면 켜지 않는다
    const sameUser = () => {
      if (this.user?.id !== uid) throw new Error(this.authMessage || '로그인한 계정이 바뀌어서 켜지 않았어요.');
    };
    const known = this.apps.find((a) => a.id === id);
    if (known && !isDesktop(known)) throw new Error(known.platform === 'web' ? notDesktop(known) : `${known.name}은(는) 휴대폰에서 쓰는 프로그램이에요.`);
    if (this.runner.isRunning(id)) {
      const info = this.runner.runningInfo(id);
      if (info?.userId && info.userId !== uid) {
        await this._stopApps((x) => x.pid === info.pid); // 다른 계정으로 켜 둔 것 → 끄고 이 계정으로 켬
        sameUser();
      }
    }
    if (this.runner.isRunning(id)) {
      this._toast(`${this._name(id)}은(는) 이미 켜져 있어요`, 'info');
      return { already: true };
    }
    if (!this.installed[id]) await this.install(id);
    else if (this.installer.needsUpdate(this.installed[id], this._app(id))) {
      await this.install(id, { quiet: true }).catch((err) => this._toast(`업데이트하지 못해 지금 버전으로 켤게요: ${err.message}`, 'warning'));
    }
    sameUser();
    if (!skipLegacyCheck) {
      const legacy = (await this.legacyDetect(id)).filter((l) => !l.importedHere && !l.dismissed);
      if (legacy.length) return { needsLegacy: legacy };
    }
    return this._lock(id, async () => {
      // 바로 가기와 자동 실행이 거의 같이 부르면 먼저 켠 쪽만
      if (this.runner.isRunning(id)) return { already: true };
      this._setTask(id, { kind: 'launch', phase: 'sync', progress: null, text: '데이터를 맞추는 중' });
      try {
        sameUser();
        await this.syncApp(id, { quiet: true });
        sameUser(); // 동기화는 로그인이 끊겨도(401) 오류를 내지 않는다
        this._setTask(id, { kind: 'launch', phase: 'ticket', progress: null, text: '켜는 중' });
        const ticket = await this._ticket(id, uid);
        sameUser();
        const dirs = this.paths.account(uid).app(id);
        await fsp.mkdir(dirs.sync, { recursive: true });
        await fsp.mkdir(dirs.local, { recursive: true });
        const academy = this._usesAcademy(id);
        const requests = this._usesRequests(id);
        const manifest = this.installed[id].manifest;
        if (academy) await fsp.mkdir(dirs.academy, { recursive: true });
        if (requests) {
          await fsp.mkdir(dirs.requests, { recursive: true });
          // 지난번에 남은 요청·답 (폴더는 지켜보는 중이라 안의 파일만 지움)
          for (const n of await fsp.readdir(dirs.requests)) await fsp.rm(path.join(dirs.requests, n), { recursive: true, force: true });
        }
        const signing = !!manifest?.dataSigning;
        if (signing && !this.dataKey) await this._refreshDataKey();
        const academyInfo = !!(manifest.academyInfo && this.user.academy);
        if (academyInfo) {
          await this._writeAcademyInfo(id).catch((err) => this.log.warn?.(`[학원 명단] ${id}: 지난번 명단으로 켜요`, err.message));
        }
        // 일회용 로그인 코드는 60초짜리라 켜기 바로 전에 (인터넷이 없으면 빈 값 → 프로그램이 안내)
        const ssoCode = manifest.sso ? await this._ssoCode(manifest.sso).then((r) => r.ssoCode).catch(() => '') : '';
        sameUser();
        const env = buildEnv({
          ticket,
          appId: id,
          user: this.user,
          appDirs: dirs,
          academy,
          requests,
          academyInfo,
          ssoCode,
          dataKey: signing ? this.dataKey : '',
          serverUrl: this.store.config.serverUrl,
          launcherVersion: this.version,
          trustFile: this.paths.trustFile,
        });
        this.runner.launch({ appId: id, installed: this.installed[id], env });
        return { started: true };
      } finally {
        this._setTask(id, null);
      }
    });
  }

  stop(id) {
    return this.runner.stop(id);
  }

  /**
   * 웹의 ‘PC에 설치’(magoedu://install/<id>): 없으면 설치, 새 버전이 있으면 업데이트, 이미 최신이면 알려만 준다. 켜지는 않는다.
   */
  async installFromLink(id) {
    if (!this.user) throw new Error('로그인이 필요해요.');
    const app = this._app(id);
    if (!isDesktop(app)) throw new Error(notDesktop(app));
    const task = this.tasks.get(id);
    if (task && (task.kind === 'install' || task.kind === 'update')) return { busy: true }; // 이미 받는 중
    const inst = this.installed[id];
    if (inst && !this.installer.needsUpdate(inst, app)) {
      this._toast(`${app.name}은(는) 이미 최신 버전(${inst.version})으로 설치돼 있어요`, 'info');
      return { already: true, version: inst.version };
    }
    if (!app.release) throw new Error(`${app.name}은(는) 아직 배포된 버전이 없어요.`);
    const r = await this.install(id);
    return { installed: true, version: r.version };
  }

  /** 바로 누르면 곧바로 켜지는지 (설치돼 있고 받을 업데이트가 없음) */
  canLaunchNow(id) {
    const inst = this.installed[id];
    const app = this.apps.find((a) => a.id === id);
    return !!(inst && app && isDesktop(app) && !this.installer.needsUpdate(inst, app));
  }

  _onAppExit(id, info) {
    this.emitState();
    if (info.restart && this.user && info.userId === this.user.id) {
      this.restarting.add(id);
      setTimeout(() => this.launch(id, { skipLegacyCheck: true })
        .catch((err) => this._toast(err.message, 'error'))
        .finally(() => this.restarting.delete(id)), 600);
      return;
    }
    if (this.user && info.userId === this.user.id) this.syncApp(id, { quiet: true });
    if (info.code && info.code !== 0) this.log.warn(`[실행] ${id} 종료 코드 ${info.code}`);
    this.installer.cleanup(id).catch(() => {});
  }

  setAutoLaunch(id, on) {
    if (!this.user) return;
    const s = this.store.accountSettings(this.user.id);
    this.store.setAccountSettings(this.user.id, { autoLaunch: { ...s.autoLaunch, [id]: !!on } });
    // 윈도우가 켜질 때 통합 클라우드가 먼저 켜져야 프로그램을 켤 수 있다
    if (on && !this.store.config.autoStart) this.setConfig({ autoStart: true });
    else this.emitState();
  }

  _autoLaunch() {
    if (!this.user) return;
    const s = this.store.accountSettings(this.user.id);
    for (const a of this.apps) {
      if (!isDesktop(a)) continue;
      const on = s.autoLaunch[a.id] ?? a.autoLaunchDefault;
      if (on && this.installed[a.id] && !this.runner.isRunning(a.id)) {
        this.launch(a.id, { skipLegacyCheck: true }).catch((err) => this._toast(`${a.name} 자동 실행 실패: ${err.message}`, 'warning'));
      }
    }
  }

  _autoUpdate() {
    if (!this.store.config.autoUpdateApps) return;
    for (const a of this.apps) {
      const inst = this.installed[a.id];
      if (inst && this.installer.needsUpdate(inst, a) && !this.installTasks.has(a.id) && this.tasks.get(a.id)?.kind !== 'uninstall') {
        this.install(a.id, { quiet: true }).catch((err) => this.log.warn('[자동 업데이트]', a.id, err.message));
      }
    }
  }

  anyRunning() {
    return this.restarting.size > 0 || Object.keys(this.installed).some((id) => this.runner.isRunning(id));
  }

  anyAppInstallTask() {
    return this.installTasks.size > 0;
  }

  // ---------------------------------------------------------------- 주기 작업
  _startTimers() {
    this._stopTimers();
    const every = (ms, fn) => {
      const t = setInterval(() => {
        if (this.phase === 'ready') fn();
      }, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(SYNC_EVERY, () => this.syncAll({ quiet: true }));
    every(APPS_EVERY, () => this.refreshApps().then(() => this._autoUpdate()).catch(() => {}));
    every(NOTICES_EVERY, () => this.refreshNotices().catch(() => {}));
    every(WATCH_EVERY, () => this._watchAdopted());
  }

  _stopTimers() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  _watchAdopted() {
    for (const [id, info] of [...this.adopted]) {
      if (!this.runner.isRunning(id)) {
        this.adopted.delete(id);
        try {
          fs.rmSync(this.paths.app(id).running, { force: true });
        } catch {
          /* 무시 */
        }
        // 직접 켠 프로그램이 아니라 종료 코드(새 버전으로 다시 켜 달라는 75)를 알 수 없다.
        // 켜져 있는 동안 새 버전이 설치됐으면 새 버전으로 다시 켜려고 끝난 것으로 본다
        const inst = this.installed[id];
        const restart = !!(info.version && inst && inst.version !== info.version);
        this._onAppExit(id, { code: 0, restart, userId: info.userId || this.user?.id });
      }
    }
  }

  // ---------------------------------------------------------------- 바로 가기 (바탕 화면·시작 메뉴)
  // 이 컴퓨터 설정(config.shortcuts)에 { desktop, name(지난번 파일 이름) } 을 둔다. 바탕 화면은 기본으로 켬.
  _shortcutRec(id) {
    return { desktop: true, ...(this.store.config.shortcuts?.[id] || {}) };
  }

  _saveShortcutRec(id, rec) {
    const all = { ...(this.store.config.shortcuts || {}) };
    if (rec) all[id] = rec;
    else delete all[id];
    this.store.setConfig({ shortcuts: all });
  }

  _writeShortcuts(id) {
    if (!this.shortcuts) return;
    const inst = this.installed[id];
    const app = this.apps.find((a) => a.id === id);
    if (!inst || !isDesktop(app)) return;
    const rec = this._shortcutRec(id);
    try {
      const name = this.shortcuts.write({
        id,
        name: app?.name || inst.name || id,
        description: app?.description || '',
        icon: path.join(inst.dir, ...inst.manifest.exe.split('/')),
        desktop: rec.desktop,
        previous: rec.name,
      });
      this._saveShortcutRec(id, { ...rec, name });
    } catch (err) {
      this.log.warn?.(`[바로 가기] ${id}`, err.message);
    }
  }

  /** 이 기능 전에 설치한 프로그램이나 이름이 바뀐 프로그램의 바로 가기 (지운 바로 가기를 다시 만들지는 않음) */
  _ensureShortcuts() {
    if (!this.shortcuts) return;
    for (const id of this._syncIds()) {
      const rec = this.store.config.shortcuts?.[id];
      const app = this.apps.find((a) => a.id === id);
      if (!rec || rec.name !== this.shortcuts.fileName(app.name)) this._writeShortcuts(id);
    }
  }

  _removeShortcuts(id) {
    const rec = this.store.config.shortcuts?.[id];
    if (!rec) return;
    try {
      this.shortcuts?.remove(rec.name);
    } catch (err) {
      this.log.warn?.(`[바로 가기] ${id}`, err.message);
    }
    this._saveShortcutRec(id, null);
  }

  setDesktopShortcut(id, on) {
    if (!this.shortcuts) throw new Error('설치한 통합 클라우드에서만 바로 가기를 만들 수 있어요.');
    if (!this.installed[id]) throw new Error('프로그램을 먼저 설치해 주세요.');
    this._saveShortcutRec(id, { ...this._shortcutRec(id), desktop: !!on });
    this._writeShortcuts(id);
    this.emitState();
    return !!on;
  }

  setConfig(patch) {
    const allowed = ['deviceName', 'autoStart', 'closeToTray', 'autoUpdateApps'];
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
    this.store.setConfig(clean);
    this.emitState();
    this.emit('config', this.store.config);
    return this.store.config;
  }

  shutdown() {
    this._stopTimers();
    this._stopRealtime();
  }
}

module.exports = { Cloud, verifyTicket };
