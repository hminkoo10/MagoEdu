'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { notifyInquiry } = require('../src/main/inquiry-notifications');
test('inquiry notifications: admin-only, remote messages, foreground suppression and click navigation', async () => {
  const shown = [];
  class Notification {
    constructor(options) { this.options = options; shown.push(this); }
    on(event, fn) { this[event] = fn; }
    show() { this.visible = true; }
  }
  const cloud = { user: { role: 'teacher' }, api: { get: async () => ({ inquiries: [{ id: 3, role: 'student', academyName: '시험학원' }] }) } };
  let target;
  const args = { cloud, Notification, event: { id: 3, kind: 'created', fromAdmin: false }, window: { isFocused: () => false }, navigate: id => { target = id; } };
  await notifyInquiry(args); assert.equal(shown.length, 0);
  cloud.user = { role: 'admin' }; await notifyInquiry({ ...args, event: { ...args.event, fromAdmin: true } }); assert.equal(shown.length, 0);
  cloud.viewingInquiry = 3;
  await notifyInquiry({ ...args, window: { isFocused: () => true } }); assert.equal(shown.length, 0);
  await notifyInquiry(args); assert.equal(shown.length, 1); assert.equal(shown[0].options.title, '새 문의'); assert.equal(shown[0].options.body, '#3 · 학생 · 시험학원');
  shown[0].click(); assert.equal(target, 3);
  await notifyInquiry({ ...args, event: { ...args.event, kind: 'message' } }); assert.equal(shown[1].options.title, '새 답글');
});
async function streamClass() {
  const code = fs.readFileSync(path.join(__dirname, '../src/renderer/js/inquiry-events.js'), 'utf8');
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).InquiryEvents;
}
test('web inquiry SSE: bearer header, chunked parsing, reconnect and 401 stop', async () => {
  const InquiryEvents = await streamClass(); let calls = 0; const events = [];
  const stream = new InquiryEvents({ token: 'local-test', minDelay: 5, maxDelay: 20, onEvent: e => events.push(e), fetchImpl: async (url, opts) => {
    calls++; assert.equal(url, '/api/sync/events?only=inquiry'); assert.equal(opts.headers.authorization, 'Bearer local-test');
    if (calls === 1) return { ok: true, status: 200, body: new ReadableStream({ start(c) { for (const text of ['event: hello\ndata: {}\n\n', 'event: inqui', 'ry\ndata: {"id":3}\n\n']) c.enqueue(new TextEncoder().encode(text)); c.close(); } }) };
    return { status: 401 };
  } });
  stream.start();
  const until = Date.now() + 2000; while (!stream.stopped && Date.now() < until) await new Promise(r => setTimeout(r, 10));
  stream.stop(); assert.equal(calls, 2); assert.deepEqual(events, [null, { id: 3 }]);
});
test('web inquiry SSE: exponential delay cap, idle reconnect, 403 stop and logout cancel', async () => {
  const InquiryEvents = await streamClass(); let calls = 0;
  const s = new InquiryEvents({ token: 'test', minDelay: 2, maxDelay: 8, idleMs: 15, onEvent() {}, fetchImpl: async (_, { signal }) => {
    calls++;
    if (calls < 4) throw new Error('offline');
    if (calls === 4) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('idle'))));
    return { status: 403 };
  } });
  s.start();
  const until = Date.now() + 2000; while (!s.stopped && Date.now() < until) await new Promise(r => setTimeout(r, 10));
  assert.equal(calls, 5); assert.equal(s.delay, 8); s.stop();
});
test('web inquiry SSE: 기본 fetch 를 브라우저처럼 this 없이 부름 (Illegal invocation 막기)', async () => {
  const InquiryEvents = await streamClass(); const events = []; const real = globalThis.fetch; let calls = 0;
  globalThis.fetch = function (url) {
    // 브라우저의 window.fetch 는 다른 객체의 메서드로 부르면 TypeError: Illegal invocation
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    calls++; assert.equal(url, '/api/sync/events?only=inquiry');
    if (calls === 1) return Promise.resolve({ ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: inquiry\ndata: {"id":5}\n\n')); c.close(); } }) });
    return Promise.resolve({ status: 401 });
  };
  try {
    const s = new InquiryEvents({ token: 't', minDelay: 2, onEvent: (e) => events.push(e) });
    s.start();
    const until = Date.now() + 2000; while (!s.stopped && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    s.stop();
  } finally { globalThis.fetch = real; }
  assert.deepEqual(events, [{ id: 5 }]);
});
