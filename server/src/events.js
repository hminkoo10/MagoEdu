'use strict';

// 실시간 알림 (Server-Sent Events)
//   GET /api/sync/events?apps=a,b  →  event: hello / event: change {appId, seq, deviceId} / ": ping" (25초마다)
//
// 계정의 동기화 파일이 바뀌면(올리기·지우기·서버 정리) 그 계정의 연결에 바로 알려 준다.
// 받는 쪽은 GET /api/sync/<앱>?since=<마지막 seq> 로 바뀐 것만 가져간다.
// 서버 프로세스 하나 안에서만 주고받는다 (서버를 여러 대로 늘리면 따로 이어 줘야 함).

const { HttpError } = require('./util');

const PING_MS = 25 * 1000; // Cloudflare 는 100초 동안 아무것도 오지 않으면 끊는다
const RECHECK_MS = 60 * 1000; // 로그아웃·사용 중지된 세션은 이 간격 안에 끊는다
const PER_SESSION = 5; // 세션 하나가 동시에 열 수 있는 연결 (넘으면 가장 오래된 것을 끊음)
const MAX_TOTAL = 2000; // 서버 전체
const MAX_BACKLOG = 256 * 1024; // 받아 가지 못하고 쌓인 양이 이만큼 넘으면 끊는다

const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

class EventHub {
  constructor({ svc, log, pingMs, recheckMs, perSession, maxTotal } = {}) {
    this.svc = svc;
    this.log = log;
    this.pingMs = pingMs || PING_MS;
    this.recheckMs = recheckMs || RECHECK_MS;
    this.perSession = perSession || PER_SESSION;
    this.maxTotal = maxTotal || MAX_TOTAL;
    this.streams = new Set(); // 들어온 순서대로
    this.timers = null;
    this.closed = false;
  }

  get size() {
    return this.streams.size;
  }

  /** 연결을 연다. apps: 받을 프로그램 ID Set (null = 쓸 수 있는 모든 프로그램) */
  open(ctx, { user, session, apps = null }) {
    if (this.closed) throw new HttpError(503, '서버를 다시 켜는 중이에요. 잠시 뒤 다시 연결해요.', 'shutting_down');
    const mine = [...this.streams].filter((s) => s.sessionId === session.id);
    while (mine.length >= this.perSession) this._end(mine.shift());
    if (this.streams.size >= this.maxTotal) throw new HttpError(503, '지금은 연결이 너무 많아요. 잠시 뒤 다시 해 주세요.', 'too_many_streams');

    const { req, res } = ctx;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no', // nginx 가 모아 두지 않고 바로 넘기게
    });
    if (req.method === 'HEAD') {
      res.end();
      return null;
    }
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 30 * 1000);

    const s = {
      res,
      userId: user.id,
      user,
      sessionId: session.id,
      apps,
      authorization: String(req.headers.authorization || ''),
      ip: ctx.ip,
      closed: false,
    };
    this.streams.add(s);
    res.on('close', () => this._remove(s));
    this._write(s, `event: hello\ndata: ${JSON.stringify({ time: isoNow() })}\n\n`);
    this._startTimers();
    return s;
  }

  /** files 가 바뀐 뒤(트랜잭션이 끝난 뒤)에 부른다. deviceId: 바꾼 기기 (서버 작업이면 null) */
  publish(userId, appId, seq, deviceId = null) {
    if (!this.streams.size) return;
    const msg = `event: change\ndata: ${JSON.stringify({ appId, seq, deviceId: deviceId || null })}\n\n`;
    for (const s of this.streams) {
      if (s.userId !== userId) continue;
      if (s.apps && !s.apps.has(appId)) continue;
      if (!this.svc.canUseApp(s.user, appId)) continue;
      this._write(s, msg);
    }
  }

  _write(s, text) {
    if (s.closed) return;
    try {
      s.res.write(text);
      if (s.res.writableLength > MAX_BACKLOG) this._end(s, { destroy: true });
    } catch {
      this._end(s, { destroy: true });
    }
  }

  _remove(s) {
    if (s.closed) return;
    s.closed = true;
    this.streams.delete(s);
    if (!this.streams.size) this._stopTimers();
  }

  _end(s, { destroy = false } = {}) {
    this._remove(s);
    try {
      if (destroy) s.res.destroy();
      else s.res.end();
    } catch {
      /* 이미 끊김 */
    }
  }

  /** 세션이 아직 살아 있는지 다시 본다 (로그아웃·비밀번호 초기화·사용 중지·계정 삭제) */
  recheck() {
    for (const s of [...this.streams]) {
      try {
        const { user } = this.svc.authenticate({ req: { headers: { authorization: s.authorization } }, ip: s.ip });
        s.user = user; // 바뀐 프로그램 권한도 반영
      } catch {
        this._end(s);
      }
    }
  }

  ping() {
    for (const s of [...this.streams]) this._write(s, ': ping\n\n');
  }

  _startTimers() {
    if (this.timers) return;
    const ping = setInterval(() => this.ping(), this.pingMs);
    const recheck = setInterval(() => this.recheck(), this.recheckMs);
    ping.unref?.();
    recheck.unref?.();
    this.timers = [ping, recheck];
  }

  _stopTimers() {
    for (const t of this.timers || []) clearInterval(t);
    this.timers = null;
  }

  /** 모든 연결을 끊는다 (받는 쪽은 1초 뒤부터 다시 붙음) */
  endAll() {
    for (const s of [...this.streams]) this._end(s);
    this._stopTimers();
  }

  /** 서버를 끌 때: 새 연결도 받지 않음 */
  close() {
    this.closed = true;
    this.endAll();
  }
}

module.exports = { EventHub, PING_MS, RECHECK_MS, PER_SESSION, MAX_TOTAL };
