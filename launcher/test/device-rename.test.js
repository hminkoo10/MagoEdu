'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Cloud } = require('../src/main/cloud');
const { Store } = require('../src/main/store');
const { makePaths } = require('../src/core/paths');
const { startServer, ADMIN_PASSWORD } = require('../../server/test/helpers');

async function setup(t) {
  const server = await startServer();
  t.after(() => server.close());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-device-name-'));
  const paths = makePaths({ userData: root, localData: path.join(root, 'local') });
  const store = new Store({ paths, defaults: { serverUrl: server.base, deviceName: '예전 이름' } });
  const token = await server.login('admin', ADMIN_PASSWORD, store.config.deviceId, store.config.deviceName);
  const c = new Cloud({ paths, store, version: '1.0.0', log: { info() {}, warn() {}, error() {} } });
  c.api = c._makeApi(server.base, token);
  c.user = (await c.api.get('/api/me')).user;
  c.phase = 'ready';
  // 상태 지연 타이머 대신 실제 스냅샷을 즉시 전달한다.
  c.emitState = () => c.emit('state', c.snapshot());
  const toasts = [];
  c.on('toast', (value) => toasts.push(value));
  t.after(() => { c.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { c, server, paths, toasts };
}

function viewFixture(file, name, toastMessages = []) {
  const inputs = [];
  const element = (tag, attrs, ...children) => ({
    tag, ...attrs, children, listeners: {},
    addEventListener(event, fn) { this.listeners[event] = fn; },
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/views', file), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(`export class ${name}`, `class ${name}`);
  const View = vm.runInNewContext(`${source}\n${name}`, {
    h: element, ic: () => element('icon'), btn: () => element('button'),
    input: (attrs) => { const el = element('input', attrs); inputs.push(el); return el; },
    toggle: () => element('toggle'), pill: () => element('pill'),
    put: (el, ...children) => { el.children = children; }, reveal() {}, ago: () => '방금',
    toast: (text, kind) => toastMessages.push({ text, kind }),
  });
  return { View, inputs };
}

test('설정의 이름 변경: 서버 갱신 후 성공 안내, 로그인한 기기 목록 새로 고침', async (t) => {
  const { c, server } = await setup(t);
  const messages = [];
  const { View: SettingsView, inputs } = viewFixture('settings.js', 'SettingsView', messages);
  new SettingsView({ cloud: { setConfig: async (patch) => c.setConfig(patch) }, store: { state: c.snapshot() } });
  const { View: AccountView } = viewFixture('account.js', 'AccountView');
  const account = Object.create(AccountView.prototype);
  account.cloud = { api: (...args) => c.apiCall(...args) };
  account.devices = {};
  account.renderProfile = () => {};
  const reads = [];
  const loadDevices = account.loadDevices.bind(account);
  account.loadDevices = () => { const read = loadDevices(); reads.push(read); return read; };
  account.update(c.snapshot());
  await Promise.all(reads);
  const before = reads.length;
  c.on('state', (s) => account.update(s));
  inputs[0].value = '  교무실 PC  ';
  await inputs[0].listeners.change();
  await Promise.all(reads);
  const list = await server.request('GET', '/api/me/devices', { token: c.api.token });
  assert.equal(list.data.devices.find((d) => d.current).deviceName, '교무실 PC');
  assert.ok(reads.length > before, '이름 반영 뒤 목록을 다시 요청');
  assert.match(JSON.stringify(account.devices), /교무실 PC/);
  assert.equal(messages.at(-1).kind, 'success');
  assert.doesNotMatch(messages.at(-1).text, /다음 로그인/);
});

test('기기 이름: 연결 실패해도 로컬 저장, 다음 동기화에서 조용히 재시도', async (t) => {
  const { c, paths, toasts } = await setup(t);
  const fetch = c.api.fetch;
  c.api.fetch = async () => { throw new Error('offline'); };
  const result = await c.setConfig({ deviceName: '새 PC' });
  assert.equal(result.deviceName, '새 PC');
  assert.equal(result.deviceNamePending, true);
  assert.equal(new Store({ paths }).config.deviceName, '새 PC');
  assert.equal(c.api.device.name, '새 PC');
  assert.deepEqual(toasts, []);
  c.api.fetch = fetch;
  await c.syncAll({ quiet: true }); // 설치한 프로그램이 없어도 이름은 맞춤
  const list = await c.api.get('/api/me/devices');
  assert.equal(list.devices[0].deviceName, '새 PC');
  assert.deepEqual(toasts, []);
});

test('기기 이름: 재시작 후 저장된 이름을 기존 로그인 세션에 재동기화', async (t) => {
  const { c, paths } = await setup(t);
  c.api.fetch = async () => { throw new Error('offline'); };
  await c.setConfig({ deviceName: '재시작 PC' });
  const restored = new Cloud({ paths, store: new Store({ paths }), version: '1.0.0', log: c.log });
  t.after(() => restored.shutdown());
  restored.api = restored._makeApi(c.store.config.serverUrl, c.api.token);
  restored.user = c.user;
  restored.phase = 'ready';
  restored.emitState = () => {};
  await restored.syncAll({ quiet: true });
  const list = await restored.api.get('/api/me/devices');
  assert.equal(list.devices[0].deviceName, '재시작 PC');
});

test('기기 이름: 새 로그인에서도 로컬 이름 전송', async (t) => {
  const { c } = await setup(t);
  c.api.fetch = async () => { throw new Error('offline'); };
  await c.setConfig({ deviceName: '다음 로그인 PC' });
  c._afterLogin = async () => {};
  await c.login('admin', ADMIN_PASSWORD);
  const list = await c.api.get('/api/me/devices');
  assert.equal(list.devices[0].deviceName, '다음 로그인 PC');
});

test('기기 이름: 잘못된 값은 서버 요청·로컬 덮어쓰기 없이 거부', async (t) => {
  const { c } = await setup(t);
  const before = c.store.config.deviceName;
  for (const deviceName of ['', '   ', '가'.repeat(81), 'PC\n', 'PC\u007f', 'PC\u0085', null, 123]) {
    await assert.rejects(async () => c.setConfig({ deviceName }));
    assert.equal(c.store.config.deviceName, before);
  }
});

test('설정의 이름 변경: 서버 오류는 저장·재시도 안내만 표시', async (t) => {
  const { c, paths, toasts } = await setup(t);
  const fetch = c.api.fetch;
  c.api.fetch = async () => new Response(JSON.stringify({ error: { code: 'server_error', message: '실패' } }), { status: 500 });
  const messages = [];
  const { View, inputs } = viewFixture('settings.js', 'SettingsView', messages);
  new View({ cloud: { setConfig: async (patch) => c.setConfig(patch) }, store: { state: c.snapshot() } });
  inputs[0].value = '서버 복구 뒤 PC';
  await inputs[0].listeners.change();
  assert.equal(new Store({ paths }).config.deviceName, '서버 복구 뒤 PC');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'success');
  assert.match(messages[0].text, /저장.*연결되면/);
  await c.syncAll({ quiet: true });
  assert.equal(messages.length, 1);
  assert.deepEqual(toasts, []);
  c.api.fetch = fetch;
  await c.syncAll({ quiet: true });
  assert.equal((await c.api.get('/api/me/devices')).devices[0].deviceName, '서버 복구 뒤 PC');
});

test('기기 이름: 빠른 연속 변경은 최신 이름으로 끝나고 성공 뒤 중복 전송 없음', async (t) => {
  const { c } = await setup(t);
  const fetch = c.api.fetch;
  const names = [];
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  c.api.fetch = async (url, opts) => {
    if (opts.method === 'PATCH') {
      names.push(JSON.parse(opts.body).name);
      if (names.length === 1) await first;
    }
    return fetch(url, opts);
  };
  const a = c.setConfig({ deviceName: '첫 이름' });
  const b = c.setConfig({ deviceName: '둘째 이름' });
  const last = c.setConfig({ deviceName: '마지막 이름' });
  assert.equal(c.store.config.deviceName, '마지막 이름', '응답을 기다리지 않고 로컬 저장');
  release();
  await Promise.all([a, b, last]);
  assert.equal((await c.api.get('/api/me/devices')).devices[0].deviceName, '마지막 이름');
  const count = names.length;
  await c.syncAll({ quiet: true });
  assert.equal(names.length, count);
});

test('기기 목록: 늦게 도착한 이전 목록이 새 이름을 덮지 않음', async () => {
  const { View } = viewFixture('account.js', 'AccountView');
  const account = Object.create(View.prototype);
  account.devices = {};
  let resolveOld;
  let calls = 0;
  const rows = (deviceName) => ({ devices: [{ id: 1, deviceName, current: true }] });
  account.cloud = { api: () => ++calls === 1 ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve(rows('새 이름')) };
  const old = account.loadDevices();
  await account.loadDevices();
  resolveOld(rows('예전 이름'));
  await old;
  assert.match(JSON.stringify(account.devices), /새 이름/);
  assert.doesNotMatch(JSON.stringify(account.devices), /예전 이름/);
});
