'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Runner, focusWindowByPid } = require('../src/core/runner');

function setup(t, { focus = () => false, relay = (child) => queueMicrotask(() => child.emit('exit', 0)) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-focus-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = { dir: root, version: '1.0.0', manifest: { exe: 'app.exe', args: ['--app'], singleInstance: true } };
  fs.writeFileSync(path.join(root, 'app.exe'), 'fake');
  const runningFile = path.join(root, 'running.json');
  const calls = [];
  const killed = [];
  const focused = [];
  const runner = new Runner({
    paths: { app: () => ({ running: runningFile }) },
    log: { warn() {} },
    focusImpl: async (pid) => { focused.push(pid); return focus(pid, focused.length); },
    killImpl: async (child) => { killed.push(child.pid); child.emit('exit', null); },
    spawnImpl: (exe, args, options) => {
      const child = new EventEmitter();
      child.pid = 7000 + calls.length;
      calls.push({ exe, args, options, child });
      if (calls.length > 1) relay(child);
      return child;
    },
  });
  const env = { MAGOEDU_USER_ID: 'user1', MAGOEDU_TICKET: 'ticket', MAGOEDU_DATA_DIR: root };
  runner.launch({ appId: 'notes', installed, env });
  const record = fs.readFileSync(runningFile, 'utf8');
  return { runner, calls, killed, focused, installed, env, runningFile, record };
}

test('창 복구: PID로 복구되면 재실행하지 않고 실행 기록도 유지', async (t) => {
  const { runner, calls, focused, runningFile, record } = setup(t, { focus: () => true });
  assert.equal((await runner.focus({ appId: 'notes' })).focused, true);
  assert.deepEqual(focused, [7000]);
  assert.equal(calls.length, 1);
  assert.equal(fs.readFileSync(runningFile, 'utf8'), record);
});

test('두 번째 실행: 원래 exe·인수·환경 재사용, 연타 합치기, 종료·재시작 이벤트 없음', async (t) => {
  const { runner, calls, env, installed, runningFile, record } = setup(t, { focus: (_pid, n) => n > 1 });
  const events = [];
  for (const event of ['start', 'exit', 'error']) runner.on(event, () => events.push(event));
  const results = await Promise.all([runner.focus({ appId: 'notes' }), runner.focus({ appId: 'notes' })]);
  assert.ok(results.every((r) => r.focused));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].exe, path.join(installed.dir, 'app.exe'));
  assert.deepEqual(calls[1].args, ['--app']);
  assert.equal(calls[1].options.env, env);
  assert.equal(runner.running.size, 1);
  assert.equal(runner.runningInfo('notes').pid, 7000);
  assert.equal(fs.readFileSync(runningFile, 'utf8'), record);
  assert.deepEqual(events, []);
});

test('단일 실행 미지원·런처 재시작으로 환경이 없으면 PID만 시도', async (t) => {
  const { runner, calls, installed } = setup(t);
  installed.manifest.singleInstance = false;
  assert.equal((await runner.focus({ appId: 'notes' })).focused, false);
  assert.equal(calls.length, 1);
  runner.running.clear();
  runner.runningInfo = () => ({ pid: 7000 });
  assert.equal((await runner.focus({ appId: 'notes' })).focused, false);
  assert.equal(calls.length, 1);
});

test('응답 없는 두 번째 실행은 정리, 다음 클릭에는 중복 프로세스를 만들지 않음', async (t) => {
  const { runner, calls, killed, runningFile, record } = setup(t, { relay() {} });
  assert.equal((await runner.focus({ appId: 'notes', timeoutMs: 10 })).focused, false);
  assert.deepEqual(killed, [7001]);
  assert.equal((await runner.focus({ appId: 'notes', timeoutMs: 10 })).focused, false);
  assert.equal(calls.length, 2);
  assert.equal(fs.readFileSync(runningFile, 'utf8'), record);
});

test('두 번째 실행 오류는 원본 실행 기록·이벤트를 건드리지 않고 PID 복구로 처리', async (t) => {
  const { runner, runningFile, record } = setup(t, {
    focus: (_pid, n) => n > 1,
    relay: (child) => queueMicrotask(() => child.emit('error', new Error('spawn failed'))),
  });
  assert.equal((await runner.focus({ appId: 'notes' })).focused, true);
  assert.equal(fs.readFileSync(runningFile, 'utf8'), record);
});

test('창 복구를 기다리다가 원본이 꺼졌으면 새 프로세스를 만들지 않음', async (t) => {
  const { runner, calls } = setup(t);
  runner.focusImpl = async () => { calls[0].child.emit('exit', 0); return false; };
  assert.equal((await runner.focus({ appId: 'notes' })).focused, false);
  assert.equal(calls.length, 1);
});

test('잘못된 PID는 포커스 성공으로 처리하지 않음', async () => {
  for (const pid of [undefined, null, 0, -1, '123']) assert.equal(await focusWindowByPid(pid), false);
});

test('Windows 포커스 도우미: 인수 안전 전달·숨김·시간 제한, 실패를 성공으로 보고하지 않음', async () => {
  let call;
  const execImpl = (exe, args, options, done) => { call = { exe, args, options }; done(null); };
  assert.equal(await focusWindowByPid(123, { platform: 'win32', execImpl }), true);
  assert.equal(call.exe, 'powershell.exe');
  assert.equal(call.options.env.MAGOEDU_FOCUS_PID, '123');
  assert.equal(call.options.windowsHide, true);
  assert.ok(call.options.timeout > 0);
  assert.equal(await focusWindowByPid(123, { platform: 'win32', execImpl: (_exe, _args, _opts, done) => done(new Error('timeout')) }), false);
  assert.equal(await focusWindowByPid(process.pid, { platform: 'linux', execImpl }), false);
});

test('Windows 포커스 스크립트는 컴파일되고 없는 PID는 실패로 끝남', { skip: process.platform !== 'win32' }, async () => {
  const { execFile } = require('node:child_process');
  let failure;
  let errors;
  const result = await focusWindowByPid(2147483647, {
    execImpl: (exe, args, opts, done) => execFile(exe, args, opts, (err, _stdout, stderr) => {
      failure = err;
      errors = stderr;
      done(err);
    }),
  });
  assert.equal(result, false);
  assert.equal(failure?.code, 1);
  assert.equal(errors, '');
});
