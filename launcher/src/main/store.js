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
};

class Store {
  constructor({ paths, safeStorage = null, defaults = {} }) {
    this.paths = paths;
    this.safe = safeStorage;
    this.config = { ...DEFAULT_CONFIG, ...defaults, ...readJsonSync(paths.configFile, {}) };
    if (!this.config.deviceId) this.config.deviceId = crypto.randomUUID();
    if (!this.config.deviceName) this.config.deviceName = os.hostname();
    this.saveConfig();
  }

  setConfig(patch) {
    this.config = { ...this.config, ...patch };
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
      const s = JSON.parse(text);
      return s && s.token ? s : null;
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
    return { autoLaunch: {}, noticesSeen: 0, legacyDismissed: {}, ...readJsonSync(file, {}) };
  }

  setAccountSettings(uid, patch) {
    const next = { ...this.accountSettings(uid), ...patch };
    writeJsonSync(this.paths.account(uid).settings, next);
    return next;
  }
}

module.exports = { Store, DEFAULT_CONFIG };
