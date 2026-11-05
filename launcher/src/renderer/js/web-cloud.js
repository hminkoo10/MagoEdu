// 웹(브라우저)용 window.cloud - 같은 서버의 API 와 바로 이야기한다 (구현민 개발)
// 앱(preload.js)과 같은 메서드·같은 에러 모양({ code, status, extra })을 맞춘다.

const KEY = {
  session: 'magoedu.web.session',
  device: 'magoedu.web.device',
  lastUsername: 'magoedu.web.lastUsername',
  seen: (userId) => `magoedu.web.noticesSeen.${userId}`,
};
const APPS_EVERY = 30 * 60 * 1000;
const NOTICES_EVERY = 10 * 60 * 1000;
const WAKE_GAP = 60 * 1000;
const OPEN_WAIT = 1600;
const AUTH_LOST = ['session_invalid', 'account_suspended', 'auth_required'];
const OFFLINE = '서버에 연결하지 못했어요. 인터넷 연결을 확인하세요.';
const APP_ONLY = 'PC의 통합 클라우드 앱에서 할 수 있어요.';
const APP_ONLY_METHODS = ['install', 'uninstall', 'stop', 'sync', 'syncAll', 'setAutoLaunch', 'setDesktopShortcut', 'legacyDetect', 'legacyImport', 'legacyDismiss', 'dataInfo', 'openData', 'checkUpdate', 'installUpdate', 'quit'];

function cloudError(message, code = null, status = null, extra = null) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  e.extra = extra;
  return e;
}

// ---------------------------------------------------------------- 저장 (localStorage 를 못 쓰면 메모리만)
const memory = new Map(); // 쓰기에 실패한 값만 (메모리가 더 새것)

function load(key) {
  let raw = null;
  if (memory.has(key)) raw = memory.get(key);
  else {
    try {
      raw = localStorage.getItem(key);
    } catch {
      /* 저장소를 못 씀 */
    }
  }
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function save(key, value) {
  const raw = value === null || value === undefined ? null : JSON.stringify(value);
  try {
    if (raw === null) localStorage.removeItem(key);
    else localStorage.setItem(key, raw);
    memory.delete(key);
  } catch {
    memory.set(key, raw);
  }
}

// ---------------------------------------------------------------- 이 브라우저
function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // http 주소에서는 randomUUID 가 없다
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/**
 * 이 브라우저가 어떤 기기인지.
 * 안드로이드 태블릿의 Chrome 은 PC 처럼 보이는 주소(UA, "X11; Linux x86_64")를 보내고, iPad 도 Mac 처럼 보내서
 * userAgentData.platform 과 터치 여부를 같이 본다.
 */
export function detectClient(nav = navigator) {
  const ua = nav.userAgent || '';
  const platform = String(nav.userAgentData?.platform || '');
  const touchPoints = nav.maxTouchPoints || 0;
  let os = 'other';
  let osName = '';
  if (/iPhone|iPod/.test(ua)) [os, osName] = ['ios', 'iPhone'];
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) [os, osName] = ['ios', 'iPad'];
  else if (/Android/.test(ua) || /^android$/i.test(platform)) [os, osName] = ['android', 'Android'];
  else if (/CrOS/.test(ua) || /^chrome ?os$/i.test(platform)) osName = 'ChromeOS';
  else if (/Windows/.test(ua) || /^windows$/i.test(platform)) [os, osName] = ['windows', 'Windows'];
  else if (/Macintosh|Mac OS X/.test(ua) || /^macos$/i.test(platform)) [os, osName] = ['mac', 'Mac'];
  else if (/Linux/.test(ua) && touchPoints > 0) [os, osName] = ['android', 'Android']; // PC 처럼 보이는 안드로이드 태블릿
  else if (/Linux/.test(ua)) osName = 'Linux';
  let browser = '브라우저';
  if (/SamsungBrowser\//.test(ua)) browser = 'Samsung Internet';
  else if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'Edge';
  else if (/Whale\//.test(ua)) browser = 'Whale';
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  const mobile = os === 'ios' || os === 'android' || /Mobi/.test(ua) || !!nav.userAgentData?.mobile;
  return { os, mobile, canOpenApp: os === 'windows' && !mobile, name: [browser, osName].filter(Boolean).join(' · ') };
}

function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/** magoedu:// 주소를 연다. 1.6초 안에 창이 가려지면 앱이 열린 것으로 본다. */
function openScheme(url) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (opened) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      resolve({ opened });
    };
    const onBlur = () => finish(true);
    const onVisibility = () => document.visibilityState === 'hidden' && finish(true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    timer = setTimeout(() => finish(false), OPEN_WAIT);
    try {
      location.href = url;
    } catch {
      finish(false);
    }
  });
}

