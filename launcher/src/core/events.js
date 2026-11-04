'use strict';

// 서버 실시간 알림(/api/sync/events) 받기
//   - 다른 기기에서 파일이 바뀌면 'change' { appId, seq, deviceId }, 연결(다시 연결)되면 'hello'
//   - 학생 명단·AI·학원 이름/계약 과목이 바뀌면 'academy' { kind: 'students' | 'ai' | 'academy' }
//   - 끊기면 1초에서 시작해 두 배씩, 많아야 30초 간격으로 다시 붙는다 (연결됐다가 끊기면 다시 1초부터)
//   - 서버는 25초마다 ping 을 보내니, 70초 동안 아무것도 오지 않으면 끊긴 것으로 보고 다시 붙는다
//   - 로그인이 끝났으면(401) 멈춘다 (ApiClient.onAuthLost 가 로그아웃 처리)

const { EventEmitter } = require('node:events');
const { ApiError } = require('./api');

const OLD_SERVER_WAIT = 10 * 60 * 1000; // 실시간 알림이 없는 예전 서버(404)는 가끔만 다시 시도

class EventStream extends EventEmitter {
  constructor({ api, path = '/api/sync/events', minDelay = 1000, maxDelay = 30 * 1000, idleMs = 70 * 1000, log = console }) {
    super();
    this.api = api;
    this.path = path;
    this.minDelay = minDelay;
    this.maxDelay = maxDelay;
    this.idleMs = idleMs;
    this.log = log;
    this.running = false;
    this.connected = false;
    this._abort = null;
    this._sleep = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._loop().catch((err) => this.log.warn?.('[실시간]', err.message));
  }

  stop() {
    this.running = false;
    this.connected = false;
    this._abort?.abort();
    if (this._sleep) {
      clearTimeout(this._sleep.timer);
      this._sleep.resolve();
    }
  }

  async _loop() {
    let delay = this.minDelay;
    while (this.running) {
      let wait = null;
      let hello = false;
      try {
        hello = await this._connect();
      } catch (err) {
        if (!this.running) break;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          this.running = false;
          this.emit('stopped', err);
          break;
        }
        if (err instanceof ApiError && err.status === 404) wait = OLD_SERVER_WAIT;
      }
      this.connected = false;
      if (!this.running) break;
      if (hello) delay = this.minDelay;
      this.emit('disconnected');
      await this._wait(wait ?? delay);
      delay = Math.min(delay * 2, this.maxDelay);
    }
  }

  _wait(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._sleep = null;
        resolve();
      }, ms);
      timer.unref?.();
      this._sleep = { timer, resolve };
    });
  }

  /** 한 번 연결해서 끊길 때까지 읽는다. hello 를 받았으면 true. HTTP 오류(4xx·5xx)는 던진다. */
  async _connect() {
    const ctrl = new AbortController();
    this._abort = ctrl;
    let idle = null;
    const kick = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ctrl.abort(), this.idleMs);
      idle.unref?.();
    };
    let hello = false;
    try {
      kick();
      const res = await this.api._send('GET', this.path, { timeout: 0, signal: ctrl.signal, headers: { accept: 'text/event-stream' } });
      if (!res.ok) throw await this.api._error(res);
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        kick();
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const msg = parseBlock(buf.slice(0, i));
          buf = buf.slice(i + 2);
          if (!msg) continue;
          if (msg.event === 'hello') {
            hello = true;
            this.connected = true;
            this.emit('hello', msg.data);
          } else if (msg.event === 'change' && msg.data && typeof msg.data === 'object') {
            this.emit('change', msg.data);
          } else if (msg.event === 'academy' && msg.data && typeof msg.data === 'object') {
            this.emit('academy', msg.data);
          }
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.status) throw err;
      // 끊김·시간 초과·멈춤 → 다시 연결
    } finally {
      clearTimeout(idle);
      if (this._abort === ctrl) this._abort = null;
    }
    return hello;
  }
}

/** "event: x\ndata: {...}" 한 덩어리 → { event, data }. 주석(": ping")만 있으면 null */
function parseBlock(block) {
  let event = 'message';
  const data = [];
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    const c = line.indexOf(':');
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? '' : line.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  const text = data.join('\n');
  try {
    return { event, data: JSON.parse(text) };
  } catch {
    return { event, data: text };
  }
}

module.exports = { EventStream, parseBlock };
