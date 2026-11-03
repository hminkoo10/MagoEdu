'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makePaths } = require('../src/core/paths');
const { Store } = require('../src/main/store');
const { Installer } = require('../src/core/installer');
const { normalizeManifest } = require('../src/core/manifest');
const { Runner, sanitizeRunning } = require('../src/core/runner');
const { SyncEngine, sanitizeState } = require('../src/core/sync');
const { sanitizeMarks } = require('../src/core/legacy');
const { sanitizeTrust, sanitizeTickets } = require('../src/core/tickets');
const { sanitizeDefaults, sanitizeResume } = require('../src/main/startup');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `magoedu-validate-${name}-`));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

test('종료 인수: 문자열 배열만 허용하고 개수·길이·제어문자를 검증', () => {
  assert.deepEqual(normalizeManifest({ stopArgs: ['--quit', '공백 포함'] }).stopArgs, ['--quit', '공백 포함']);
  const boundary = Array(8).fill('x'.repeat(200));
  assert.deepEqual(normalizeManifest({ stopArgs: boundary }).stopArgs, boundary);
  for (const stopArgs of [undefined, null, [], '--quit', [1], ['--quit', null], Array(9).fill('x'), ['x'.repeat(201)], ['a\n'], ['a\0'], ['a\x7f'], ['a\x85']]) {
    assert.equal(normalizeManifest({ stopArgs }).stopArgs, null);
  }
});