// ---------------------------------------------------------------- 상태
class WebCloud {
  constructor() {
    const c = detectClient();
    this.client = { os: c.os, mobile: c.mobile, canOpenApp: c.canOpenApp };
    let dev = load(KEY.device);
    if (!dev?.id) {
      dev = { id: uuid() };
      save(KEY.device, dev);
    }
    this.device = { id: dev.id, name: c.name, platform: 'web' };
    this.version = '';
    this.launcher = null;
    this.phase = 'boot'; // boot | login | ready
    this.token = null;
    this.user = null;
    this.authMessage = null;
    this.online = true;
    this.apps = [];
    this.notices = [];
    this.storage = null;
    this.timers = [];
    this.lastWake = 0;
    this.listeners = { state: new Set(), toast: new Set(), navigate: new Set() };
    this._emitTimer = null;
    this._watch();
    this.ready = this.init();
  }

  on(kind, cb) {
    this.listeners[kind].add(cb);
    return () => this.listeners[kind].delete(cb);
  }

  snapshot() {
    const seen = this.user ? Number(load(KEY.seen(this.user.id))) || 0 : 0;
    return {
      version: this.version,
      developer: '구현민',
      phase: this.phase,
      online: this.online,
      authMessage: this.authMessage,
      config: {
        serverUrl: location.origin,
        deviceName: this.device.name,
        autoStart: false,
        closeToTray: false,
        autoUpdateApps: false,
        lastUsername: load(KEY.lastUsername) || '',
      },
      user: this.user,
      storage: this.storage,
      notices: this.notices,
      unreadNotices: this.user ? this.notices.filter((n) => n.id > seen).length : 0,
      update: { status: 'disabled', message: '웹에서는 업데이트가 필요 없어요.' },
      apps: this.apps.map((a) => this._appView(a)),
      web: true,
      client: this.client,
      launcher: this.launcher,
    };
  }

  _appView(a) {
    return {
      id: a.id,
      name: a.name,
      description: a.description,
      color: a.color,
      platform: a.platform || 'windows',
      url: a.url || null, // 웹 프로그램 주소
      icon: a.iconUrl || null,
      release: a.release,
      coldStorage: a.coldStorage,
      installed: null,
      running: false,
      runningVersion: null,
      restartForUpdate: false,
      updateAvailable: false,
      task: null,
      autoLaunch: false,
      sync: null,
    };
  }

