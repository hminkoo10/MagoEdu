'use strict';

// 마고에듀 통합 클라우드 - 구현민 개발
// Electron 메인 프로세스: 창, 트레이, 자동 실행, 화면과 주고받는 기능(IPC)

const { Notification, app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, clipboard, safeStorage, powerMonitor, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const log = require('electron-log/main');

app.setName('MagoEduCloud');
if (process.env.MAGOEDU_CLOUD_USER_DATA) app.setPath('userData', process.env.MAGOEDU_CLOUD_USER_DATA);

log.initialize();
log.transports.file.level = 'info';

const { makePaths } = require('../core/paths');
const { Store, validServerUrl } = require('./store');
const { Cloud } = require('./cloud');
const { Shortcuts } = require('./shortcuts');
const { setupSelfUpdate } = require('./selfupdate');
const { uninstallCleanup } = require('./uninstall');
const { sanitizeDefaults, sanitizeResume } = require('./startup');
const { readJsonSync, writeJsonSync } = require('../core/fsutil');
const { trayMenuItems } = require('./tray-menu-model');
const { createTrayPopup } = require('./tray-popup');

const TITLE = '마고에듀 통합 클라우드';
const ROOT = path.join(__dirname, '..', '..');
const startHidden = process.argv.includes('--hidden');
const uninstalling = process.argv.includes('--uninstall-cleanup'); // 제거 프로그램이 부름 (uninstall.js)
const isTest = process.env.MAGOEDU_CLOUD_TEST === '1';
// 배포본에서는 개발자 도구를 막는다 (창의 개발자 도구, 원격 디버깅으로 붙기). 개발 실행(npm start)에서만 열 수 있음
const devTools = !app.isPackaged;
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk'];

function loadDefaults() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(__dirname, 'defaults.json'), 'utf8'));
    return sanitizeDefaults(value, validServerUrl);
  } catch {
    return {};
  }
}

let win = null;
let tray = null;
let trayPopup = null;
let cloud = null;
let updater = null;
let quitting = false;
let trayHintShown = false;

function iconPath(name = 'icon.png') {
  const p = path.join(ROOT, 'build', name);
  return fs.existsSync(p) ? p : null;
}

