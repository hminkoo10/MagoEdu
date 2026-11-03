'use strict';

// 프로그램 설치·업데이트·삭제
//
// 새 버전은 옆 폴더에 풀어 두고 installed.json 만 바꾼다. 그래서 프로그램이 켜져 있어도 업데이트를 받아 둘 수 있고,
// 다음에 켤 때(또는 프로그램이 스스로 다시 켜질 때) 새 버전으로 바뀐다. 예전 버전 폴더는 쓰지 않을 때 지운다.

// Electron 안에서는 .asar 파일을 폴더처럼 다루는 fs 대신 원래 fs (보통 fs 로 app.asar 를 건드리면 파일을 잡고 있어서 폴더를 옮기거나 지우지 못함)
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { readJson, writeJson } = require('./fsutil');
const { extractZip } = require('./zip');
const { readManifest, normalizeManifest } = require('./manifest');
const { compareVersions } = require('./version');

const VERSION_RE = /^[0-9A-Za-z._-]{1,80}$/;

function safeVersion(value) {
  return typeof value === 'string' && VERSION_RE.test(value) && value !== '.' && value !== '..' ? value : null;
}

function safeExe(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f]/.test(value)) return null;
  const normalized = value.replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || normalized.split('/').some((part) => !part || part === '..')) return null;
  return normalized;
}

function sanitizeInstalled(value, appId, root) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const version = safeVersion(value.version);
  if (!version || (value.id !== undefined && value.id !== appId)) return null;
  const dir = path.resolve(root, version);
  if (!dir.startsWith(`${path.resolve(root)}${path.sep}`)) return null;
  let manifest;
  try {
    manifest = normalizeManifest(value.manifest, { id: appId, version });
  } catch {
    return null;
  }
  const exe = safeExe(manifest.exe);
  if (!exe) return null;
  manifest = { ...manifest, id: appId, version, exe };
  if (!Number.isSafeInteger(manifest.restartExitCode) || manifest.restartExitCode < -1 || manifest.restartExitCode > 255) manifest.restartExitCode = 75;
  manifest.singleInstance = manifest.singleInstance !== false;
  return {
    id: appId,
    name: typeof value.name === 'string' && value.name.length <= 200 ? value.name : appId,
    version,
    sha256: typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.sha256) ? value.sha256 : null,
    installedAt: Number.isSafeInteger(value.installedAt) && value.installedAt >= 0 ? value.installedAt : 0,
    manifest,
    dir,
  };
}

class Installer {
  constructor({ paths, log = console }) {
    this.paths = paths;
    this.log = log;
  }

  async installed(appId) {
    const ap = this.paths.app(appId);
    const info = sanitizeInstalled(await readJson(ap.installed, null), appId, ap.root);
    if (!info || !fs.existsSync(info.dir) || !fs.existsSync(path.join(info.dir, ...info.manifest.exe.split('/')))) return null;
    return info;
  }

  async listInstalled() {
    let ids = [];
    try {
      ids = await fsp.readdir(this.paths.appsDir);
    } catch {
      return {};
    }
    const out = {};
    for (const id of ids) {
      try {
        const info = await this.installed(id);
        if (info) out[id] = info;
      } catch {
        /* 무시 */
      }
    }
    return out;
  }

  /**
   * app: 서버의 프로그램 정보 (id, name, exe, release{version, sha256, size})
   * onProgress({ phase: 'download'|'extract', done, total })
   */
  async install(api, app, { onProgress, signal, keep = [] } = {}) {
    const rel = app.release;
    if (!rel) throw new Error('아직 배포된 버전이 없어요.');
    const ap = this.paths.app(app.id);
    const version = String(rel.version);
    if (!/^[0-9A-Za-z._-]+$/.test(version)) throw new Error('버전 이름이 올바르지 않아요.');
    await fsp.mkdir(this.paths.downloadsDir, { recursive: true });
    const zipFile = path.join(this.paths.downloadsDir, `${app.id}-${version}.zip`);

    await api.download(`/api/apps/${encodeURIComponent(app.id)}/download?version=${encodeURIComponent(version)}`, zipFile, {
      expectSha256: rel.sha256,
      expectSize: rel.size,
      signal,
      onProgress: (done, total) => onProgress?.({ phase: 'download', done, total }),
    });

    const finalDir = path.join(ap.root, version);
    const partDir = `${finalDir}.partial`;
    await fsp.rm(partDir, { recursive: true, force: true });
    try {
      await extractZip(zipFile, partDir, {
        signal,
        onProgress: (done, total) => onProgress?.({ phase: 'extract', done, total }),
      });
      const manifest = readManifest(partDir, { id: app.id, version, exe: app.exe });
      if (!manifest.exe) throw new Error('실행 파일 이름을 알 수 없어요. (magoedu-app.json)');
      const exePath = path.join(partDir, ...manifest.exe.split('/'));
      if (!fs.existsSync(exePath)) throw new Error(`실행 파일(${manifest.exe})이 묶음 안에 없어요.`);
      if (process.platform !== 'win32') await fsp.chmod(exePath, 0o755); // zip 에는 실행 권한이 없음 (Windows 는 상관없음)
      await fsp.rm(finalDir, { recursive: true, force: true });
      await fsp.rename(partDir, finalDir);
      await writeJson(ap.installed, {
        id: app.id,
        name: app.name,
        version,
        sha256: rel.sha256,
        installedAt: Date.now(),
        manifest,
      });
    } catch (err) {
      await fsp.rm(partDir, { recursive: true, force: true });
      throw err;
    } finally {
      await fsp.rm(zipFile, { force: true });
    }
    await this.cleanup(app.id, keep);
    return this.installed(app.id);
  }

  /** 지금 버전이 아닌 폴더를 지운다. keep: 켜져 있는 버전처럼 남겨 둘 버전 */
  async cleanup(appId, keep = []) {
    const ap = this.paths.app(appId);
    const cur = sanitizeInstalled(await readJson(ap.installed, null), appId, ap.root);
    let names = [];
    try {
      names = await fsp.readdir(ap.root);
    } catch {
      return;
    }
    for (const n of names) {
      if (n === 'installed.json' || n === 'running.json' || (cur && n === cur.version) || keep.includes(n)) continue;
      const full = path.join(ap.root, n);
      try {
        if ((await fsp.stat(full)).isDirectory()) await fsp.rm(full, { recursive: true, force: true, maxRetries: 2 });
      } catch (err) {
        this.log.warn?.(`[설치] ${full} 을 지우지 못했어요 (나중에 다시)`, err.code || err.message);
      }
    }
  }

  async uninstall(appId) {
    const ap = this.paths.app(appId);
    await fsp.rm(ap.installed, { force: true });
    await fsp.rm(ap.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  }

  needsUpdate(installed, app) {
    return !!(installed && app.release && compareVersions(app.release.version, installed.version) > 0);
  }
}

module.exports = { Installer };