  emitState() {
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      const s = this.snapshot();
      for (const cb of this.listeners.state) cb(s);
    }, 40);
  }

  _online(ok) {
    if (this.online !== ok) {
      this.online = ok;
      this.emitState();
    }
  }

  // ---------------------------------------------------------------- 서버 요청
  async request(method, p, { json, auth = true, timeout = 20000, blob = false } = {}) {
    const token = auth ? this.token : null;
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let body;
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    let res;
    try {
      res = await fetch(p, { method, headers, body, cache: 'no-store', signal: timeoutSignal(timeout) });
    } catch {
      this._online(false);
      throw cloudError(OFFLINE, 'offline', 0);
    }
    if (!res.ok) throw await this._error(res, token);
    this._online(true);
    if (res.status === 204) return null;
    if (blob) return res.blob();
    const type = res.headers.get('content-type') || '';
    return type.includes('json') ? res.json() : res.text();
  }

  async _error(res, token) {
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* 본문 없음 */
    }
    const e = data?.error || {};
    const err = cloudError(e.message || `서버와 연결이 잠시 원활하지 않아요. 잠시 뒤 다시 시도하세요. (오류 ${res.status})`, e.code || `http_${res.status}`, res.status, e);
    // 지난 세션의 늦은 응답이 새 세션을 끊지 않게 같은 토큰일 때만
    if (res.status === 401 && token && token === this.token && AUTH_LOST.includes(err.code)) this._authLost(err);
    if (res.status === 403 && token && token === this.token) {
      if (err.code === 'password_change_required' && this.user) {
        this.user = { ...this.user, mustChangePassword: true };
        this._saveSession();
        this.emitState();
        err.message = '먼저 새 비밀번호를 정하세요.';
      } else if (err.code === 'student_forbidden') err.message = '학생 계정에서는 이 화면을 쓸 수 없어요.';
      else if (err.code === 'student_web_only') err.message = '학생 계정은 웹(mago.milky.kr)에서만 써요.';
    }
    return err;
  }

  // ---------------------------------------------------------------- 시작
  async init() {
    await this._meta();
    const session = load(KEY.session);
    if (session?.token && session.user) {
      this.token = session.token;
      this.user = session.user;
      this.phase = 'ready';
      this.emitState();
      this._afterLogin({ fromSession: true }).catch(() => {});
    } else {
      this.phase = 'login';
      this.emitState();
    }
  }

  async _meta() {
    const [meta, launcher] = await Promise.all([
      this.request('GET', '/api/meta', { auth: false, timeout: 8000 }).catch(() => null),
      this.request('GET', '/api/launcher', { auth: false, timeout: 8000 }).catch(() => null),
    ]);
    // 웹에 보이는 버전은 통합 클라우드 앱의 최신 버전 (서버 버전은 따로 올라감)
    if (launcher?.version || meta?.version) this.version = launcher?.version || meta.version;
    if (launcher) this.launcher = launcher.version ? { version: launcher.version } : null;
    this.device.version = this.version;
  }

  _watch() {
    // 탭이 다시 보이면 계정·공지를 새로 (60초에 한 번까지)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || this.phase !== 'ready') return;
      if (Date.now() - this.lastWake < WAKE_GAP) return;
      this.lastWake = Date.now();
      this.refreshMe().catch(() => {});
      this.refreshNotices().catch(() => {});
    });
    window.addEventListener('offline', () => this._online(false));
    window.addEventListener('online', () => {
      this._online(true);
      if (this.phase === 'ready') this.refreshMe().catch(() => {});
    });
  }

  _saveSession() {
    save(KEY.session, this.token ? { token: this.token, user: this.user } : null);
  }

  // ---------------------------------------------------------------- 로그인
  async login(username, password) {
    if (!this.version) await this._meta();
    const r = await this.request('POST', '/api/auth/login', { json: { username, password, device: this.device }, auth: false });
    save(KEY.lastUsername, r.user.username);
    await this._loggedIn(r);
    return r.user;
  }

  checkCode(code) {
    return this.request('GET', `/api/auth/codes/${encodeURIComponent(code)}`, { auth: false });
  }

  async signup(fields) {
    if (!this.version) await this._meta();
    const r = await this.request('POST', '/api/auth/signup', { json: { ...fields, device: this.device }, auth: false });
    save(KEY.lastUsername, r.user.username);
    await this._loggedIn(r);
    return r.user;
  }

  checkStudentInvite(code) {
    return this.request('GET', `/api/join/${encodeURIComponent(code)}`, { auth: false });
  }

  async joinStudent({ code, username, password }) {
    const r = await this.request('POST', '/api/join', { json: { code, username, password }, auth: false });
    save(KEY.lastUsername, r.user.username);
    await this._loggedIn(r);
    return r.user;
  }

  studentNotePdf(id) {
    return this.request('GET', `/api/me/notes/${encodeURIComponent(id)}/pdf`, { blob: true, timeout: 120000 });
  }

  async _loggedIn(r) {
    this.token = r.token;
    this.user = r.user;
    this.authMessage = null;
    this.phase = 'ready';
    this.online = true;
    this._saveSession();
    this.emitState();
    await this._afterLogin({ fromSession: false });
  }

  async _afterLogin({ fromSession }) {
    this.lastWake = Date.now();
    if (fromSession || this.user?.role === 'student') await this.refreshMe().catch(() => {});
    if (this.phase !== 'ready') return;
    this._startTimers();
    if (this.user?.role === 'student') return;
    await Promise.all([this.refreshApps().catch(() => {}), this.refreshNotices().catch(() => {})]);
  }

  async logout() {
    this._stopTimers();
    try {
      await this.request('POST', '/api/auth/logout', { json: {}, timeout: 5000 });
    } catch {
      /* 서버에 못 알려도 이 브라우저에서는 로그아웃 */
    }
    this._clear();
    this.authMessage = null;
    this.emitState();
  }

  _authLost(err) {
    if (this.phase !== 'ready') return;
    this._stopTimers();
    this._clear();
    this.authMessage = err.message;
    this.emitState();
  }

  _clear() {
    this.token = null;
    this.user = null;
    this.apps = [];
    this.notices = [];
    this.storage = null;
    this.phase = 'login';
    this._saveSession();
  }

  // ---------------------------------------------------------------- 내 계정
  async refreshMe() {
    const r = await this.request('GET', '/api/me');
    if (this.phase !== 'ready') return r.user;
    this.user = r.user;
    this.storage = { usageBytes: r.user.usageBytes, quotaBytes: r.user.quotaBytes };
    this._saveSession();
    this.emitState();
    return r.user;
  }

  async changePassword(currentPassword, newPassword, logoutOthers = true) {
    await this.request('PATCH', '/api/me/password', { json: { currentPassword, newPassword, logoutOthers } });
    return this.refreshMe();
  }

  async changeUsername(username, password) {
    if (this.user?.role === 'student') await this.request('PATCH', '/api/me', { json: { username } });
    else await this.request('PATCH', '/api/me/username', { json: { username, password } });
    const u = await this.refreshMe();
    save(KEY.lastUsername, u.username);
    return u;
  }

  async changeName(name) {
    await this.request('PATCH', '/api/me/name', { json: { name } });
    return this.refreshMe();
  }

  /** 관리 화면에서 쓰는 서버 요청 (로그인 정보를 붙여서) */
  api(method, p, body) {
    if (!/^\/api\//.test(String(p))) return Promise.reject(cloudError('잘못된 요청'));
    const m = String(method).toUpperCase();
    return this.request(m, p, body !== undefined && m !== 'GET' ? { json: body } : {});
  }

  // ---------------------------------------------------------------- 목록·공지
  async refreshApps() {
    if (this.user?.role === 'student') return [];
    const r = await this.request('GET', '/api/apps');
    if (this.phase !== 'ready') return r.apps;
    this.apps = r.apps;
    this.emitState();
    return this.apps;
  }

  async refreshNotices() {
    if (this.user?.role === 'student') return [];
    const r = await this.request('GET', '/api/notices');
    if (this.phase !== 'ready') return r.notices;
    this.notices = r.notices;
    this.emitState();
    return this.notices;
  }

  noticesSeen() {
    if (!this.user) return;
    save(KEY.seen(this.user.id), Math.max(0, ...this.notices.map((n) => n.id)));
    this.emitState();
  }

  async refreshStorage() {
    if (this.user?.role === 'student') throw cloudError('학생 계정에서는 저장 공간을 쓸 수 없어요.', 'student_forbidden', 403);
    const r = await this.request('GET', '/api/sync');
    if (this.phase !== 'ready') return r;
    this.storage = { usageBytes: r.usageBytes, quotaBytes: r.quotaBytes, apps: r.apps, academy: r.academy || null };
    this.emitState();
    return r;
  }

  // ---------------------------------------------------------------- 주기 작업
  _startTimers() {
    this._stopTimers();
    const every = (ms, fn) => this.timers.push(setInterval(() => this.phase === 'ready' && fn(), ms));
    if (this.user?.role === 'student') {
      every(NOTICES_EVERY, () => this.refreshMe().catch(() => {}));
      return;
    }
    every(APPS_EVERY, () => this.refreshApps().catch(() => {}));
    every(NOTICES_EVERY, () => this.refreshNotices().catch(() => {}));
  }

  _stopTimers() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  // ---------------------------------------------------------------- 그 밖
  setConfig(patch) {
    if (patch && typeof patch.lastUsername === 'string') save(KEY.lastUsername, patch.lastUsername);
    this.emitState();
    return this.snapshot().config;
  }

  openExternal(url) {
    if (/^https?:\/\//i.test(String(url))) window.open(url, '_blank', 'noopener');
  }

  async copy(text) {
    try {
      await navigator.clipboard.writeText(String(text));
      return;
    } catch {
      /* 아래 방법으로 */
    }
    const ta = document.createElement('textarea');
    ta.value = String(text);
    ta.setAttribute('readonly', '');
    Object.assign(ta.style, { position: 'fixed', top: '0', left: '0', opacity: '0', fontSize: '16px' });
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    if (!ok) throw cloudError('복사하지 못했어요. 직접 골라서 복사하세요.');
  }
}

export function createWebCloud() {
  const c = new WebCloud();
  const call = (fn) => async (...args) => fn(...args);
  const bridge = {
    getState: async () => {
      await c.ready;
      return c.snapshot();
    },
    onState: (cb) => c.on('state', cb),
    onToast: (cb) => c.on('toast', cb),
    onNavigate: (cb) => c.on('navigate', cb),

    setServer: () => Promise.reject(cloudError('웹에서는 서버 주소를 바꿀 수 없어요.', 'app_only')),
    login: call((u, p) => c.login(u, p)),
    checkCode: call((code) => c.checkCode(code)),
    signup: call((fields) => c.signup(fields)),
    checkStudentInvite: call((code) => c.checkStudentInvite(code)),
    joinStudent: call((fields) => c.joinStudent(fields)),
    studentNotePdf: call((id) => c.studentNotePdf(id)),
    logout: call(() => c.logout()),

    refreshMe: call(() => c.refreshMe()),
    changePassword: call((cur, next, others) => c.changePassword(cur, next, others)),
    changeUsername: call((u, p) => c.changeUsername(u, p)),
    changeName: call((n) => c.changeName(n)),
    api: call((method, p, body) => c.api(method, p, body)),

    refreshApps: call(() => c.refreshApps()),
    launch: call((id) => openScheme(`magoedu://launch/${encodeURIComponent(id)}`)),
    installInApp: call((id) => openScheme(`magoedu://install/${encodeURIComponent(id)}`)),
    openApp: call(() => openScheme('magoedu://open')),

    refreshNotices: call(() => c.refreshNotices()),
    noticesSeen: call(() => c.noticesSeen()),
    refreshStorage: call(() => c.refreshStorage()),
    setConfig: call((patch) => c.setConfig(patch)),
    openExternal: call((url) => c.openExternal(url)),
    copy: call((text) => c.copy(text)),
  };
  for (const name of APP_ONLY_METHODS) bridge[name] = () => Promise.reject(cloudError(APP_ONLY, 'app_only'));
  return bridge;
}
