'use strict';

// 통합 클라우드 자동 업데이트
//   서버의 /updates/launcher/ 에서 새 버전을 찾는다. (서버가 GitHub Releases 에서 가져와 넘겨 줌)
//   받아 두었다가, 켜져 있는 프로그램이 없고 창이 닫혀 있을 때 조용히 설치하고 다시 켠다.

const CHECK_EVERY = 6 * 60 * 60 * 1000;

function setupSelfUpdate({ app, cloud, log, isWindowVisible }) {
  const set = (u) => {
    cloud.update = { current: app.getVersion(), ...u };
    cloud.emitState();
  };

  if (!app.isPackaged || process.env.MAGOEDU_CLOUD_NO_UPDATE === '1') {
    set({ status: 'disabled', message: '개발 모드에서는 자동 업데이트를 하지 않아요.' });
    return { check: async () => cloud.update, install: () => false };
  }

  let updater;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (err) {
    log.error('electron-updater 를 불러오지 못했어요', err);
    set({ status: 'disabled', message: '자동 업데이트를 쓸 수 없어요.' });
    return { check: async () => cloud.update, install: () => false };
  }

  updater.logger = log;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.disableDifferentialDownload = true;

  let pending = null;
  let idleTimer = null;
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
    set({ ...pending, version: info.version, status: 'ready' });
    scheduleIdleInstall();
  });
  updater.on('error', (err) => set({ ...pending, status: 'error', message: String(err?.message || err).slice(0, 300) }));

  function scheduleIdleInstall() {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = setInterval(() => {
      if (cloud.update.status !== 'ready') return;
      if (cloud.anyRunning() || isWindowVisible()) return;
      clearInterval(idleTimer);
      install();
    }, 60 * 1000);
    idleTimer.unref?.();
  }

  async function check() {
    if (!feed()) return cloud.update;
    if (['checking', 'downloading', 'ready'].includes(cloud.update.status)) return cloud.update;
    try {
      await updater.checkForUpdates();
    } catch (err) {
      set({ ...pending, status: 'error', message: String(err?.message || err).slice(0, 300) });
    }
    return cloud.update;
  }

  function install() {
    if (cloud.update.status !== 'ready') return false;
    app.emit('before-update-install');
    setImmediate(() => updater.quitAndInstall(true, true));
    return true;
  }

  set({ status: 'idle' });
  const first = setTimeout(check, 8000);
  first.unref?.();
  const t = setInterval(check, CHECK_EVERY);
  t.unref?.();
  cloud.on('server-changed', () => check());
  return { check, install };
}

module.exports = { setupSelfUpdate };