function createWindow({ show }) {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: `${TITLE} ${app.getVersion()}`,
    backgroundColor: '#F2F4F6',
    icon: iconPath() || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools,
    },
  });
  win.removeMenu();
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (e, input) => {
    if (devTools && input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
  win.once('ready-to-show', () => {
    if (show) win.show();
  });
  win.on('show', () => cloud.emitState());
  win.on('hide', () => cloud.emitState());
  win.on('closed', () => trayPopup?.destroy());
  win.on('focus', () => cloud.emitState());
  win.on('close', (e) => {
    if (quitting || !cloud.store.config.closeToTray || cloud.phase !== 'ready' || isTest) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && tray && process.platform === 'win32') {
      trayHintShown = true;
      tray.displayBalloon({ title: TITLE, content: '창을 닫아도 동기화와 자동 실행은 계속돼요. 완전히 끄려면 트레이 아이콘에서 ‘종료’를 눌러 주세요.' });
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function showWindow() {
  trayPopup?.close();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- 트레이
function buildTrayMenu(state) {
  const items = [{ label: '열기', click: showWindow }];
  if (win?.isVisible()) items.push({ label: '숨기기', click: () => win.hide() });
  if (state.phase === 'ready') {
    const apps = state.apps.filter((a) => a.installed);
    if (apps.length) {
      items.push({ type: 'separator' });
      for (const a of apps) {
        items.push({
          label: `${a.name}${a.running ? ' (켜져 있음)' : ''}`,
          click: () => doLaunch(a.id),
        });
        if (a.running) items.push({ label: `${a.name} 끄기`, click: () => cloud.stop(a.id) });
      }
    }
    items.push({ type: 'separator' }, { label: '지금 동기화', click: () => cloud.syncAll() });
  }
  items.push({ type: 'separator' }, { label: '종료', click: () => quitApp() });
  return Menu.buildFromTemplate(items);
}

function createTray() {
  const p = iconPath('tray.png') || iconPath();
  if (!p) return;
  const img = nativeImage.createFromPath(p).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip(TITLE);
  tray.on('click', showWindow);
  const fallback = () => tray.popUpContextMenu(buildTrayMenu(cloud.snapshot()));
  try {
    trayPopup = createTrayPopup({
      BrowserWindow, ipcMain, screen, log,
      getItems: () => trayMenuItems(cloud.snapshot(), !!win?.isVisible()),
      getTrayBounds: () => tray.getBounds(),
      fallback,
      activate: (item) => {
        if (item.action === 'launch') return doLaunch(item.appId);
        if (item.action === 'stop') return cloud.stop(item.appId);
        if (item.id === 'open') return showWindow();
        if (item.id === 'hide') return win.hide();
        if (item.id === 'sync') return cloud.syncAll();
        if (item.id === 'quit') return quitApp();
      },
    });
  } catch (error) {
    log.warn('[트레이] 팝업 준비 실패', error.message);
  }
  tray.on('right-click', () => trayPopup ? trayPopup.toggle() : fallback());
}

/** fromLink: 바로 가기·웹에서 부름 → 창은 꼭 필요할 때만 (설치·업데이트 진행, 예전 데이터 묻기, 오류) */
async function doLaunch(id, { fromLink = false } = {}) {
  try {
    if (fromLink && !cloud.canLaunchNow(id)) showWindow();
    const r = await cloud.launch(id);
    if (r?.needsLegacy) {
      showWindow();
      send('navigate', { view: 'home', legacyFor: id, legacy: r.needsLegacy });
    }
  } catch (err) {
    if (fromLink) showWindow();
    send('toast', { text: err.message, kind: 'error' });
  }
}

/** 웹의 ‘PC에 설치’(magoedu://install/<id>): 설치·업데이트만 하고 켜지는 않는다. 진행은 프로그램 화면에서 보여 줌 */
async function doInstall(id) {
  showWindow();
  send('navigate', { view: 'home' });
  try {
    await cloud.installFromLink(id);
  } catch (err) {
    send('toast', { text: err.message, kind: 'error' });
  }
}

function quitApp() {
  quitting = true;
  app.quit();
}

// ---------------------------------------------------------------- 자동 실행
function applyAutoStart(cfg) {
  if (!app.isPackaged || isTest) return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!cfg.autoStart, args: ['--hidden'] });
  } catch (err) {
    log.warn('자동 실행 설정 실패', err.message);
  }
}

// ---------------------------------------------------------------- magoedu:// 주소 (바로 가기·웹·프로그램이 통합 클라우드를 부를 때)
//   magoedu://launch/<id>  : 그 프로그램을 켠다 (필요하면 설치·업데이트부터).
//   magoedu://install/<id> : 설치·업데이트만 한다 (웹의 ‘PC에 설치’).
//   magoedu://open         : 창만 연다.
// launch·install 은 로그인 정보를 확인하는 중이면 기다리고, 로그인 전이면 로그인한 뒤에 한다.
let pendingLink = null; // { kind, id }

function linkFrom(argv) {
  const url = argv.find((a) => /^magoedu:\/\//i.test(a));
  if (!url) return null;
  try {
    const u = new URL(url);
    return { kind: u.hostname.toLowerCase(), id: decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, '')) };
  } catch {
    return { kind: '', id: '' };
  }
}

function handleProtocol(argv) {
  const link = linkFrom(argv);
  if (!link) return false;
  if ((link.kind === 'launch' || link.kind === 'install') && link.id) {
    pendingLink = link;
    if (link.kind === 'install') showWindow();
    runPending();
  } else {
    showWindow();
  }
  return true;
}

function runPending() {
  if (!pendingLink || !cloud) return;
  if (cloud.phase !== 'ready') {
    showWindow(); // 로그인하면 'ready' 로 다시 옴
    return;
  }
  if (!cloud.settled) return; // 세션 확인·목록 새로 고침이 끝나면 'ready' 로 다시 옴
  const { kind, id } = pendingLink;
  pendingLink = null;
  if (kind === 'install') doInstall(id);
  else doLaunch(id, { fromLink: true });
}

// ---------------------------------------------------------------- IPC
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: { message: err.message || String(err), code: err.code || null, status: err.status || null, extra: err.extra || null } };
    }
  });
}

