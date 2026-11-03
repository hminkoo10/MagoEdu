'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { openEvents, settleEvents } = require('./event-helpers');

/** 헤더·본문 도착 순서를 직접 정해 시간 지연 없이 경합을 재현한다. */
function response(t) {
  const res = new PassThrough();
  res.statusCode = 200;
  res.headers = { 'content-type': 'text/event-stream' };
  const req = new EventEmitter();
  req.destroy = (err) => {
    res.destroy();
    if (err) req.emit('error', err);
  };
  t.after(() => req.destroy());
  let onResponse;
  t.mock.method(http, 'get', (_url, _options, callback) => {
    onResponse = callback;
    return req;
  });
  return { res, connect: () => onResponse(res) };
}

test('실시간 대기: 헤더·조각난 hello 만으로 준비되지 않고, 함께 온 알림도 보존', async (t) => {
  const { res, connect } = response(t);
  let ready = false;
  const opening = openEvents('http://test', 'token').then((stream) => {
    ready = true;
    return stream;
  });
  connect();
  res.write('event: hello\ndata: {"time":"ready"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ready, false, '완전한 hello 를 받기 전에는 변경 요청을 시작하면 안 됨');
  res.write('\nevent: academy\ndata: {"kind":"students"}\n\n');
  const stream = await opening;
  assert.deepEqual(stream.hello.data, { time: 'ready' });
  assert.deepEqual((await stream.next('academy')).data, { kind: 'students' });
});

test('실시간 대기: hello 전에 연결이 끝나면 즉시 실패', async (t) => {
  const { res, connect } = response(t);
  const rejected = assert.rejects(openEvents('http://test', 'token'), /스트림이 끝났어요 \(hello 기다리는 중\)/);
  connect();
  res.end();
  await rejected;
});

test('실시간 대기: 시간 초과 뒤에도 알림·종료를 기다리고, 확인 표식 앞의 알림을 보존', async (t) => {
  const { res, connect } = response(t);
  const opening = openEvents('http://test', 'token');
  connect();
  res.write('event: hello\ndata: {}\n\n');
  const stream = await opening;
  await assert.rejects(stream.next('academy', 20), /academy 가 20ms 안에 오지 않았어요/);
  await assert.rejects(stream.waitEnd(20), /20ms 안에 끊기지 않았어요/);
  assert.equal(res.listenerCount('close'), 1, '시간 초과된 종료 대기는 남기지 않음');
  res.write(': ping\n\nevent: academy\ndata: {"kind":"students"}\n\n');
  await settleEvents({ streams: [{ res }] }, stream);
  assert.equal(stream.events.filter((e) => e.event === 'academy').length, 1, '앞서 온 ping 이 있어도 알림 유출을 숨기지 않음');
  const ended = stream.waitEnd();
  res.end();
  await ended;
  await stream.waitEnd();
});
