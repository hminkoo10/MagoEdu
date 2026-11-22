'use strict';
// 운영자 '학원 자료' 화면 (views/academy-files.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '../src');

function fixture({ role = 'admin', entries = null, answers = [true] } = {}) {
  const buttons = [], dialogs = [], calls = [], toasts = [], went = [], native = [];
  const el = (tag, props = {}, ...children) => ({ tag, props, children: children.flat(), style: {}, value: props.value ?? '', append() {}, addEventListener(type, fn) { this[`on${type}`] = fn; } });
  const context = { Map, Set, Promise, String, Number, console, encodeURIComponent,
    h: el, input: (props = {}) => el('input', props),
    select: (options, value) => ({ ...el('select'), options, value }),
    btn: (label, options = {}) => { const b = { ...el('button'), label, options }; buttons.push(b); return b; },
    busy: (_b, fn) => fn(), put: (target, ...children) => { target.children = children; },
    dialog: async (options) => { dialogs.push(options); return answers.shift(); },
    toast: (text, kind) => toasts.push({ text, kind }), errorText: (e) => e.message,
    date: () => '오늘', bytes: (n) => `${n}B`,
  };
  let source = fs.readFileSync(path.join(SRC, 'renderer/js/views/academy-files.js'), 'utf8');
  source = source.replace(/^import .*;$/gm, '').replace(/export /g, '');
  vm.runInNewContext(`${source}\nthis.AcademyFilesView = AcademyFilesView;`, context);
  const files = entries || [
    { path: 'books/b1/book.json', rev: 3, size: 10, updatedAt: 1, updatedBy: 'u1' },
    { path: 'members/u1/x.json', rev: 1, size: 5, updatedAt: 1, updatedBy: 'u1' },
    { path: 'old.json', rev: 2, size: 0, updatedAt: 1, deleted: true },
  ];
  const cloud = {
    api: async (method, route) => {
      calls.push({ method, route });
      if (route === '/api/academies') return { academies: [{ id: 7, name: '가학원' }] };
      if (route.startsWith('/api/academy/members')) return { members: [{ id: 'u1', name: '김선생' }] };
      if (route.startsWith('/api/sync?')) return { academy: { id: 7, apps: [{ appId: 'other', files: 1 }, { appId: 'ohdapnote', files: 2 }] } };
      if (route === '/api/apps') return { apps: [{ id: 'ohdapnote', name: '오답노트' }] };
      if (method === 'GET') return { entries: files };
      return {};
    },
    academyFileDownload: async (...args) => { native.push(['download', ...args]); return true; },
    academyFileReplace: async (...args) => { native.push(['replace', ...args]); return true; },
  };
  const store = { state: { user: { role }, apps: [] } };
  const view = new context.AcademyFilesView({ cloud, store, go: (...a) => went.push(a), opts: { academy: 7 } });
  return { view, buttons, dialogs, calls, toasts, went, native };
}

const rowButtons = (f, label) => f.buttons.filter((b) => b.label === label);

test('운영자가 아니면 화면에 들어오지 못함', () => {
  for (const role of ['director', 'teacher', 'student']) {
    const f = fixture({ role });
    assert.deepEqual(f.went, [['home']]);
    assert.equal(f.calls.length, 0);
  }
});

test('고른 학원의 자료 목록: 모든 요청에 ?academy=, 지운 파일은 안 보임', async () => {
  const f = fixture();
  await f.view.ready;
  assert.deepEqual(f.calls.map((c) => c.route), [
    '/api/academies', '/api/academy/members?academy=7', '/api/sync?academy=7', '/api/apps', '/api/sync/ohdapnote/academy?academy=7&since=0',
  ]);
  assert.equal(f.view.app, 'ohdapnote', '자료가 있는 프로그램 중 오답노트가 먼저');
  const programs = f.view.el.children[2].children[0];
  assert.equal(JSON.stringify(programs.options), JSON.stringify([['other', 'other'], ['ohdapnote', '오답노트']]), '이름은 서버 목록에서, 모르는 것은 ID');
  assert.deepEqual(f.view.entries.map((e) => e.path), ['books/b1/book.json', 'members/u1/x.json']);
  assert.equal(rowButtons(f, '내려받기').length, 2);
  assert.equal(rowButtons(f, '지우기')[0].options.variant, 'danger');
  const icons = fs.readFileSync(path.join(SRC, 'renderer/js/icons.js'), 'utf8');
  for (const b of f.buttons) if (b.options.iconName) assert.ok(icons.includes(`"${b.options.iconName}":`), `아이콘 ${b.options.iconName} 이 있음`);
});

