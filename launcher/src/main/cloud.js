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
const { readJsonSync, formatBytes, dirSize } = require('../core/fsutil');

const SYNC_EVERY = 5 * 60 * 1000;
const APPS_EVERY = 30 * 60 * 1000;
const NOTICES_EVERY = 10 * 60 * 1000;
const WATCH_EVERY = 15 * 1000;

class Cloud extends EventEmitter {
  constructor({ paths, store, version, log, platform = process.platform }) {
    super();
    this.paths = paths;
    this.store = store;
    this.version = version;
    this.log = log;
    this.platform = platform;
    this.phase = 'boot'; // boot | setup | login | ready
    this.user = null;
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
    this.timers = [];
    this.adopted = new Set(); // 통합 클라우드를 다시 켜기 전에 실행한 프로그램
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
    this.installed = await this.installer.listInstalled();
    for (const id of Object.keys(this.installed)) if (this.runner.isRunning(id)) this.adopted.add(id);
    const session = this.store.loadSession();
    const cfg = this.store.config;
    if (session && session.token && normalizeServerUrl(session.serverUrl) === normalizeServerUrl(cfg.serverUrl)) {
      this.api = this._makeApi(cfg.serverUrl, session.token);
      this.user = session.user;
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
    this.user = r.user;
    this.authMessage = null;
    this.phase = 'ready';
    this.online = true;
    this.store.saveSession({ serverUrl: this.store.config.serverUrl, token: this.api.token, user: r.user });
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
    this._startTimers();
    if (fromSession) await this.refreshMe().catch(() => {});
    await Promise.all([this.refreshApps().catch(() => {}), this.refreshNotices().catch(() => {})]);
    if (this.phase !== 'ready') return;
    await this.syncAll({ quiet: true }).catch(() => {});
    this._autoUpdate();
    this._autoLaunch();
  }

  async logout() {
    this._stopTimers();
    try {
      await this.api.logout();
    } catch {
      /* 인터넷이 없어도 로그아웃 */
    }
    this.store.clearSession();
    this.user = null;
    this.apps = [];
    this.notices = [];
    this.storage = null;
    this.syncInfo = {};
    this.phase = 'login';
    this.emitState();
  }

  _authLost(err) {
    if (this.phase !== 'ready') return;
    this._stopTimers();
    this.store.clearSession();
    this.user = null;
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
    this.store.saveSession({ serverUrl: this.store.config.serverUrl, token: this.api.token, user: r.user });
    await this._trust(r.server);
    this.emitState();
    return r.user;
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
    this.storage = { usageBytes: r.usageBytes, quotaBytes: r.quotaBytes, apps: r.apps };
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
    return this._lock(id, async () => {
      const app = this._app(id);
      const before = this.installed[id];
      const kind = before ? 'update' : 'install';
      this._setTask(id, { kind, phase: 'download', progress: 0, text: '받는 중' });
      try {
        const running = this.runner.runningInfo(id);
        const inst = await this.installer.install(this.api, app, {
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
        this.installed[id] = inst;
        this._setTask(id, null);
        if (!quiet || !before) this._toast(before ? `${app.name}을(를) ${inst.version} 버전으로 업데이트했어요` : `${app.name}을(를) 설치했어요`, 'success');
        if (running && before) this._toast(`${app.name}을(를) 다시 켜면 새 버전으로 바뀌어요`, 'info');
        return inst;
      } catch (err) {
        this._setTask(id, null);
        throw err;
      }
    });
  }

  uninstall(id, { removeData = false } = {}) {
    return this._lock(id, async () => {
      if (this.runner.isRunning(id)) throw new Error('프로그램이 켜져 있어요. 먼저 꺼 주세요.');
      this._setTask(id, { kind: 'uninstall', phase: 'remove', progress: 0, text: '삭제하는 중' });
      try {
        await this.installer.uninstall(id);
        delete this.installed[id];
        if (removeData && this.user) {
          await fsp.rm(this.paths.account(this.user.id).app(id).root, { recursive: true, force: true });
          delete this.syncInfo[id];
        }
      } finally {
        this._setTask(id, null);
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

  syncApp(id, { quiet = false } = {}) {
    const engine = this._engine(id);
    if (!engine) return Promise.resolve(null);
    if (this._syncing?.[id]) return this._syncing[id];
    this._syncing = this._syncing || {};
    const prev = this.syncInfo[id] || {};
    this.syncInfo[id] = { ...prev, status: 'syncing', progress: null };
    this.emitState();
    const job = (async () => {
      try {
        const r = await engine.run({
          onProgress: (p) => {
            if (p.phase === 'transfer') {
              this.syncInfo[id] = { ...this.syncInfo[id], progress: p.total ? p.done / p.total : null, text: `${p.done}/${p.total}` };
              this.emitState();
            }
          },
        });
        this._online(true);
        this.syncInfo[id] = {
          status: r.errors.length ? 'partial' : 'ok',
          at: r.at,
          localOnly: r.localOnly,
          conflicts: r.conflicts.length ? r.conflicts : prev.conflicts || [],
          quotaExceeded: r.quotaExceeded,
          errors: r.errors.slice(0, 5),
          moved: r.uploaded + r.downloaded + r.deletedLocal + r.deletedRemote,
        };
        if (r.usageBytes !== null) this.storage = { ...(this.storage || {}), usageBytes: r.usageBytes, quotaBytes: r.quotaBytes };
        if (r.conflicts.length && !quiet) {
          this._toast(`${this._name(id)}: 다른 컴퓨터와 동시에 고친 파일 ${r.conflicts.length}개는 따로 보관했어요`, 'warning');
        }
        if (r.quotaExceeded) this._toast('서버 저장 공간이 꽉 차서 일부 파일을 올리지 못했어요', 'warning');
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

  async syncAll({ quiet = false } = {}) {
    const ids = Object.keys(this.installed).filter((id) => this.apps.some((a) => a.id === id));
    for (const id of ids) await this.syncApp(id, { quiet });
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

  // ---------------------------------------------------------------- 실행
  async _ticket(id) {
    const store = new TicketStore(this.paths.account(this.user.id).tickets);
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
    if (this.runner.isRunning(id)) {
      this._toast(`${this._name(id)}은(는) 이미 켜져 있어요`, 'info');
      return { already: true };
    }
    if (!this.installed[id]) await this.install(id);
    else if (this.installer.needsUpdate(this.installed[id], this._app(id))) {
      await this.install(id, { quiet: true }).catch((err) => this._toast(`업데이트하지 못해 지금 버전으로 켤게요: ${err.message}`, 'warning'));
    }
    if (!skipLegacyCheck) {
      const legacy = (await this.legacyDetect(id)).filter((l) => !l.importedHere && !l.dismissed);
      if (legacy.length) return { needsLegacy: legacy };
    }
    return this._lock(id, async () => {
      this._setTask(id, { kind: 'launch', phase: 'sync', progress: null, text: '데이터를 맞추는 중' });
      try {
        await this.syncApp(id, { quiet: true });
        this._setTask(id, { kind: 'launch', phase: 'ticket', progress: null, text: '켜는 중' });
        const ticket = await this._ticket(id);
        const dirs = this.paths.account(this.user.id).app(id);
        await fsp.mkdir(dirs.sync, { recursive: true });
        await fsp.mkdir(dirs.local, { recursive: true });
        const env = buildEnv({
          ticket,
          appId: id,
          user: this.user,
          appDirs: dirs,
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

  _onAppExit(id, info) {
    this.emitState();
    if (info.restart && this.user && info.userId === this.user.id) {
      setTimeout(() => this.launch(id, { skipLegacyCheck: true }).catch((err) => this._toast(err.message, 'error')), 600);
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
    this.emitState();
  }

  _autoLaunch() {
    if (!this.user) return;
    const s = this.store.accountSettings(this.user.id);
    for (const a of this.apps) {
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
      if (inst && this.installer.needsUpdate(inst, a) && !this.tasks.has(a.id)) {
        this.install(a.id, { quiet: true }).catch((err) => this.log.warn('[자동 업데이트]', a.id, err.message));
      }
    }
  }

  anyRunning() {
    return Object.keys(this.installed).some((id) => this.runner.isRunning(id));
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
    for (const id of [...this.adopted]) {
      if (!this.runner.isRunning(id)) {
        this.adopted.delete(id);
        try {
          fs.rmSync(this.paths.app(id).running, { force: true });
        } catch {
          /* 무시 */
        }
        this._onAppExit(id, { code: 0, restart: false, userId: this.user?.id });
      }
    }
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
  }
}

module.exports = { Cloud, verifyTicket };