test('손으로 고친 config·계정 설정은 허용된 값만 읽는다', () => {
  const root = tmp('store');
  try {
    const paths = makePaths({ userData: path.join(root, 'roaming'), localData: path.join(root, 'local') });
    writeJson(paths.configFile, {
      serverUrl: 'file:///C:/evil',
      deviceName: 'x'.repeat(101),
      autoStart: 'yes',
      closeToTray: null,
      autoUpdateApps: 0,
      shortcuts: {
        __proto__: { desktop: true },
        notes: { desktop: 'yes', name: '..\\evil.lnk' },
        safe: { desktop: false, name: 'safe.lnk' },
      },
    });
    const store = new Store({ paths, defaults: { serverUrl: 'https://example.com' } });
    assert.equal(store.config.serverUrl, 'https://example.com');
    assert.equal(store.config.autoStart, true);
    assert.equal(store.config.closeToTray, true);
    assert.equal(store.config.autoUpdateApps, true);
    assert.equal(store.config.shortcuts.notes.desktop, true);
    assert.equal(store.config.shortcuts.notes.name, undefined);
    assert.deepEqual(store.config.shortcuts.safe, { desktop: false, name: 'safe.lnk' });
    assert.equal({}.polluted, undefined);

    writeJson(paths.account('user-1').settings, {
      autoLaunch: { notes: true, __proto__: true, bad: 'yes' },
      noticesSeen: -1,
      legacyDismissed: { notes: ['old', 7, '__proto__'], __proto__: ['bad'] },
    });
    assert.deepEqual(store.accountSettings('user-1'), {
      autoLaunch: { notes: true },
      noticesSeen: 0,
      legacyDismissed: { notes: ['old', '__proto__'] },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('손상되거나 조작된 세션은 시작 시 로그인 상태로 쓰지 않는다', () => {
  const root = tmp('session');
  try {
    const paths = makePaths({ userData: root, localData: path.join(root, 'local') });
    const store = new Store({ paths });
    writeJson(paths.sessionFile, { token: 'token', serverUrl: 'https://user:pass@example.com', user: { id: 'u', username: 'u', name: 'U', role: 'teacher' } });
    assert.equal(store.loadSession(), null);
    writeJson(paths.sessionFile, { token: 'token', serverUrl: 'https://example.com', user: { id: 'u', username: 'u', name: 'U', role: 'teacher', __proto__: { admin: true } } });
    assert.deepEqual(store.loadSession(), { token: 'token', serverUrl: 'https://example.com', dataKey: null, user: { id: 'u', username: 'u', name: 'U', role: 'teacher' } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installed.json의 버전·실행 파일은 앱 설치 폴더 안에서만 유효하다', async () => {
  const root = tmp('installed');
  try {
    const paths = makePaths({ userData: path.join(root, 'roaming'), localData: path.join(root, 'local') });
    const app = paths.app('notes');
    fs.mkdirSync(path.join(app.root, '1.0.0', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(app.root, '1.0.0', 'bin', 'notes.exe'), 'x');
    const installer = new Installer({ paths, log: { warn() {} } });
    writeJson(app.installed, { id: 'notes', version: '../outside', manifest: { exe: 'bin/notes.exe' } });
    assert.equal(await installer.installed('notes'), null);
    writeJson(app.installed, { id: 'notes', version: '1.0.0', manifest: { exe: '../../outside.exe' } });
    assert.equal(await installer.installed('notes'), null);
    writeJson(app.installed, { id: 'notes', version: '1.0.0', manifest: { exe: 'bin/notes.exe', stopArgs: ['--quit'] } });
    const installed = await installer.installed('notes');
    assert.equal(installed.version, '1.0.0');
    assert.equal(installed.dir, path.join(app.root, '1.0.0'));
    assert.deepEqual(installed.manifest.stopArgs, ['--quit']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('running.json은 양의 PID와 제한된 숫자만 허용한다', () => {
  assert.equal(sanitizeRunning({ pid: 0 }), null);
  assert.equal(sanitizeRunning({ pid: -1 }), null);
  assert.equal(sanitizeRunning({ pid: Number.NaN }), null);
  assert.equal(sanitizeRunning({ pid: 1.5 }), null);
  assert.deepEqual(sanitizeRunning({ pid: 123, startedAt: Infinity, version: '../bad', userId: '\u0000' }), { pid: 123 });
  const root = tmp('running');
  try {
    const file = path.join(root, 'running.json');
    writeJson(file, { pid: 0, startedAt: Date.now() });
    const runner = new Runner({ paths: { app: () => ({ running: file }) }, log: { warn() {} } });
    assert.equal(runner.isRunning('notes'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('동기화 상태는 안전한 상대 경로와 유한한 값만 복원한다', () => {
  const sha = 'a'.repeat(64);
  const clean = sanitizeState({
    v: 1,
    seq: 4,
    remote: { 'data/a.txt': { rev: 2, sha256: sha, size: 3 }, '../escape': { rev: 9, sha256: sha } },
    base: { 'data/a.txt': { rev: 2, sha } },
    cache: { 'data/a.txt': { size: 3, mtimeMs: Date.now(), sha }, __proto__: { size: 1, mtimeMs: 1, sha } },
  });
  assert.deepEqual(Object.keys(clean.remote), ['data/a.txt']);
  assert.deepEqual(Object.keys(clean.base), ['data/a.txt']);
  assert.deepEqual(Object.keys(clean.cache), ['data/a.txt']);
  assert.equal(sanitizeState({ v: 1, seq: Infinity, remote: {}, base: {}, cache: {} }), null);
});

test('trust·tickets·legacy 마커의 객체 키와 숫자를 검증한다', () => {
  const trust = sanitizeTrust({ format: 1, serverUrl: 'https://user:pass@example.com', serverId: 's', keys: [] });
  assert.equal(trust, null);
  assert.deepEqual(sanitizeTickets({ __proto__: { ticket: 'x' }, notes: { ticket: 'x', expiresAt: Infinity, savedAt: 1 } }), {});
  const marks = sanitizeMarks({ notes: { at: Date.now(), copied: 1, from: 'C:\\old' }, __proto__: { at: 1 } });
  assert.equal(typeof marks.notes.at, 'number');
  assert.deepEqual({ copied: marks.notes.copied, from: marks.notes.from }, { copied: 1, from: 'C:\\old' });
});

test('기본값과 업데이트 재개 정보의 악성 필드를 버린다', () => {
  const validUrl = (value) => /^https:\/\//.test(value) ? value : null;
  assert.deepEqual(sanitizeDefaults({ serverUrl: 'javascript:alert(1)' }, validUrl), { serverUrl: '' });
  const now = Date.now();
  assert.deepEqual(sanitizeResume({ at: now - 1000, hidden: 1, autoLaunch: 'yes', __proto__: { x: 1 } }, now), { at: now - 1000, hidden: false, autoLaunch: false });
  assert.equal(sanitizeResume({ at: now - 11 * 60 * 1000 }, now), null);
});

test('동기화 상태: 서버 항목의 path 등 다른 값은 그대로 둠 (같은 내용 연결에 씀)', () => {
  const sha = 'a'.repeat(64);
  const s = sanitizeState({ v: 1, seq: 3, remote: { 'books/b1/a.pdf': { path: 'books/b1/a.pdf', rev: 2, sha256: sha, size: 4, updatedBy: 'u1' } }, base: {}, cache: {} });
  assert.deepEqual(s.remote['books/b1/a.pdf'], { path: 'books/b1/a.pdf', rev: 2, updatedBy: 'u1', sha256: sha, size: 4 });
});

test('받아 둔 세션: 사용자 정보의 다른 값은 그대로 두고 위험한 키만 뺌', () => {
  const { sanitizeSession } = require('../src/main/store');
  const s = sanitizeSession({ token: 't', serverUrl: 'https://mago.example.com', user: JSON.parse('{"id":"u-1","username":"kim","name":"김","role":"teacher","mustChangePassword":true,"__proto__":{"x":1}}') });
  assert.equal(s.user.mustChangePassword, true);
  assert.equal(Object.getPrototypeOf(s.user), Object.prototype);
  assert.equal({}.x, undefined);
});
