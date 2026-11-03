'use strict';

// 설정(config.json)과 로그인 정보(session.dat)
//   로그인 정보는 Windows 계정으로 암호화해서(safeStorage = DPAPI) 저장한다.

const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { readJsonSync, writeJsonSync } = require('../core/fsutil');

const DEFAULT_CONFIG = {
  serverUrl: '',
  deviceId: '',
  deviceName: '',
  autoStart: true, // 컴퓨터를 켜면 통합 클라우드도 켜기 (트레이)
  closeToTray: true, // 창을 닫아도 트레이에서 계속 (동기화·자동 실행)
  autoUpdateApps: true, // 프로그램 새 버전을 알아서 받기
  lastUsername: '',
  shortcuts: {}, // 프로그램 ID → { desktop: 바탕 화면에도 둘지, name: 만든 바로 가기 파일 이름 }
};

const SAFE_APP_ID = /^[a-z][a-z0-9-]{1,31}$/;
const SAFE_FILE_NAME = /^(?!\.\.?$)[^\\/:*?"<>|\u0000-\u001f]{1,240}\.lnk$/i;
const POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function safeKey(v) {
  return typeof v === 'string' && !POLLUTION_KEYS.has(v);
}

function safeText(v, max = 200) {
  return typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
}

function safeUserId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v) ? v : null;
}

function validServerUrl(v) {
  if (typeof v !== 'string' || !/^https?:\/\//i.test(v.trim())) return null;
  try {
    const u = new URL(v.trim());
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

function sanitizeShortcuts(value, fallback = {}) {
  const source = isObject(value) ? value : isObject(fallback) ? fallback : {};
  const out = {};
  for (const [id, rec] of Object.entries(source)) {
    if (!safeKey(id) || !SAFE_APP_ID.test(id) || !isObject(rec)) continue;
    const item = { desktop: typeof rec.desktop === 'boolean' ? rec.desktop : true };
    if (SAFE_FILE_NAME.test(rec.name || '')) item.name = rec.name;
    out[id] = item;
  }
  return out;
}

function sanitizeConfig(value, fallback = DEFAULT_CONFIG) {
  const source = isObject(value) ? value : {};
  const base = isObject(fallback) ? fallback : DEFAULT_CONFIG;
  return {
    serverUrl: validServerUrl(source.serverUrl) || validServerUrl(base.serverUrl) || '',
    deviceId: safeText(source.deviceId, 128) ?? safeText(base.deviceId, 128) ?? '',
    deviceName: safeText(source.deviceName, 100) ?? safeText(base.deviceName, 100) ?? '',
    autoStart: typeof source.autoStart === 'boolean' ? source.autoStart : typeof base.autoStart === 'boolean' ? base.autoStart : true,
    closeToTray: typeof source.closeToTray === 'boolean' ? source.closeToTray : typeof base.closeToTray === 'boolean' ? base.closeToTray : true,
    autoUpdateApps: typeof source.autoUpdateApps === 'boolean' ? source.autoUpdateApps : typeof base.autoUpdateApps === 'boolean' ? base.autoUpdateApps : true,
    lastUsername: safeText(source.lastUsername, 100) ?? safeText(base.lastUsername, 100) ?? '',
    shortcuts: sanitizeShortcuts(source.shortcuts, sanitizeShortcuts(base.shortcuts)),
  };
}

function sanitizeAccountSettings(value) {
  const source = isObject(value) ? value : {};
  const autoLaunch = {};
  for (const [id, on] of Object.entries(isObject(source.autoLaunch) ? source.autoLaunch : {})) {
    if (safeKey(id) && SAFE_APP_ID.test(id) && typeof on === 'boolean') autoLaunch[id] = on;
  }
  const legacyDismissed = {};
  for (const [id, list] of Object.entries(isObject(source.legacyDismissed) ? source.legacyDismissed : {})) {
    if (!safeKey(id) || !SAFE_APP_ID.test(id) || !Array.isArray(list)) continue;
    legacyDismissed[id] = list.filter((x) => safeText(x, 80)).slice(0, 100);
  }
  return {
    autoLaunch,
    noticesSeen: Number.isSafeInteger(source.noticesSeen) && source.noticesSeen >= 0 ? source.noticesSeen : 0,
    legacyDismissed,
  };
}

function sanitizeSession(value) {
  const serverUrl = validServerUrl(value?.serverUrl);
  if (!isObject(value) || !safeText(value.token, 4096) || !serverUrl) return null;
  const u = value.user;
  if (!isObject(u) || !safeUserId(u.id) || !safeText(u.username, 100) || !safeText(u.name, 100) || !safeText(u.role, 40)) return null;
  const user = { ...u, id: u.id, username: u.username, name: u.name, role: u.role };
  delete user.academy;
  for (const k of POLLUTION_KEYS) delete user[k];
  const academyId = Number.isSafeInteger(u.academy?.id) && u.academy.id > 0 ? u.academy.id : safeUserId(u.academy?.id);
  if (isObject(u.academy) && academyId && safeText(u.academy.name, 100)) {
    user.academy = { id: academyId, name: u.academy.name };
  }
  const out = { token: value.token, serverUrl, dataKey: safeText(value.dataKey, 4096) || null, user };
  return out;
}

class Store {
  constructor({ paths, safeStorage = null, defaults = {} }) {
    this.paths = paths;
    this.safe = safeStorage;
    this.defaults = defaults; // 설치 파일에 들어 있는 기본값 (기본 서버 주소 등)
    this.defaults = sanitizeConfig(defaults);
    this.config = sanitizeConfig(readJsonSync(paths.configFile, {}), this.defaults);
    if (!this.config.deviceId) this.config.deviceId = crypto.randomUUID();
    if (!this.config.deviceName) this.config.deviceName = os.hostname();
    this.saveConfig();
  }

  setConfig(patch) {
    this.config = sanitizeConfig({ ...this.config, ...(isObject(patch) ? patch : {}) }, this.defaults);
    this.saveConfig();
    return this.config;
  }

  saveConfig() {
    writeJsonSync(this.paths.configFile, this.config);
  }

  loadSession() {
    let buf;
    try {
      buf = fs.readFileSync(this.paths.sessionFile);
    } catch {
      return null;
    }
    try {
      const text = this._canEncrypt() && buf[0] !== 0x7b ? this.safe.decryptString(buf) : buf.toString('utf8');
      return sanitizeSession(JSON.parse(text));
    } catch {
      return null;
    }
  }

  saveSession(session) {
    const text = JSON.stringify(session);
    const data = this._canEncrypt() ? this.safe.encryptString(text) : Buffer.from(text, 'utf8');
    fs.mkdirSync(require('node:path').dirname(this.paths.sessionFile), { recursive: true });
    fs.writeFileSync(this.paths.sessionFile, data, { mode: 0o600 });
  }

  clearSession() {
    fs.rmSync(this.paths.sessionFile, { force: true });
  }

  _canEncrypt() {
    try {
      return !!this.safe && this.safe.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  accountSettings(uid) {
    const file = this.paths.account(uid).settings;
    return sanitizeAccountSettings(readJsonSync(file, {}));
  }

  setAccountSettings(uid, patch) {
    const next = sanitizeAccountSettings({ ...this.accountSettings(uid), ...(isObject(patch) ? patch : {}) });
    writeJsonSync(this.paths.account(uid).settings, next);
    return next;
  }
}

module.exports = { Store, DEFAULT_CONFIG, sanitizeConfig, sanitizeAccountSettings, sanitizeSession, validServerUrl };