function registerIpc() {
  handle('inquiry:refresh', () => cloud.refreshInquiries());
  handle('inquiry:viewing', id => { cloud.viewingInquiry = Number(id) || null; });
  handle('inquiry:upload', async bytes => {
    if (!(bytes instanceof Uint8Array) || bytes.length > 5 * 1024 * 1024) throw new Error('Invalid photo');
    const res = await cloud.api._send('POST', '/api/inquiries/photos', { body: Buffer.from(bytes) });
    if (!res.ok) throw await cloud.api._error(res);
    return res.json();
  });
  handle('inquiry:photo', async (id, photoId) => {
    if (!Number.isSafeInteger(id) || !/^[a-f0-9]{48}$/.test(photoId)) throw new Error('Invalid photo');
    const res = await cloud.api._send('GET', `/api/inquiries/${id}/photos/${photoId}`);
    if (!res.ok) throw await cloud.api._error(res);
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') };
  });
  handle('state:get', () => cloud.snapshot());
  handle('releaseNotes:get', () => readJsonSync(path.join(ROOT, 'src', 'renderer', 'release-notes.json'), null));
  handle('server:set', (url) => cloud.setServer(url));
  handle('auth:login', (u, p) => cloud.login(u, p));
  handle('auth:checkCode', (code) => cloud.checkCode(code));
  handle('auth:signup', (fields) => cloud.signup(fields));
  handle('auth:logout', () => cloud.logout());
  handle('me:refresh', () => cloud.refreshMe());
  handle('me:password', (cur, next, others) => cloud.changePassword(cur, next, others));
  handle('me:username', (u, p) => cloud.changeUsername(u, p));
  handle('me:name', (n) => cloud.changeName(n));
  handle('api', (method, p, body) => cloud.apiCall(method, p, body));

  handle('apps:refresh', () => cloud.refreshApps());
  handle('apps:install', (id) => cloud.install(id));
  handle('apps:uninstall', (id, opts) => cloud.uninstall(id, opts));
  handle('apps:launch', (id, opts) => cloud.launch(id, opts));
  handle('apps:stop', (id) => cloud.stop(id));
  handle('apps:sync', (id) => cloud.syncApp(id));
  handle('apps:syncAll', () => cloud.syncAll());
  handle('apps:autoLaunch', (id, on) => cloud.setAutoLaunch(id, on));
  handle('apps:desktopShortcut', (id, on) => cloud.setDesktopShortcut(id, on));
  handle('apps:legacyDetect', (id) => cloud.legacyDetect(id));
  handle('apps:legacyImport', (id, lid) => cloud.legacyImport(id, lid));
  handle('apps:legacyDismiss', (id, lid) => cloud.legacyDismiss(id, lid));
  handle('apps:dataInfo', async (id) => {
    const r = await cloud.appDataInfo(id);
    return r && { sync: r.sync, local: r.local };
  });
  handle('apps:openData', async (id, which = 'sync') => {
    const r = await cloud.appDataInfo(id);
    if (!r) return false;
    const dir = which === 'conflicts' ? r.dirs.conflicts : r.dirs.sync;
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });

  handle('notices:refresh', () => cloud.refreshNotices());
  handle('notices:seen', () => cloud.markNoticesSeen());
  handle('storage:refresh', () => cloud.refreshStorage());
  handle('config:set', (patch) => cloud.setConfig(patch));
  handle('update:check', () => updater.check());
  handle('update:install', () => updater.install());
  handle('shell:openExternal', (url) => (/^https?:\/\//.test(url) ? shell.openExternal(url) : false));
  handle('clipboard:write', (text) => clipboard.writeText(String(text)));
  handle('app:quit', () => quitApp());
  handle('app:confirmQuitInfo', () => ({ running: cloud.anyRunning() }));
}

// ---------------------------------------------------------------- 시작
// 자동 업데이트로 다시 켜질 때 이어받을 것: 창을 숨겨 둔 채였는지, 윈도우 시작 때 켤 프로그램을 아직 켜지 않았는지.
// 업데이트 뒤에는 '--updated' 로 켜져서 '--hidden' 이 없으니, 설치하기 직전에 적어 둔다
const resumeFile = () => path.join(app.getPath('userData'), 'update-resume.json');

function takeResume() {
  const value = readJsonSync(resumeFile(), null);
  try {
    fs.rmSync(resumeFile(), { force: true });
  } catch {
    /* 무시 */
  }
  return process.argv.includes('--updated') ? sanitizeResume(value) : null;
}

function appPaths() {
  const userData = app.getPath('userData');
  const localData = process.env.MAGOEDU_CLOUD_LOCAL_DATA || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'MagoEduCloud') : path.join(userData, 'local'));
  return makePaths({ userData, localData });
}

