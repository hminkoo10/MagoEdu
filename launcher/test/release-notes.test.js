'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { readJsonSync } = require('../src/core/fsutil');
const { promote, promoteFile } = require('../scripts/promote-release-notes.cjs');
const notesFile = path.join(__dirname, '../src/renderer/release-notes.json');
const renderer = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/js/release-notes.js')).href);

test('내역: 숫자 버전 내림차순, next·깨진 항목 제외, 입력 보존', async () => {
  const { releasedNotes } = await renderer();
  const data = { next: ['미배포'], releases: [
    { version: '1.2.9', notes: ['아홉'] }, { version: '1.2.10', notes: [' 열 ', null, ''] },
    { version: '2.0.0', notes: ['둘'] }, { version: '1.10.0', notes: ['열'] },
    null, { version: ['1.2.3'], notes: ['깨짐'] }, { version: 'next', notes: ['아직'] }, { version: '1.2.1', notes: '깨짐' }, { version: '1.2.2', notes: [] },
  ] };
  const copy = structuredClone(data);
  assert.deepEqual(releasedNotes(data).map((r) => r.version), ['2.0.0', '1.10.0', '1.2.10', '1.2.9']);
  assert.deepEqual(releasedNotes(data)[2].notes, ['열']);
  assert.deepEqual(data, copy);
  for (const bad of [null, [], {}, { releases: false }]) assert.deepEqual(releasedNotes(bad), []);
});

test('내역: 실제 묶음 파일 읽기, 없는·깨진 파일과 IPC 실패는 빈 내역', async (t) => {
  const { loadReleaseNotes } = await renderer();
  const root = fs.mkdtempSync(path.join(__dirname, '.notes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'notes.json');
  const bridge = (p) => ({ getReleaseNotes: async () => readJsonSync(p, null) });
  const bundled = await loadReleaseNotes(bridge(notesFile));
  assert.ok(bundled.length >= 9);
  assert.ok(bundled.some((r) => r.version === '1.2.18'));
  assert.deepEqual(await loadReleaseNotes(bridge(file)), []);
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(await loadReleaseNotes(bridge(file)), []);
  assert.deepEqual(await loadReleaseNotes({ getReleaseNotes: async () => { throw new Error('IPC'); } }), []);
  assert.ok(require('../package.json').build.files.includes('src/**/*'), '원본 내역은 asar 포함 경로');
});

test('웹 내역: 같은 정적 파일 요청, 404·잘못된 JSON·연결 실패는 빈 내역', async (t) => {
  const { loadReleaseNotes } = await renderer();
  let response;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls++;
    assert.ok(url.pathname.endsWith('/src/renderer/release-notes.json'));
    assert.equal(opts.cache, 'no-store');
    assert.ok(opts.signal);
    if (response instanceof Error) throw response;
    return response;
  });
  response = { ok: true, json: async () => readJsonSync(notesFile) };
  assert.deepEqual(await loadReleaseNotes({}), (await renderer()).releasedNotes(readJsonSync(notesFile)));
  response = { ok: false };
  assert.deepEqual(await loadReleaseNotes({}), []);
  response = { ok: true, json: async () => { throw new SyntaxError('broken'); } };
  assert.deepEqual(await loadReleaseNotes({}), []);
  response = new Error('offline');
  assert.deepEqual(await loadReleaseNotes({}), []);
  assert.equal(calls, 4);
});

test('승격: next → 새 버전, 같은 문장으로 릴리스 설명, 기존 내역 보존', () => {
  const data = { next: [' 새 기능이에요. ', '고쳤어요.'], releases: [{ version: '1.2.18', notes: ['예전'] }] };
  const copy = structuredClone(data);
  const result = promote(data, '1.2.19');
  assert.deepEqual(result.data.next, []);
  assert.deepEqual(result.data.releases, [{ version: '1.2.19', notes: ['새 기능이에요.', '고쳤어요.'] }, ...data.releases]);
  assert.equal(result.markdown, '- 새 기능이에요.\n- 고쳤어요.\n');
  assert.deepEqual(data, copy);
  assert.equal(promote(result.data, '1.2.19').markdown, '', '재실행은 내역을 중복하지 않음');
});

test('승격: 빈 next는 파일 그대로, 빈 설명으로 기존 방식 유지', (t) => {
  const root = fs.mkdtempSync(path.join(__dirname, '.promote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'notes.json');
  const output = path.join(root, 'notes.md');
  const original = '{"next": [], "releases": []}\n';
  fs.writeFileSync(file, original);
  fs.writeFileSync(output, '이전 실행 흔적');
  promoteFile(file, '1.2.19', output);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.readFileSync(output, 'utf8'), '');
  fs.writeFileSync(file, JSON.stringify({ next: ['설정에서 볼 수 있어요.'], releases: [] }));
  promoteFile(file, '1.2.19', output);
  assert.equal(readJsonSync(file).releases[0].version, '1.2.19');
  assert.equal(fs.readFileSync(output, 'utf8'), '- 설정에서 볼 수 있어요.\n');
});

test('승격: 잘못된 형식·버전·중복 버전은 중단하고 기존 내역 보호', () => {
  for (const bad of [null, {}, { next: 'oops', releases: [] }, { next: [null], releases: [] }, { next: [' '], releases: [] }]) {
    assert.throws(() => promote(bad, '1.2.19'));
  }
  const data = { next: ['새 내역'], releases: [{ version: '1.2.18', notes: ['기존'] }] };
  assert.throws(() => promote(data, 'v1.2.19'));
  assert.throws(() => promote(data, '1.2.18'));
  assert.equal(data.next[0], '새 내역');
});

let electron;
try { electron = require('electron'); } catch { /* 없으면 건너뜀 */ }
// 화면 없는 리눅스(CI)에서는 Electron 창을 띄울 수 없음
const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
test('내역 화면: PC·웹 단추, 정렬·빈 내역·텍스트 안전성, 열기·닫기·Esc', { skip: (!electron && 'electron 이 없음') || (noDisplay && '화면(DISPLAY)이 없음') }, () => {
  const root = fs.mkdtempSync(path.join(__dirname, '.notes-ui-'));
  try {
    const env = { ...process.env, TEMP: root, TMP: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(electron, [path.join(__dirname, 'lib/release-notes-ui.cjs'), root, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { env, encoding: 'utf8', timeout: 45000, windowsHide: true });
    assert.equal(r.status, 0, `${r.error || ''}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /RELEASE_NOTES_UI_OK/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
