'use strict';

// 통합 클라우드 자동 업데이트
//   서버의 /updates/launcher/ 에서 새 버전을 찾는다. (서버가 GitHub Releases 에서 가져와 넘겨 줌)
//   받아 두었다가, 켜져 있는 프로그램이 없고 창이 닫혀 있을 때 조용히 설치하고 다시 켠다.

const CHECK_EVERY = 60 * 60 * 1000;
const CHECK_MIN_GAP = 10 * 60 * 1000; // 절전 복귀·정기 확인이 겹쳐도 너무 자주 요청하지 않음
const INSTALL_NOTICE_MS = 3000; // 수동 설치 안내를 읽을 시간을 준 뒤 종료

function setupSelfUpdate({ app, cloud, log, isWindowVisible, powerMonitor, updater: suppliedUpdater }) {
  const set = (u) => {
    cloud.update = { current: app.getVersion(), ...u };
    cloud.emitState();
  };

  if (!app.isPackaged || process.env.MAGOEDU_CLOUD_NO_UPDATE === '1') {
    set({ status: 'disabled', message: '개발 모드에서는 자동 업데이트를 하지 않아요.' });
    return { check: async () => cloud.update, install: () => cloud.update };
  }

  let updater;
  try {
    updater = suppliedUpdater || require('electron-updater').autoUpdater;
  } catch (err) {
    log.error('electron-updater 를 불러오지 못했어요', err);
    set({ status: 'disabled', message: '자동 업데이트를 쓸 수 없어요.' });
    return { check: async () => cloud.update, install: () => cloud.update };
  }

  updater.logger = log;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.autoRunAppAfterInstall = true;
  updater.disableDifferentialDownload = true;

  let pending = null;
  let idleTimer = null;
  let installing = false;
  let installTimer = null;
  let manualRequested = false;
  let downloaded = false;
  let lastCheck = -Infinity;
  const feed = () => {
    const url = cloud.store.config.serverUrl;
    if (!url) return false;
    updater.setFeedURL({ provider: 'generic', url: `${url}/updates/launcher/` });
    return true;
  };

  updater.on('checking-for-update', () => set({ ...pending, status: 'checking' }));
  updater.on('update-available', (info) => {
    pending = { version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes.replace(/<[^>]+>/g, '').slice(0, 2000) : '' };
    set({ ...pending, status: 'available' });
  });
  updater.on('update-not-available', () => set({ status: 'latest', checkedAt: Date.now() }));
  updater.on('download-progress', (p) => set({ ...pending, status: 'downloading', percent: Math.round(p.percent || 0) }));
  updater.on('update-downloaded', (info) => {
    pending = { ...pending, version: info.version };
    downloaded = true;
    set({ ...pending, status: 'ready' });
    scheduleIdleInstall();
  });
  function fail(err) {
    clearTimeout(installTimer);
    clearInterval(idleTimer);
    installTimer = idleTimer = null;
    if (installing) app.emit('update-install-failed');
    installing = false;
    manualRequested = false;
    set({ ...pending, status: 'error', canRetryInstall: downloaded, message: String(err?.message || err).slice(0, 300) });
  }
  updater.on('error', fail);

  function scheduleIdleInstall({ immediate = false } = {}) {
    if (idleTimer) clearInterval(idleTimer);
    const attempt = () => {
      if (!['ready', 'deferred'].includes(cloud.update.status)) return;
      if (cloud.anyAppInstallTask()) return;
      if (!manualRequested && (cloud.anyRunning() || isWindowVisible())) return;
      install({ automatic: !manualRequested });
      if (installing) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
    };
    idleTimer = setInterval(attempt, 60 * 1000);
    idleTimer.unref?.();
    if (immediate) attempt();
  }

  async function check({ automatic = false } = {}) {
    if (automatic && cloud.update.canRetryInstall) return cloud.update;
    if (automatic && Date.now() - lastCheck < CHECK_MIN_GAP) return cloud.update;
    if (['checking', 'downloading', 'ready', 'deferred', 'installing'].includes(cloud.update.status)) return cloud.update;
    if (!feed()) return cloud.update;
    lastCheck = Date.now();
    downloaded = false;
    try {
      await updater.checkForUpdates();
    } catch (err) {
      fail(err);
    }
    return cloud.update;
  }

  function deferInstall() {
    installing = false;
    set(manualRequested
      ? { ...pending, status: 'deferred', message: '프로그램 설치가 끝나면 바로 업데이트해요.' }
      : { ...pending, status: 'ready' });
    scheduleIdleInstall();
  }

  function install({ automatic = false } = {}) {
    if (installing || (!['ready', 'deferred'].includes(cloud.update.status) && !cloud.update.canRetryInstall)) return cloud.update;
    manualRequested ||= !automatic;
    if (cloud.anyAppInstallTask()) {
      deferInstall();
      return cloud.update;
    }
    installing = true;
    set({ ...pending, status: 'installing', message: '업데이트를 설치하려고 잠시 닫아요. 1분쯤 뒤에 다시 켜져요.' });
    installTimer = setTimeout(() => {
      installTimer = null;
      // 예약한 뒤 앱 작업이 들어올 수 있어서, 실제로 종료하기 직전에 다시 확인
      if (cloud.anyAppInstallTask()) {
        deferInstall();
        return;
      }
      if (!manualRequested && (cloud.anyRunning() || isWindowVisible())) {
        installing = false;
        set({ ...pending, status: 'ready' });
        scheduleIdleInstall();
        return;
      }
      try {
        app.emit('before-update-install');
        updater.quitAndInstall(true, true);
      } catch (err) {
        fail(err);
      }
    }, manualRequested ? INSTALL_NOTICE_MS : 0);
    installTimer.unref?.();
    return cloud.update;
  }

  set({ status: 'idle' });
  const automaticCheck = () => check({ automatic: true });
  const first = setTimeout(automaticCheck, 8000);
  first.unref?.();
  const t = setInterval(automaticCheck, CHECK_EVERY);
  t.unref?.();
  powerMonitor?.on('resume', automaticCheck);
  cloud.on('server-changed', () => check());
  cloud.on('app-task-settled', () => {
    if (['ready', 'deferred'].includes(cloud.update.status) && !installing) scheduleIdleInstall({ immediate: true });
  });
  return { check, install };
}

module.exports = { setupSelfUpdate };
