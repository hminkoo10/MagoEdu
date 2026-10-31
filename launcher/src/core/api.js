'use strict';

// 서버와 이야기하는 부분

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }

  get offline() {
    return this.status === 0 && (this.code === 'offline' || this.code === 'no_server');
  }
}

class Cancelled extends Error {
  constructor() {
    super('취소했어요.');
    this.cancelled = true;
  }
}

function normalizeServerUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

class ApiClient {
  constructor({ serverUrl, token = null, device = null, fetchImpl = globalThis.fetch, timeoutMs = 20000 }) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.token = token;
    this.device = device;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.onAuthLost = null; // 로그인이 끝났을 때 (401)
  }

  url(p) {
    return `${this.serverUrl}${p}`;
  }

  async _send(method, p, { json, body, headers = {}, timeout = this.timeoutMs, auth = true, signal } = {}) {
    if (!this.serverUrl) throw new ApiError(0, 'no_server', '서버 주소를 먼저 정해 주세요.');
    const h = { ...headers };
    if (auth && this.token) h.authorization = `Bearer ${this.token}`;
    let payload = body;
    if (json !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    const signals = [];
    if (timeout) signals.push(AbortSignal.timeout(timeout));
    if (signal) signals.push(signal);
    let res;
    try {
      res = await this.fetch(this.url(p), {
        method,
        headers: h,
        body: payload,
        signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
        ...(payload && typeof payload.pipe === 'function' ? { duplex: 'half' } : {}),
        ...(payload instanceof ReadableStream ? { duplex: 'half' } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw new Cancelled();
      throw new ApiError(0, 'offline', '서버에 연결하지 못했어요. 인터넷 연결과 서버 주소를 확인해 주세요.', { cause: String(err?.cause?.code || err?.message || err) });
    }
    return res;
  }

  async _error(res) {
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* 본문 없음 */
    }
    const e = data?.error || {};
    const err = new ApiError(res.status, e.code || `http_${res.status}`, e.message || `서버 응답 오류 (${res.status})`, e);
    if (res.status === 401 && this.token && ['session_invalid', 'account_suspended', 'auth_required'].includes(err.code)) {
      this.onAuthLost?.(err);
    }
    return err;
  }

  async request(method, p, opts = {}) {
    const res = await this._send(method, p, opts);
    if (!res.ok) throw await this._error(res);
    if (res.status === 204) return null;
    const type = res.headers.get('content-type') || '';
    return type.includes('json') ? res.json() : res.text();
  }

  get(p, opts) {
    return this.request('GET', p, opts);
  }
  post(p, json, opts = {}) {
    return this.request('POST', p, { ...opts, json: json ?? {} });
  }
  patch(p, json, opts = {}) {
    return this.request('PATCH', p, { ...opts, json: json ?? {} });
  }
  del(p, opts) {
    return this.request('DELETE', p, opts);
  }

  // ---------------- 공개 ----------------
  meta() {
    return this.get('/api/meta', { auth: false, timeout: 8000 });
  }

  // ---------------- 로그인 ----------------
  async login(username, password) {
    const r = await this.post('/api/auth/login', { username, password, device: this.device }, { auth: false });
    this.token = r.token;
    return r;
  }

  checkCode(code) {
    return this.get(`/api/auth/codes/${encodeURIComponent(code)}`, { auth: false });
  }

  async signup(fields) {
    const r = await this.post('/api/auth/signup', { ...fields, device: this.device }, { auth: false });
    this.token = r.token;
    return r;
  }

  async logout() {
    try {
      await this.post('/api/auth/logout', {}, { timeout: 5000 });
    } finally {
      this.token = null;
    }
  }

  // ---------------- 파일 받기 ----------------
  /**
   * 파일을 받아 dest 에 저장하면서 SHA-256 을 확인한다.
   * onProgress(받은 바이트, 전체 바이트)
   */
  async download(p, dest, { expectSha256, expectSize, onProgress, signal, timeout = 0 } = {}) {
    const res = await this._send('GET', p, { timeout, signal });
    if (!res.ok) throw await this._error(res);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    const total = Number(res.headers.get('content-length')) || expectSize || 0;
    const hash = crypto.createHash('sha256');
    let done = 0;
    const out = fs.createWriteStream(part);
    let lastTick = 0;
    try {
      for await (const chunk of Readable.fromWeb(res.body)) {
        if (signal?.aborted) throw new Cancelled();
        hash.update(chunk);
        done += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        const now = Date.now();
        if (onProgress && now - lastTick > 100) {
          lastTick = now;
          onProgress(done, total);
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    } catch (err) {
      out.destroy();
      await fsp.rm(part, { force: true });
      if (err instanceof Cancelled || signal?.aborted) throw new Cancelled();
      throw new ApiError(0, 'offline', '받는 중에 연결이 끊겼어요. 다시 해 주세요.');
    }
    const sha = hash.digest('hex');
    if (expectSha256 && sha !== expectSha256) {
      await fsp.rm(part, { force: true });
      throw new ApiError(0, 'checksum', '받은 파일이 올바르지 않아요. 다시 받아 주세요.');
    }
    await fsp.rename(part, dest);
    onProgress?.(done, total || done);
    return { sha256: sha, size: done, rev: Number(res.headers.get('x-rev')) || null };
  }

  /** 파일을 올린다 (스트림) */
  async upload(p, file, { sha256, headers = {}, signal } = {}) {
    const st = await fsp.stat(file);
    const body = Readable.toWeb(fs.createReadStream(file));
    const res = await this._send('PUT', p, {
      body,
      headers: { 'content-type': 'application/octet-stream', 'x-content-size': String(st.size), 'x-sha256': sha256, ...headers },
      timeout: 0,
      signal,
    });
    if (!res.ok) throw await this._error(res);
    return res.json();
  }
}

module.exports = { ApiClient, ApiError, Cancelled, normalizeServerUrl };
