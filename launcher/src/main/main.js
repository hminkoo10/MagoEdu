'use strict';

// 마고에듀 통합 클라우드 - 구현민 개발
// Electron 메인 프로세스: 창, 트레이, 자동 실행, 화면과 주고받는 기능(IPC)

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, clipboard, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const log = require('electron-log/main');

app.setName('MagoEduCloud');
if (process.env.MAGOEDU_CLOUD_USER_DATA) app.setPath('userData', process.env.MAGOEDU_CLOUD_USER_DATA);

log.initialize();
log.transports.file.level = 'info';

const { makePaths } = require('../core/paths');
const { Store } = require('./store');
const { Cloud } = require('./cloud');
const { setupSelfUpdate } = require('./selfupdate');

const TITLE = '마고에듀 통합 클라우드';
const DEVELOPER = '구현민';
const ROOT = path.join(__dirname, '..', '..');
const startHidden = process.argv.includes('--hidden');
const isTest = process.env.MAGOEDU_CLOUD_TEST === '1';

function loadDefaults() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'defaults.json'), 'utf8'));
  } catch {
    return {};
  }
}

let win = null;
let tray = null;
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
    title: `${TITLE} ${app.getVersion()} - ${DEVELOPER} 개발`,
    backgroundColor: '#F2F4F6',
    icon: iconPath() || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
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
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
  win.once('ready-to-show', () => {
    if (show) win.show();
  });
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
  if (state.phase === 'ready') {
    const apps = state.apps.filter((a) => a.installed);
    if (apps.length) {
      items.push({ type: 'separator' });
      for (const a of apps) {
        items.push({
          label: `${a.name}${a.running ? ' (켜져 있음)' : ''}`,
          click: () => doLaunch(a.id),
        });
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
  tray.setContextMenu(buildTrayMenu(cloud.snapshot()));
}

async function doLaunch(id) {
  try {
    const r = await cloud.launch(id);
    if (r?.needsLegacy) {
      showWindow();
      send('navigate', { view: 'home', legacyFor: id, legacy: r.needsLegacy });
    }
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

// ---------------------------------------------------------------- magoedu:// 주소 (프로그램이 통합 클라우드를 부를 때)
function handleProtocol(argv) {
  const url = argv.find((a) => /^magoedu:\/\//i.test(a));
  if (!url) return false;
  try {
    const u = new URL(url);
    const [kind, id] = [u.hostname, u.pathname.replace(/^\/+/, '')];
    showWindow();
    if (kind === 'launch' && id && cloud.phase === 'ready') doLaunch(id);
  } catch {
    /* 무시 */
  }
  return true;
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
  handle('state:get', () => cloud.snapshot());
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
if (!isTest && !app.requestSingleInstanceLock()) {
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
    const userData = app.getPath('userData');
    const localData = process.env.MAGOEDU_CLOUD_LOCAL_DATA || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'MagoEduCloud') : path.join(userData, 'local'));
    const paths = makePaths({ userData, localData });
    const store = new Store({ paths, safeStorage, defaults: loadDefaults() });
    cloud = new Cloud({ paths, store, version: app.getVersion(), log });
    let trayKey = '';
    cloud.on('state', (s) => {
      send('state', s);
      const key = JSON.stringify([s.phase, s.apps.filter((a) => a.installed).map((a) => [a.id, a.name, a.running])]);
      if (tray && key !== trayKey) {
        trayKey = key;
        tray.setContextMenu(buildTrayMenu(s));
      }
    });
    cloud.on('toast', (t) => send('toast', t));
    cloud.on('config', (cfg) => applyAutoStart(cfg));
    registerIpc();
    createWindow({ show: !startHidden });
    createTray();
    applyAutoStart(store.config);
    updater = setupSelfUpdate({ app, cloud, log, isWindowVisible: () => !!win && win.isVisible() });
    await cloud.init();
    handleProtocol(process.argv);
  });

  app.on('before-update-install', () => {
    quitting = true;
  });
  app.on('before-quit', () => {
    quitting = true;
    cloud?.shutdown();
  });
  app.on('window-all-closed', () => {
    if (isTest || !cloud?.store.config.closeToTray || cloud.phase !== 'ready') quitApp();
  });
}

process.on('unhandledRejection', (err) => log.warn('[처리 안 된 오류]', err?.message || err));