// 바로 가기는 설치한 통합 클라우드에서만 (개발 모드의 electron.exe 를 가리키면 안 됨)
function appShortcuts() {
  if (!app.isPackaged || process.platform !== 'win32' || isTest) return null;
  return new Shortcuts({
    shell,
    exePath: process.execPath,
    desktopDir: app.getPath('desktop'),
    startMenuDir: path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    log,
  });
}

/** 통합 클라우드를 지울 때: 켜 둔 프로그램 끄기, 설치한 프로그램·프로그램 바로 가기·magoedu:// 주소·자동 실행 등록 지우기 */
async function runUninstallCleanup() {
  try {
    const paths = appPaths();
    const r = await uninstallCleanup({ paths, config: readJsonSync(paths.configFile, {}), shortcuts: appShortcuts(), log });
    if (app.isPackaged && !isTest) {
      app.removeAsDefaultProtocolClient('magoedu');
      app.setLoginItemSettings({ openAtLogin: false, args: ['--hidden'] });
    }
    log.info('[지우기] 정리했어요', r);
  } catch (err) {
    log.warn('[지우기] 정리하지 못했어요', err.message);
  }
  app.exit(0);
}

if (app.isPackaged && DEBUG_SWITCHES.some((s) => app.commandLine.hasSwitch(s))) {
  app.exit(1); // 디버깅 연결을 열고 켜려고 하면 켜지 않음
} else if (uninstalling) {
  app.whenReady().then(runUninstallCleanup);
} else if (!isTest && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!handleProtocol(argv)) showWindow();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    if (!isTest) {
      try {
        app.setAsDefaultProtocolClient('magoedu');
      } catch {
        /* 무시 */
      }
    }
    const paths = appPaths();
    const store = new Store({ paths, safeStorage, defaults: loadDefaults() });
    const resume = takeResume();
    const hidden = startHidden || !!resume?.hidden;
    cloud = new Cloud({ paths, store, version: app.getVersion(), log, shortcuts: appShortcuts(), startedAtLogin: resume ? !!resume.autoLaunch : startHidden });
    cloud.on('inquiry', event => {
      void require('./inquiry-notifications').notifyInquiry({ event, cloud, Notification, window: win,
        navigate: id => { showWindow(); send('navigate', { view: 'inquiries', inquiryId: id }); }
      }).catch(() => {});
    });
    cloud.on('state', (s) => {
      send('state', s);
      trayPopup?.refresh();
      if (pendingLink && s.phase !== 'ready' && s.phase !== 'boot') showWindow(); // 로그인이 필요해짐
    });
    cloud.on('ready', () => runPending());
    cloud.on('toast', (t) => send('toast', t));
    cloud.on('config', (cfg) => applyAutoStart(cfg));
    registerIpc();
    // 바로 가기로 켰고 로그인 정보가 있으면 창 없이 프로그램만 (필요하면 그때 창을 보여 줌)
    const linkStart = linkFrom(process.argv)?.kind === 'launch' && !!store.loadSession();
    createWindow({ show: !hidden && !linkStart });
    createTray();
    applyAutoStart(store.config);
    updater = setupSelfUpdate({ app, cloud, log, powerMonitor, isWindowVisible: () => !!win && win.isVisible() });
    await cloud.init();
    handleProtocol(process.argv);
  });

  app.on('before-update-install', () => {
    quitting = true;
    try {
      writeJsonSync(resumeFile(), { at: Date.now(), hidden: !(win && win.isVisible()), autoLaunch: !!cloud?.autoLaunchPending });
    } catch (err) {
      log.warn('[업데이트] 이어받을 상태를 적지 못했어요', err.message);
    }
  });
  app.on('update-install-failed', () => {
    quitting = false; // 설치가 시작되지 않았으면 다시 평소처럼 트레이로 닫기
  });
  app.on('before-quit', () => {
    quitting = true;
    trayPopup?.destroy();
    cloud?.shutdown();
  });
  app.on('window-all-closed', () => {
    if (isTest || !cloud?.store.config.closeToTray || cloud.phase !== 'ready') quitApp();
  });
}

process.on('unhandledRejection', (err) => log.warn('[처리 안 된 오류]', err?.message || err));
