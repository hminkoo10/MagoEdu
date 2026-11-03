'use strict';

const http = require('node:http');

const WAIT_MS = 10_000;

/**
 * 실시간 알림을 조금씩 읽는다 (helpers 의 request() 는 본문을 끝까지 기다려서 못 씀)
 *   next(event, ms) → 아직 꺼내지 않은 것 중 그 종류의 다음 알림 ({ event, data } / 주석은 event: 'comment')
 */
async function openEvents(base, token, query = '') {
  const stream = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => req.destroy(new Error(`실시간 연결: ${WAIT_MS}ms 안에 열리지 않았어요`)), WAIT_MS);
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const req = http.get(`${base}/api/sync/events${query}`, { headers }, (res) => {
      clearTimeout(timer);
      const events = [];
      const waiters = new Set();
      let cursor = 0;
      let buf = '';
      let ended = false;
      const kick = () => waiters.forEach((w) => w());
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(':')) {
            events.push({ event: 'comment', data: block.slice(1).trim() });
            continue;
          }
          let event = 'message';
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
          }
          let parsed = data.join('\n');
          try {
            parsed = JSON.parse(parsed);
          } catch {
            /* 글자 그대로 */
          }
          events.push({ event, data: parsed });
        }
        kick();
      });
      res.on('error', reject);
      res.on('close', () => {
        ended = true;
        kick();
      });
      const stream = {
        status: res.statusCode,
        headers: res.headers,
        events,
        get ended() {
          return ended;
        },
        next(event, ms = WAIT_MS) {
          return new Promise((ok, fail) => {
            const check = () => {
              for (let j = cursor; j < events.length; j += 1) {
                if (events[j].event !== event) continue;
                cursor = j + 1;
                done();
                ok(events[j]);
                return;
              }
              if (ended) {
                done();
                fail(new Error(`스트림이 끝났어요 (${event} 기다리는 중)`));
              }
            };
            const timer = setTimeout(() => {
              done();
              fail(new Error(`${event} 가 ${ms}ms 안에 오지 않았어요`));
            }, ms);
            const done = () => {
              clearTimeout(timer);
              waiters.delete(check);
            };
            waiters.add(check);
            check();
          });
        },
        waitEnd(ms = WAIT_MS) {
          return new Promise((ok, fail) => {
            if (ended) return ok();
            const onClose = () => {
              clearTimeout(timer);
              ok();
            };
            const timer = setTimeout(() => {
              res.removeListener('close', onClose);
              fail(new Error(`${ms}ms 안에 끊기지 않았어요`));
            }, ms);
            res.once('close', onClose);
            return undefined;
          });
        },
        close() {
          req.destroy();
        },
      };
      if (res.statusCode !== 200) {
        const chunks = [];
        res.removeAllListeners('data');
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            stream.body = JSON.parse(chunks.join(''));
          } catch {
            stream.body = chunks.join('');
          }
          resolve(stream);
        });
        return;
      }
      resolve(stream);
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  if (stream.status === 200) {
    try {
      // 서버가 구독을 등록한 뒤 보내는 hello 를 받아야 변경 요청을 시작한다.
      stream.hello = await stream.next('hello');
    } catch (err) {
      stream.close();
      throw err;
    }
  }
  return stream;
}

/** 서버 안의 상태를 기다릴 때만 짧게 확인한다 (알림 자체는 next 로 기다림). */
async function until(fn, label, ms = WAIT_MS) {
  const end = performance.now() + ms;
  while (!fn()) {
    if (performance.now() >= end) throw new Error(`${label}: ${ms}ms 안에 되지 않았어요`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 같은 연결에 확인 표식을 써서, 그 앞의 알림을 모두 읽은 뒤 미수신을 검사한다. */
async function settleEvents(hub, stream) {
  for (const subscription of hub.streams) {
    subscription.res.write('event: test-barrier\ndata: {}\n\n');
  }
  await stream.next('test-barrier');
}

module.exports = { openEvents, until, settleEvents };
