'use strict';

// 프로그램 목록과 새 버전 찾기
//
// 각 프로그램은 GitHub Releases 에 올린 "통합 클라우드용 묶음 파일"(zip)로 배포한다. (개별 설치 파일은 없음)
//   source: { type: 'github', repo: 'owner/name', asset: '^Name-(\d+\.\d+\.\d+)-win-x64\.zip$', tagPrefix?: '...' }
//   source: { type: 'local' }  → <DATA_DIR>/packages/<앱 id>/*.zip 을 그대로 씀 (직접 운영·시험용)
// 안드로이드 프로그램(platform: 'android')은 같은 방식으로 APK 를 찾아 웹에서 내려받게만 한다 (통합 클라우드가 설치하지 않음).
// 웹 프로그램(platform: 'web', source: { type: 'web', url })은 주소만 있다 (누르면 열고, 통합 클라우드 계정으로 로그인 — routes/sso.js).
//
// 통합 클라우드 프로그램 자체의 업데이트(electron-updater)도 여기서 같이 찾는다.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { compareVersions, jsonParse } = require('./util');

const SHA_RE = /^[0-9a-f]{64}$/;
const DEFAULT_LOCAL_ASSET = '^[A-Za-z0-9_.-]+?-(\\d+\\.\\d+\\.\\d+)(?:-win-x64)?\\.zip$';
const LAUNCHER_SETUP_RE = /^MagoEduCloud-Setup-(\d+\.\d+\.\d+)\.exe$/;
const PLATFORMS = ['windows', 'android', 'web'];
const APK_TYPE = 'application/vnd.android.package-archive';

// 디스크 캐시는 깨졌거나 다른 모양이면 쓰지 않는다. 로컬 파일 경로는 저장하지 않는다.
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isUrl = (v) => typeof v === 'string' && /^https?:\/\/[^\s]+$/.test(v);
const isTime = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000;
const isAsset = (a) => isObject(a) && typeof a.name === 'string' && !!a.name &&
  Number.isSafeInteger(a.size) && a.size >= 0 && isUrl(a.url) && isUrl(a.apiUrl) && !('localFile' in a) &&
  (a.digest == null || typeof a.digest === 'string');
const isReleases = (list) => Array.isArray(list) && list.every((r) => isObject(r) &&
  ['draft', 'prerelease'].every((k) => r[k] === undefined || typeof r[k] === 'boolean') &&
  ['tag_name', 'body', 'html_url', 'published_at'].every((k) => r[k] == null || typeof r[k] === 'string') &&
  Array.isArray(r.assets) && r.assets.every((a) => isObject(a) && isAsset(Catalog._asset(a))));
const isRelease = (r) => r === null || (isObject(r) && isAsset({ ...r, name: r.fileName }) &&
  typeof r.version === 'string' && /^\d+\.\d+\.\d+$/.test(r.version) && typeof r.sha256 === 'string' && SHA_RE.test(r.sha256) &&
  typeof r.notes === 'string' && (r.publishedAt === null || isTime(r.publishedAt)));
const isLauncher = (l) => l === null || (isObject(l) && typeof l.version === 'string' &&
  typeof l.ymlText === 'string' && !!l.ymlText && l.setupName === `MagoEduCloud-Setup-${l.version}.exe` &&
  LAUNCHER_SETUP_RE.test(l.setupName) && typeof l.notes === 'string' &&
  (l.publishedAt === null || isTime(l.publishedAt)) && isObject(l.assets) &&
  Object.entries(l.assets).every(([name, a]) => isAsset(a) && a.name === name) &&
  Object.hasOwn(l.assets, l.setupName) && Object.hasOwn(l.assets, 'latest.yml'));

/** 내려받을 때 파일 이름 (한글 이름도 깨지지 않게) */
function contentDisposition(name) {
  const ascii = String(name).replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function rowToApp(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    sort: r.sort,
    enabled: !!r.enabled,
    source: jsonParse(r.source, { type: 'local' }),
    iconUrl: r.icon_url || '',
    exe: r.exe || '',
    color: r.color || '',
    coldStorage: { enabled: !!r.cold_enabled, days: r.cold_days },
    autoLaunchDefault: !!r.auto_launch_default,
    platform: r.platform || 'windows',
    url: r.platform === 'web' ? jsonParse(r.source, {}).url || null : null,
    hasSecret: !!r.client_secret_hash,
    release: jsonParse(r.release, null),
    releaseCheckedAt: r.release_checked_at || null,
    releaseError: r.release_error || null,
  };
}

