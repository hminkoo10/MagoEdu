'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ApiError } = require('../src/core/api');
const { makePaths } = require('../src/core/paths');
const { TicketStore, writeTrust } = require('../src/core/tickets');
const { Cloud } = require('../src/main/cloud');
const { Store } = require('../src/main/store');
const { safeStorage } = require('./lib/safe-storage');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const keys = [{ kid: 'test-key', alg: 'Ed25519', x: publicKey.export({ format: 'jwk' }).x }];
const user = { id: 'current-user', username: 'test', name: '테스트', role: 'teacher' };
const offlineMessage = '서버에 연결할 수 없고, 인터넷 없이 쓸 수 있는 기간도 지났어요. 인터넷에 연결한 뒤 다시 해 주세요.';
const offline = async () => { throw new ApiError(0, 'offline', '오프라인'); };

function permit(app = 'notes', exp = Math.floor(Date.now() / 1000) + 3600) {
  const payload = Buffer.from(JSON.stringify({ kid: keys[0].kid, sub: user.id, app, exp })).toString('base64url');
  const body = `MGT1.${payload}`;
  return { ticket: `${body}.${crypto.sign(null, Buffer.from(body), privateKey).toString('base64url')}`, expiresAt: exp * 1000 };
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function setup(t, safe = safeStorage) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-tickets-'));
  const paths = makePaths({ userData: path.join(root, 'roaming'), localData: path.join(root, 'local') });
  const store = new Store({ paths, safeStorage: safe, defaults: { serverUrl: 'https://example.invalid' } });
  const clouds = [];
  const open = () => {
    const cloud = new Cloud({ paths, store, version: '1.0.0', log: { info() {}, warn() {}, error() {} } });
    // 네트워크·실제 앱 실행 없이 로그인 수명주기와 티켓 경로만 검사한다.
    cloud._afterLogin = async () => {};
    cloud.emitState = () => {};
    clouds.push(cloud);
    return cloud;
  };
  t.after(() => {
    for (const cloud of clouds) cloud.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cloud = open();
  cloud.user = user;
  cloud.phase = 'ready';
  return { paths, store, cloud, open, file: paths.account(user.id).tickets };
}

function prepareLaunch(cloud) {
  cloud.apps = [{ id: 'notes', name: '노트' }];
  cloud.installed.notes = { version: '1.0.0', manifest: { exe: 'notes.exe' } };
  cloud.syncApp = async () => {};
  const launched = [];
  cloud.runner.launch = (args) => launched.push(args);
  return launched;
}

test('티켓 파일은 암호화된 바이트만 저장하고 새 저장소에서도 검증 후 읽는다', async (t) => {
  const { file, store } = setup(t);
  const cache = new TicketStore(file, store);
  const first = permit();
  const second = permit('other');
  await cache.put('notes', first.ticket, first.expiresAt);
  await cache.put('other', second.ticket, second.expiresAt);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.includes(first.ticket), false);
  assert.equal(bytes.includes(second.ticket), false);
  assert.equal(bytes.includes('MGT1.'), false);
  const reopened = new TicketStore(file, store);
  assert.equal((await reopened.get('notes', keys)).ticket, first.ticket);
  assert.equal((await reopened.get('other', keys)).ticket, second.ticket);
});

test('온라인 발급 → 세션 복원 → 암호화된 캐시로 오프라인 실행', async (t) => {
  const { cloud, paths, store, file, open } = setup(t);
  const issued = permit();
  cloud.api.post = async () => issued;
  assert.equal(await cloud._ticket('notes', user.id), issued.ticket);
  assert.equal(fs.readFileSync(file).includes(issued.ticket), false);
  await writeTrust(paths.trustFile, { serverUrl: store.config.serverUrl, serverId: 'test-server', keys });
  store.saveSession({ serverUrl: store.config.serverUrl, token: 'test-token', user });
  const restored = open();
  await restored.init();
  restored.api.post = offline;
  const launched = prepareLaunch(restored);
  assert.deepEqual(await restored.launch('notes', { skipLegacyCheck: true }), { started: true });
  assert.equal(launched[0].env.MAGOEDU_TICKET, issued.ticket);
});

for (const [label, safe] of [
  ['없음', null],
  ['사용 불가', { ...safeStorage, isEncryptionAvailable: () => false }],
  ['확인 오류', { ...safeStorage, isEncryptionAvailable: () => { throw new Error('사용 불가'); } }],
]) {
  test(`암호화 ${label}: 온라인 실행은 유지하고 파일 저장·오프라인 실행은 하지 않음`, async (t) => {
    const { cloud, paths, store, file } = setup(t, safe);
    const issued = permit();
    cloud.api.post = async () => issued;
    const launched = prepareLaunch(cloud);
    assert.deepEqual(await cloud.launch('notes', { skipLegacyCheck: true }), { started: true });
    assert.equal(launched[0].env.MAGOEDU_TICKET, issued.ticket);
    assert.equal(fs.existsSync(file), false);
    await writeTrust(paths.trustFile, { serverUrl: store.config.serverUrl, serverId: 'test-server', keys });
    cloud.api.post = offline;
    await assert.rejects(cloud.launch('notes', { skipLegacyCheck: true }), { message: offlineMessage });
    assert.equal(launched.length, 1);
  });
}

for (const safe of [safeStorage, null]) {
  test(`이전 평문 티켓은 삭제하고 오프라인 실행에 쓰지 않음 (암호화 ${safe ? '가능' : '불가'})`, async (t) => {
    const { cloud, paths, store, file } = setup(t, safe);
    const issued = permit();
    write(file, JSON.stringify({ notes: { ...issued, savedAt: Date.now() } }));
    await writeTrust(paths.trustFile, { serverUrl: store.config.serverUrl, serverId: 'test-server', keys });
    cloud.api.post = offline;
    const launched = prepareLaunch(cloud);
    await assert.rejects(cloud.launch('notes', { skipLegacyCheck: true }), { message: offlineMessage });
    assert.equal(fs.existsSync(file), false);
    assert.equal(launched.length, 0);
  });
}

test('암호화되어 있어도 손상·서명 불일치·만료·다른 앱의 티켓은 쓰지 않음', async (t) => {
  const { file, store } = setup(t);
  const cache = new TicketStore(file, store);
  write(file, 'damaged-ciphertext');
  assert.equal(await cache.get('notes', keys), null);
  const valid = permit();
  await cache.put('notes', valid.ticket, valid.expiresAt);
  assert.equal(await cache.get('notes', [{ ...keys[0], x: crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x }]), null);
  for (const issued of [permit('notes', Math.floor(Date.now() / 1000) - 60), permit('other')]) {
    await cache.put('notes', issued.ticket, issued.expiresAt);
    assert.equal(await cache.get('notes', keys), null);
  }
});

for (const disconnected of [false, true]) {
  test(`${disconnected ? '오프라인' : '온라인'} 로그아웃은 앱 종료 뒤 해당 계정의 티켓만 삭제`, async (t) => {
    const { cloud, paths, store, file } = setup(t);
    const issued = permit();
    await new TicketStore(file, store).put('notes', issued.ticket, issued.expiresAt);
    const settings = paths.account(user.id).settings;
    write(settings, '{"autoLaunch":{}}');
    const data = path.join(paths.account(user.id).app('notes').sync, 'data.txt');
    write(data, 'keep');
    let stopped = false;
    cloud._stopApps = async (match) => {
      assert.equal(match({ userId: user.id }), true);
      assert.equal(match({ userId: 'other-user' }), false);
      assert.equal(fs.existsSync(file), true, '앱 종료 전에는 삭제하지 않음');
      stopped = true;
      return ['notes'];
    };
    cloud.syncApp = async () => {};
    cloud.api.logout = disconnected ? offline : async () => {};
    await cloud.logout();
    assert.equal(stopped, true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(settings, 'utf8'), '{"autoLaunch":{}}');
    assert.equal(fs.readFileSync(data, 'utf8'), 'keep');
    assert.equal(cloud.user, null);
    assert.equal(store.loadSession(), null);
  });
}

for (const sessionState of ['current', 'none', 'different-server']) {
  test(`시작 시 현재 계정 외 티켓 정리: ${sessionState}`, async (t) => {
    const { paths, store, file, open } = setup(t);
    const issued = permit();
    await new TicketStore(file, store).put('notes', issued.ticket, issued.expiresAt);
    const original = fs.readFileSync(file);
    const other = paths.account('other-user');
    write(other.tickets, JSON.stringify({ notes: { ...issued, savedAt: Date.now() } }));
    write(other.settings, '{"autoLaunch":{}}');
    if (sessionState !== 'none') {
      store.saveSession({ token: 'test-token', user, serverUrl: sessionState === 'current' ? store.config.serverUrl : 'https://other.invalid' });
    }
    const restored = open();
    await restored.init();
    assert.equal(fs.existsSync(other.tickets), false);
    assert.equal(fs.existsSync(other.settings), true);
    assert.equal(fs.existsSync(file), sessionState === 'current');
    if (sessionState === 'current') {
      assert.deepEqual(fs.readFileSync(file), original);
      assert.equal(restored.user.id, user.id);
    } else assert.equal(restored.user, null);
  });
}

test('다른 계정 로그인 시 이전 앱 종료 후 다른 계정의 티켓을 정리하고 현재 것은 유지', async (t) => {
  const { cloud, paths, store, file } = setup(t);
  const issued = permit();
  await new TicketStore(file, store).put('notes', issued.ticket, issued.expiresAt);
  const nextUser = { ...user, id: 'next-user', username: 'next' };
  const nextFile = paths.account(nextUser.id).tickets;
  await new TicketStore(nextFile, store).put('notes', issued.ticket, issued.expiresAt);
  const original = fs.readFileSync(nextFile);
  const thirdFile = paths.account('third-user').tickets;
  write(thirdFile, '{}');
  let stopped = false;
  cloud._stopApps = async (match) => {
    assert.equal(match({ userId: user.id }), true);
    assert.equal(match({ userId: nextUser.id }), false);
    assert.equal(fs.existsSync(file), true);
    stopped = true;
    return [];
  };
  cloud._makeApi = () => ({ token: 'next-token', login: async () => ({ user: nextUser }) });
  await cloud.login('next', 'test-password');
  assert.equal(stopped, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(thirdFile), false);
  assert.deepEqual(fs.readFileSync(nextFile), original);
  assert.equal(cloud.user.id, nextUser.id);
});
