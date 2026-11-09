// Authorization-bearing SSE, shared renderer lifetime; never stores message contents.
export class InquiryEvents {
  // 브라우저 fetch 는 다른 객체의 메서드로 부르면 Illegal invocation 이라 감싸서 부른다
  constructor({ token, onEvent, fetchImpl = (...args) => fetch(...args), minDelay = 1000, maxDelay = 30000, idleMs = 70000 }) {
    Object.assign(this, { token, onEvent, fetchImpl, minDelay, maxDelay, idleMs });
    this.delay = minDelay;
  }
  start() { this.stopped = false; void this.connect(); }
  stop() { this.stopped = true; clearTimeout(this.timer); clearTimeout(this.idle); this.ctrl?.abort(); }
  async connect() {
    if (this.stopped) return;
    const ctrl = this.ctrl = new AbortController();
    const touch = () => { clearTimeout(this.idle); this.idle = setTimeout(() => ctrl.abort(), this.idleMs); };
    let reader;
    try {
      touch();
      const res = await this.fetchImpl('/api/sync/events?only=inquiry', { headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' }, signal: ctrl.signal });
      if ([401, 403].includes(res.status)) { this.stop(); return; }
      if (!res.ok) throw new Error('stream');
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!this.stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        touch();
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const event = /^event: ?(.+)$/m.exec(frame)?.[1];
          if (event === 'hello') { this.delay = this.minDelay; this.onEvent(null); }
          if (event === 'inquiry') {
            try { this.onEvent(JSON.parse(/^data: ?(.+)$/m.exec(frame)?.[1])); } catch { /* invalid frame */ }
          }
        }
        if (buffer.length > 262144) throw new Error('frame');
      }
    } catch { /* reconnect without leaking credentials */ }
    finally { clearTimeout(this.idle); await reader?.cancel().catch(() => {}); }
    if (!this.stopped) {
      this.timer = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.maxDelay, this.delay * 2);
    }
  }
}
