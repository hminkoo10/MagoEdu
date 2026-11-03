'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ADMIN_PASSWORD } = require('./helpers');

async function setup(t) {
  const s = await startServer();
  t.after(() => s.close());
  const token = await s.login('admin', ADMIN_PASSWORD, 'my-pc', '예전 이름');
  return { ...s, token };
}

test('기기 이름: 현재 세션을 바꾸면 재로그인 없이 목록에 반영', async (t) => {
  const s = await setup(t);
  const r = await s.request('PATCH', '/api/me/devices/current', { token: s.token, body: { name: '  새 컴퓨터  ' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.device.deviceName, '새 컴퓨터');
  assert.equal(r.data.device.current, true);
  const list = await s.request('GET', '/api/me/devices', { token: s.token });
  assert.equal(list.data.devices.find((d) => d.current).deviceName, '새 컴퓨터');
});

test('기기 이름: 다른 세션·다른 사용자는 수정할 수 없고 기기 ID 위조도 무시', async (t) => {
  const s = await setup(t);
  const otherSession = await s.login('admin', ADMIN_PASSWORD, 'other-pc', '다른 PC');
  const created = await s.request('POST', '/api/users', {
    token: s.token,
    body: { role: 'teacher', name: '선생님', username: 'teacher1', password: 'teacher123', academyName: '학원' },
  });
  assert.equal(created.status, 200);
  const otherUser = await s.login('teacher1', 'teacher123', 'my-pc', '다른 사용자 PC');
  const ownDevices = (await s.request('GET', '/api/me/devices', { token: s.token })).data.devices;
  const otherDevices = (await s.request('GET', '/api/me/devices', { token: otherUser })).data.devices;
  const targets = [ownDevices.find((d) => !d.current).id, otherDevices[0].id];
  for (const id of targets) {
    const r = await s.request('PATCH', `/api/me/devices/${id}`, { token: s.token, body: { name: '침범' } });
    assert.equal(r.status, 404);
  }
  const renamed = await s.request('PATCH', '/api/me/devices/current', {
    token: s.token, body: { name: '내 PC', deviceId: 'other-pc', sessionId: targets[0], userId: created.data.user.id },
  });
  assert.equal(renamed.status, 200);
  assert.equal((await s.request('GET', '/api/me/devices', { token: otherSession })).data.devices.find((d) => d.current).deviceName, '다른 PC');
  assert.equal((await s.request('GET', '/api/me/devices', { token: otherUser })).data.devices[0].deviceName, '다른 사용자 PC');
});

test('기기 이름: 인증 필수, 로그아웃한 세션과 프로그램 전용 세션 거부', async (t) => {
  const s = await setup(t);
  const rename = (token) => s.request('PATCH', '/api/me/devices/current', { token, body: { name: '새 이름' } });
  assert.equal((await rename()).status, 401);
  await s.request('POST', '/api/auth/logout', { token: s.token });
  assert.equal((await rename(s.token)).status, 401);
  const user = s.app.deps.db.get("SELECT * FROM users WHERE username = 'admin'");
  const appToken = s.app.deps.svc.createSession(user, { id: 'app-session', name: '앱', platform: 'web-app' }, '127.0.0.1', { appId: 'ohdapnote' });
  assert.equal((await rename(appToken)).status, 403);
});

test('기기 이름: 공백 정리, 80자 한도, 빈 값·비문자열·제어문자 거부', async (t) => {
  const s = await setup(t);
  for (const name of [undefined, null, 123, {}, [], '', '   ', '가'.repeat(81), 'PC\n', 'PC\t이름', '\u0000PC', 'PC\u007f', 'PC\u0085']) {
    const r = await s.request('PATCH', '/api/me/devices/current', { token: s.token, body: { name } });
    assert.equal(r.status, 400, String(JSON.stringify(name)));
    assert.equal(r.data.error.code, 'invalid_device_name');
  }
  const before = (await s.request('GET', '/api/me/devices', { token: s.token })).data.devices[0];
  assert.equal(before.deviceName, '예전 이름');
  const name = '가'.repeat(80);
  const r = await s.request('PATCH', '/api/me/devices/current', { token: s.token, body: { name } });
  assert.equal(r.status, 200);
  assert.equal(r.data.device.deviceName, name);
});

test('기기 이름: 브라우저 로그인 세션도 같은 인증 경로 사용', async (t) => {
  const s = await setup(t);
  const login = await s.request('POST', '/api/auth/login', {
    body: { username: 'admin', password: ADMIN_PASSWORD, device: { id: 'browser', name: 'Chrome', platform: 'web' } },
  });
  const r = await s.request('PATCH', '/api/me/devices/current', { token: login.data.token, body: { name: '학원 브라우저' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.device.platform, 'web');
  assert.equal(r.data.device.deviceName, '학원 브라우저');
});