function publicRelease(rel) {
  if (!rel) return null;
  return {
    version: rel.version,
    fileName: rel.fileName,
    size: rel.size,
    sha256: rel.sha256,
    notes: rel.notes || '',
    publishedAt: rel.publishedAt || null,
    releaseUrl: rel.releaseUrl || null,
  };
}

class Catalog {
  constructor({ db, config, log }) {
    this.db = db;
    this.config = config;
    this.log = log;
    this.packagesDir = path.join(config.dataDir, 'packages');
    this.iconsDir = path.join(config.dataDir, 'icons');
    this.launcher = null; // { version, yml, assets, setup, notes, publishedAt }
    this.launcherError = null;
    this._launcherCheckedAt = 0;
    this._launcherFresh = null;
    this._cacheFile = path.join(config.dataDir, 'github-cache.json');
    this._githubCache = { version: 1, githubApi: config.githubApi, launcher: null, apps: {}, responses: {}, limitedUntil: 0 };
    this._timer = null;
    this._running = null;
    fs.mkdirSync(this.packagesDir, { recursive: true });
    fs.mkdirSync(this.iconsDir, { recursive: true });
    this._loadGithubCache();
    try {
      this.launcher = this._localLauncher() || this.launcher;
    } catch (err) {
      this.log.warn('[통합 클라우드 업데이트] 로컬 파일을 읽지 못했어요', err.message);
    }
    if (this.launcher) this._launcherCheckedAt = Date.now(); // 시작 직후에는 저장된 버전을 바로 보냄
  }