test('자료가 없는 학원: 프로그램 고르기 없이 한 줄 안내', async () => {
  const f = fixture();
  const api = f.view.cloud.api;
  f.view.cloud.api = async (method, route) => (route.startsWith('/api/sync?') ? { academy: { id: 7, apps: [] } } : api(method, route));
  f.calls.length = 0;
  await f.view.init();
  assert.equal(f.view.el.children[2], null);
  assert.equal(f.view.table.children[0].children[0], '이 학원의 학원 자료가 없어요.');
  assert.ok(!f.calls.some((c) => c.route.includes('/academy?')), '목록을 부르지 않음');
});

test('찾기와 더 보기', async () => {
  const many = Array.from({ length: 450 }, (_, i) => ({ path: `books/b${i}/book.json`, rev: 1, size: 1, updatedAt: 1 }));
  const f = fixture({ entries: many });
  await f.view.ready;
  const tbody = () => f.view.table.children[0].children[1];
  assert.equal(tbody().children.length, 200);
  assert.ok(f.view.table.children[1], '더 보기 단추');
  f.view.q = 'b44'; f.view.render();
  assert.deepEqual(tbody().children.map((r) => r.children[0].children[0]), ['books/b44/book.json', ...Array.from({ length: 10 }, (_, i) => `books/b44${i}/book.json`)]);
  f.view.q = '없는것'; f.view.render();
  assert.equal(f.view.table.children[0].children[0], '이 프로그램의 학원 자료가 없어요.');
});

test('지우기: 되돌릴 수 없다고 묻고, 학원·baseRev 를 붙여 지움', async () => {
  const f = fixture({ answers: [false, true] });
  await f.view.ready;
  const file = f.view.entries[0];
  await f.view.act('delete', file);
  assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 0, '취소하면 안 지움');
  await f.view.act('delete', file);
  assert.match(f.dialogs[0].body, /되돌릴 수 없어요/);
  assert.equal(f.dialogs[0].danger, true);
  assert.deepEqual(f.calls.filter((c) => c.method === 'DELETE').map((c) => c.route), ['/api/sync/ohdapnote/academy/file?academy=7&path=books%2Fb1%2Fbook.json&baseRev=3']);
});

test('내려받기·바꾸기는 PC 앱 기능으로, 학원·경로·rev 를 넘김', async () => {
  const f = fixture();
  await f.view.ready;
  await f.view.act('download', f.view.entries[0]);
  await f.view.act('replace', f.view.entries[0]);
  assert.deepEqual(f.native, [['download', 'ohdapnote', 7, 'books/b1/book.json'], ['replace', 'ohdapnote', 7, 'books/b1/book.json', 3]]);
  assert.deepEqual(f.toasts, [{ text: '내려받았어요', kind: 'success' }]);
});

test('오류 문구: 선생님 개인 자료, 먼저 바뀜', async () => {
  const f = fixture();
  await f.view.ready;
  const fail = (status, code) => { f.view.cloud.api = async () => { const e = new Error('서버 오류'); e.status = status; e.code = code; throw e; }; };
  fail(403, 'not_owner');
  await f.view.act('delete', f.view.entries[1]);
  assert.equal(f.toasts.at(-1).text, '선생님 개인 자료는 그 선생님만 고칠 수 있어요.');
  f.view.cloud.academyFileReplace = async () => { const e = new Error('충돌'); e.status = 409; throw e; };
  f.view.cloud.api = async () => ({ entries: [] });
  await f.view.act('replace', f.view.entries[0]);
  assert.equal(f.toasts.at(-1).text, '다른 곳에서 먼저 바뀌었어요. 목록을 새로 불러왔어요.');
});

test('웹에서는 내려받기·바꾸기를 막고, PC 앱 메인은 운영자·학원을 확인', () => {
  const web = fs.readFileSync(path.join(SRC, 'renderer/js/web-cloud.js'), 'utf8');
  const methods = /const APP_ONLY_METHODS = \[([^\]]*)\]/.exec(web)[1];
  assert.match(methods, /'academyFileDownload'/);
  assert.match(methods, /'academyFileReplace'/);
  const main = fs.readFileSync(path.join(SRC, 'main/main.js'), 'utf8');
  for (const channel of ['academy:fileDownload', 'academy:fileReplace']) {
    const start = main.indexOf(`handle('${channel}'`);
    const body = main.slice(start, main.indexOf('  handle(', start + 1));
    assert.match(body, /cloud\.user\?\.role !== 'admin'/);
    assert.match(body, /academy=\$\{encodeURIComponent\(academy\)\}/);
    assert.match(body, /path=\$\{encodeURIComponent\(file\)\}/);
    assert.match(body, /dialog\.show(Save|Open)Dialog\(win,/, '로컬 경로는 메인의 대화 상자에서만 정함');
  }
});