  // ---------------- 처음 목록 ----------------
  seed(file) {
    if (this.db.get('SELECT COUNT(*) AS n FROM apps').n > 0) return;
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      this.log.warn('[프로그램 목록] 기본 목록을 읽지 못했어요', err.message);
    }
    list.forEach((a, i) => this.upsert({ ...a, sort: a.sort ?? i }));
  }

  upsert(a) {
    const now = Date.now();
    const cur = this.db.get('SELECT * FROM apps WHERE id = ?', a.id);
    const v = {
      name: a.name ?? cur?.name,
      description: a.description ?? cur?.description ?? '',
      sort: a.sort ?? cur?.sort ?? 0,
      enabled: a.enabled === undefined ? (cur ? cur.enabled : 1) : a.enabled ? 1 : 0,
      source: a.source ? JSON.stringify(a.source) : cur?.source || JSON.stringify({ type: 'local' }),
      icon_url: a.iconUrl ?? cur?.icon_url ?? null,
      exe: a.exe ?? cur?.exe ?? null,
      color: a.color ?? cur?.color ?? null,
      cold_enabled: a.coldStorage?.enabled === undefined ? (cur?.cold_enabled ?? 0) : a.coldStorage.enabled ? 1 : 0,
      cold_days: a.coldStorage?.days ?? cur?.cold_days ?? 30,
      auto_launch_default:
        a.autoLaunchDefault === undefined ? (cur?.auto_launch_default ?? 0) : a.autoLaunchDefault ? 1 : 0,
      platform: PLATFORMS.includes(a.platform) ? a.platform : cur?.platform || 'windows',
    };
    if (cur) {
      this.db.run(
        `UPDATE apps SET name = ?, description = ?, sort = ?, enabled = ?, source = ?, icon_url = ?, exe = ?, color = ?,
                         cold_enabled = ?, cold_days = ?, auto_launch_default = ?, platform = ?, updated_at = ? WHERE id = ?`,
        v.name, v.description, v.sort, v.enabled, v.source, v.icon_url, v.exe, v.color,
        v.cold_enabled, v.cold_days, v.auto_launch_default, v.platform, now, a.id,
      );
      if (v.source !== cur.source) {
        this.db.run('UPDATE apps SET release = NULL, release_checked_at = NULL, release_error = NULL WHERE id = ?', a.id);
      }
    } else {
      this.db.run(
        `INSERT INTO apps(id, name, description, sort, enabled, source, icon_url, exe, color, cold_enabled, cold_days,
                          auto_launch_default, platform, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id, v.name, v.description, v.sort, v.enabled, v.source, v.icon_url, v.exe, v.color, v.cold_enabled,
        v.cold_days, v.auto_launch_default, v.platform, now, now,
      );
    }
    this._restoreApp(a.id);
    return this.get(a.id);
  }

  get(id) {
    const r = this.db.get('SELECT * FROM apps WHERE id = ?', String(id));
    return r ? rowToApp(r) : null;
  }

  list({ includeDisabled = false } = {}) {
    const rows = this.db.all(`SELECT * FROM apps ${includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY sort, name`);
    return rows.map(rowToApp);
  }

  remove(id) {
    this.db.run('DELETE FROM apps WHERE id = ?', id);
  }

  // ---------------- GitHub ----------------
  _loadGithubCache() {
    try {
      const c = JSON.parse(fs.readFileSync(this._cacheFile, 'utf8'));
      if (!isObject(c) || c.version !== 1 || c.githubApi !== this.config.githubApi || !isTime(c.limitedUntil) ||
          !isObject(c.apps) || !isObject(c.responses) ||
          !(c.launcher === null || (isObject(c.launcher) && typeof c.launcher.repo === 'string' && isLauncher(c.launcher.release))) ||
          !Object.values(c.apps).every((a) => isObject(a) && typeof a.source === 'string' &&
            jsonParse(a.source, null)?.type === 'github' && isTime(a.checkedAt) && isRelease(a.release)) ||
          !Object.entries(c.responses).every(([url, r]) => isUrl(url) && isObject(r) &&
            (r.etag === null || (typeof r.etag === 'string' && /^[\x20-\x7e]+$/.test(r.etag))) &&
            (typeof r.body === 'string' || isReleases(r.body)))) return;
      this._githubCache = c;
      if (c.launcher?.repo === this.config.launcherRepo) this.launcher = c.launcher.release;
      for (const id of Object.keys(c.apps)) this._restoreApp(id);
    } catch {
      /* 처음 실행했거나 깨진 캐시: 정상 응답을 받으면 다시 저장 */
    }
  }

  _restoreApp(id) {
    const cached = Object.hasOwn(this._githubCache.apps, id) && this._githubCache.apps[id];
    const app = cached && this.get(id);
    if (!app || cached.source !== JSON.stringify(app.source) || cached.checkedAt < (app.releaseCheckedAt || 0)) return;
    this.db.run('UPDATE apps SET release = ?, release_checked_at = ? WHERE id = ?',
      cached.release ? JSON.stringify(cached.release) : null, cached.checkedAt, id);
  }

  _saveGithubCache() {
    const tmp = `${this._cacheFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this._githubCache), { mode: 0o600 });
      fs.renameSync(tmp, this._cacheFile); // 같은 폴더에서 교체: 중간에 꺼져도 이전 JSON 은 온전함
    } catch (err) {
      this.log.warn('[프로그램 목록] GitHub 캐시를 저장하지 못했어요', err.message);
      try { fs.unlinkSync(tmp); } catch { /* 임시 파일 없음 */ }
    }
  }

  _checkGithubLimit() {
    if (Date.now() < this._githubCache.limitedUntil) {
      throw Object.assign(new Error('GitHub 호출 한도가 초기화될 때까지 기다려요.'), { code: 'GITHUB_RATE_LIMIT' });
    }
  }

  _checkGithubResponse(res) {
    const retry = res.headers.get('retry-after');
    if ([403, 429].includes(res.status) && (res.headers.get('x-ratelimit-remaining') === '0' || retry !== null)) {
      const now = Date.now();
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const retryAt = retry === null ? 0 : /^\d+$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry);
      const until = Math.max(isTime(reset) ? reset : 0, isTime(retryAt) ? retryAt : 0);
      const alreadyLimited = this._githubCache.limitedUntil > now;
      this._githubCache.limitedUntil = Math.max(this._githubCache.limitedUntil, until > now ? until : now + 60000);
      if (!alreadyLimited) this.log.warn(`[프로그램 목록] GitHub 호출 한도: ${new Date(this._githubCache.limitedUntil).toISOString()} 까지 확인을 쉬어요.`);
      this._saveGithubCache();
      this._checkGithubLimit();
    }
    if (!res.ok) throw new Error(`GitHub 응답 ${res.status}`);
  }

  _headers(accept = 'application/vnd.github+json') {
    const h = { 'user-agent': 'MagoEduCloudServer', accept, 'x-github-api-version': '2022-11-28' };
    if (this.config.githubToken) h.authorization = `Bearer ${this.config.githubToken}`;
    return h;
  }

  async _githubRequest(url, max = 0) {
    this._checkGithubLimit();
    const entry = this._githubCache.responses[url];
    const cached = entry && (max ? typeof entry.body === 'string' && !!entry.body : isReleases(entry.body)) ? entry : null;
    const headers = this._headers(max ? 'application/octet-stream' : 'application/vnd.github+json');
    if (cached?.etag) headers['if-none-match'] = cached.etag;
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 304 && cached) return cached.body;
    this._checkGithubResponse(res);
    const body = max ? (await res.text()).slice(0, max) : await res.json();
    if (max ? !body : !isReleases(body)) throw new Error('GitHub 응답 형식이 올바르지 않아요.');
    this._githubCache.responses[url] = { etag: res.headers.get('etag'), body };
    this._saveGithubCache();
    return body;
  }

  async _githubReleases(repo) {
    return this._githubRequest(`${this.config.githubApi}/repos/${repo}/releases?per_page=40`);
  }

  async _assetText(asset, max = 1024 * 1024) {
    return this._githubRequest(this.config.githubToken ? asset.apiUrl : asset.url, max);
  }

  static _asset(a) {
    return { name: a.name, size: a.size, url: a.browser_download_url, apiUrl: a.url, digest: a.digest || null };
  }

  async _githubRelease(source) {
    const releases = await this._githubReleases(source.repo);
    const re = new RegExp(source.asset);
    let best = null;
    for (const rel of releases) {
      if (rel.draft || rel.prerelease) continue;
      if (source.tagPrefix && !String(rel.tag_name || '').startsWith(source.tagPrefix)) continue;
      const assets = (rel.assets || []).map(Catalog._asset);
      for (const a of assets) {
        const m = re.exec(a.name);
        if (!m || !m[1]) continue;
        if (best && compareVersions(m[1], best.version) <= 0) continue;
        best = {
          version: m[1],
          fileName: a.name,
          size: a.size,
          sha256: a.digest && a.digest.startsWith('sha256:') ? a.digest.slice(7).toLowerCase() : null,
          sidecar: assets.find((x) => x.name === `${a.name}.sha256`) || null,
          notes: rel.body || '',
          publishedAt: Date.parse(rel.published_at) || null,
          releaseUrl: rel.html_url,
          tag: rel.tag_name,
          url: a.url,
          apiUrl: a.apiUrl,
        };
      }
    }
    if (best && !best.sha256 && best.sidecar) {
      const m = /\b([0-9a-fA-F]{64})\b/.exec(await this._assetText(best.sidecar, 4096));
      if (m) best.sha256 = m[1].toLowerCase();
    }
    if (best) delete best.sidecar;
    if (best && !best.sha256) throw new Error(`${best.fileName} 의 SHA-256 값을 찾지 못했어요.`);
    return best;
  }

  // ---------------- 직접 올린 묶음 파일 ----------------
  async _sha256File(file) {
    const side = `${file}.sha256`;
    try {
      const [st, sst] = [fs.statSync(file), fs.statSync(side)];
      if (sst.mtimeMs >= st.mtimeMs) {
        const m = /\b([0-9a-f]{64})\b/.exec(fs.readFileSync(side, 'utf8'));
        if (m) return m[1];
      }
    } catch {
      /* 새로 계산 */
    }
    const h = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) h.update(chunk);
    const hex = h.digest('hex');
    try {
      fs.writeFileSync(side, `${hex}  ${path.basename(file)}\n`);
    } catch {
      /* 읽기 전용이어도 괜찮음 */
    }
    return hex;
  }

  async _localRelease(appId, source) {
    const dir = path.join(this.packagesDir, appId);
    fs.mkdirSync(dir, { recursive: true });
    const re = new RegExp(source.asset || DEFAULT_LOCAL_ASSET);
    let best = null;
    for (const name of fs.readdirSync(dir)) {
      const m = re.exec(name);
      if (!m || !m[1]) continue;
      if (best && compareVersions(m[1], best.version) <= 0) continue;
      best = { version: m[1], fileName: name };
    }
    if (!best) return null;
    const file = path.join(dir, best.fileName);
    const st = fs.statSync(file);
    let notes = '';
    for (const n of [`${best.fileName}.md`, 'notes.md']) {
      try {
        notes = fs.readFileSync(path.join(dir, n), 'utf8');
        break;
      } catch {
        /* 없음 */
      }
    }
    return {
      ...best,
      size: st.size,
      sha256: await this._sha256File(file),
      notes,
      publishedAt: Math.round(st.mtimeMs),
      localFile: file,
    };
  }

  // ---------------- 새로 고침 ----------------
  async refreshApp(id) {
    const app = this.get(id);
    if (!app) return null;
    if (app.source.type === 'web') return app; // 웹 프로그램은 찾을 버전이 없음
    let release = null;
    let error = null;
    try {
      release = app.source.type === 'github' ? await this._githubRelease(app.source) : await this._localRelease(app.id, app.source);
    } catch (err) {
      error = String(err.message || err);
      if (err.code !== 'GITHUB_RATE_LIMIT') this.log.warn(`[프로그램 목록] ${app.name}: ${error}`);
    }
    // 확인에 실패하면 예전에 찾은 버전은 그대로 둔다
    if (error) {
      this.db.run('UPDATE apps SET release_checked_at = ?, release_error = ? WHERE id = ?', Date.now(), error, id);
    } else {
      const checkedAt = Date.now();
      this.db.run(
        'UPDATE apps SET release = ?, release_checked_at = ?, release_error = NULL WHERE id = ?',
        release ? JSON.stringify(release) : null,
        checkedAt,
        id,
      );
      if (app.source.type === 'github') {
        this._githubCache.apps = { ...this._githubCache.apps, [id]: { source: JSON.stringify(app.source), release, checkedAt } };
        this._saveGithubCache();
      }
    }
    return this.get(id);
  }

  async refreshLauncher() {
    this._launcherCheckedAt = Date.now();
    try {
      const local = await this._localLauncher();
      if (local) this.launcher = local;
      else if (this.config.launcherRepo) {
        const release = await this._githubLauncher(this.config.launcherRepo);
        this.launcher = release;
        this._githubCache.launcher = { repo: this.config.launcherRepo, release };
        this._saveGithubCache();
      } else this.launcher = null;
      this.launcherError = null;
    } catch (err) {
      this.launcherError = String(err.message || err);
      if (err.code !== 'GITHUB_RATE_LIMIT') this.log.warn(`[통합 클라우드 업데이트] ${this.launcherError}`);
    }
    return this.launcher;
  }

  /** 통합 클라우드가 업데이트를 물을 때: 확인한 지 1분이 지났으면 다시 확인해서, 방금 나온 버전도 바로 알려 준다 */
  async freshLauncher(maxAgeMs = 60 * 1000) {
    if (Date.now() - this._launcherCheckedAt >= maxAgeMs) {
      this._launcherFresh ??= this.refreshLauncher().finally(() => (this._launcherFresh = null));
      await this._launcherFresh;
    }
    return this.launcher;
  }

  async _githubLauncher(repo) {
    const releases = await this._githubReleases(repo);
    let best = null;
    for (const rel of releases) {
      if (rel.draft || rel.prerelease) continue;
      const assets = (rel.assets || []).map(Catalog._asset);
      const setup = assets.find((a) => LAUNCHER_SETUP_RE.test(a.name));
      const yml = assets.find((a) => a.name === 'latest.yml');
      if (!setup || !yml) continue;
      const version = LAUNCHER_SETUP_RE.exec(setup.name)[1];
      if (best && compareVersions(version, best.version) <= 0) continue;
      best = { version, setup, yml, assets, notes: rel.body || '', publishedAt: Date.parse(rel.published_at) || null };
    }
    if (!best) return null;
    const ymlText = await this._assetText(best.yml, 64 * 1024);
    return {
      version: best.version,
      ymlText,
      setupName: best.setup.name,
      assets: Object.fromEntries(best.assets.map((a) => [a.name, a])),
      notes: best.notes,
      publishedAt: best.publishedAt,
    };
  }

  _localLauncher() {
    const dir = path.join(this.packagesDir, 'launcher');
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return null;
    }
    if (!names.includes('latest.yml')) return null;
    const setups = names.filter((n) => LAUNCHER_SETUP_RE.test(n));
    if (!setups.length) return null;
    setups.sort((a, b) => compareVersions(LAUNCHER_SETUP_RE.exec(b)[1], LAUNCHER_SETUP_RE.exec(a)[1]));
    const assets = {};
    for (const n of names) {
      const f = path.join(dir, n);
      if (fs.statSync(f).isFile()) assets[n] = { name: n, size: fs.statSync(f).size, localFile: f };
    }
    return {
      version: LAUNCHER_SETUP_RE.exec(setups[0])[1],
      ymlText: fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8'),
      setupName: setups[0],
      assets,
      notes: '',
      publishedAt: Math.round(fs.statSync(path.join(dir, setups[0])).mtimeMs),
    };
  }

  async refreshAll() {
    if (this._running) return this._running;
    this._running = (async () => {
      for (const a of this.list({ includeDisabled: true })) await this.refreshApp(a.id);
      await this.refreshLauncher();
    })().finally(() => {
      this._running = null;
    });
    return this._running;
  }

  start() {
    const every = Math.max(1, this.config.catalogRefreshMinutes) * 60 * 1000;
    const kick = () => this.refreshAll().catch((err) => this.log.warn('[프로그램 목록] 새로 고침 실패', err.message));
    const first = setTimeout(kick, 1500);
    first.unref?.();
    this._timer = setInterval(kick, every);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // ---------------- 파일 보내기 ----------------
  /** 묶음 파일을 보낸다: 직접 올린 파일은 그대로, GitHub 파일은 그쪽 주소로 넘기거나(공개 저장소) 대신 받아서 보낸다(토큰 사용). */
  async sendAsset(res, asset, method = 'GET') {
    const name = asset.name || (asset.localFile ? path.basename(asset.localFile) : '');
    // 안드로이드는 APK 종류를 알려 줘야 휴대폰이 설치 파일로 알아봄
    const type = /\.apk$/i.test(name) ? APK_TYPE : 'application/octet-stream';
    if (asset.localFile) {
      const st = fs.statSync(asset.localFile);
      res.writeHead(200, {
        'content-type': type,
        'content-length': st.size,
        'content-disposition': contentDisposition(name),
        'cache-control': 'no-store',
      });
      if (method === 'HEAD') return res.end();
      fs.createReadStream(asset.localFile).pipe(res);
      return undefined;
    }
    if (!this.config.githubToken) {
      res.writeHead(302, { location: asset.url, 'cache-control': 'no-store' });
      return res.end();
    }
    // 토큰으로 파일을 대신 받을 때도 같은 API 한도를 따른다.
    let up;
    try {
      this._checkGithubLimit();
      up = await fetch(asset.apiUrl, { headers: this._headers('application/octet-stream') });
      this._checkGithubResponse(up);
    } catch (err) {
      if (err.code === 'GITHUB_RATE_LIMIT') {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8',
          'retry-after': String(Math.ceil((this._githubCache.limitedUntil - Date.now()) / 1000)) });
        return res.end('GitHub 호출 한도가 초기화될 때까지 기다려 주세요.');
      }
      if (!up) throw err;
    }
    if (!up.ok || !up.body) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('파일을 가져오지 못했어요.');
    }
    const headers = { 'content-type': type, 'cache-control': 'no-store' };
    if (name) headers['content-disposition'] = contentDisposition(name);
    const len = up.headers.get('content-length');
    if (len) headers['content-length'] = len;
    res.writeHead(200, headers);
    if (method === 'HEAD') return res.end();
    Readable.fromWeb(up.body).pipe(res);
    return undefined;
  }

  releaseAsset(app) {
    const r = app.release;
    if (!r) return null;
    return r.localFile ? { localFile: r.localFile, name: r.fileName } : { url: r.url, apiUrl: r.apiUrl, name: r.fileName };
  }

  // ---------------- 아이콘 ----------------
  async icon(app) {
    const cached = path.join(this.iconsDir, app.id);
    // 운영자가 직접 넣은 그림이 있으면 그것을 쓴다: icons/<id>.png
    for (const ext of ['.png', '.ico', '.svg']) {
      const f = path.join(this.iconsDir, `${app.id}${ext}`);
      if (fs.existsSync(f)) return { file: f };
    }
    try {
      const st = fs.statSync(cached);
      if (Date.now() - st.mtimeMs < 24 * 60 * 60 * 1000 && st.size > 0) return { file: cached };
    } catch {
      /* 받아 오기 */
    }
    if (!/^https:\/\//.test(app.iconUrl || '')) return fs.existsSync(cached) ? { file: cached } : null;
    try {
      const res = await fetch(app.iconUrl, { headers: { 'user-agent': 'MagoEduCloudServer' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(String(res.status));
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 2 * 1024 * 1024) throw new Error('too large');
      await fsp.writeFile(cached, buf);
      return { file: cached };
    } catch {
      return fs.existsSync(cached) ? { file: cached } : null;
    }
  }
}

function sniffImageType(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01) return 'image/x-icon';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (String(buf.slice(0, 256)).includes('<svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

module.exports = { Catalog, publicRelease, sniffImageType, SHA_RE, LAUNCHER_SETUP_RE, PLATFORMS, APK_TYPE };
