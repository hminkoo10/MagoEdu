'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 외부 DOM 의존성 없이 실제 UI 도우미·검색 컨트롤·학생 폼 이벤트를 실행한다.
class Node {
  constructor(tagName = '', text = '') {
    this.tagName = tagName.toUpperCase(); this.text = text; this.childNodes = []; this.attrs = {};
    this.events = {}; this.style = {}; this.value = ''; this.hidden = false; this.className = '';
    this.classList = { toggle: (name, on) => { const set = new Set(this.className.split(' ').filter(Boolean)); on ? set.add(name) : set.delete(name); this.className = [...set].join(' '); } };
  }
  get children() { return this.childNodes.filter((x) => x.tagName); }
  matches(selector) { return selector.split(',').some((tag) => this.tagName === tag.trim().toUpperCase()); }
  querySelector(selector) {
    for (const child of this.children) {
      const match = child.matches(selector) ? child : child.querySelector(selector);
      if (match) return match;
    }
    return null;
  }
  get textContent() { return this.text + this.childNodes.map((x) => x.textContent).join(''); }
  set textContent(value) { this.text = value; this.childNodes = []; }
  append(...nodes) { this.childNodes.push(...nodes); }
  replaceChildren(...nodes) { this.childNodes = nodes; this.text = ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); if (k === 'hidden') this.hidden = true; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(k, fn) { (this.events[k] ||= []).push(fn); }
  fire(type, extra = {}) {
    const e = { target: this, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    for (const fn of this.events[type] || []) fn(e);
    return e;
  }
}
const source = (file) => fs.readFileSync(path.join(__dirname, '../src/renderer/js', file), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const hits = [
  { name: '마고중학교', office: 'B10', code: '7010001', region: '서울', kind: '중학교', address: '학교길 1' },
  { name: '마고고등학교', office: 'B10', code: '7010002', region: '서울', kind: '고등학교', address: '학교길 2' },
];
const fields = (s) => ({ school: s.name, schoolOffice: s.office, schoolCode: s.code });
function fixture(t, api = async () => ({ schools: hits }), dialog = async () => false) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const context = vm.createContext({ Node, document: { createElement: (tag) => new Node(tag), createTextNode: (text) => new Node('', text) }, setTimeout, clearTimeout, requestAnimationFrame() {} });
  const ui = vm.runInContext(`${source('ui.js')}\n({ h, input, put, field, select, segmented, appLabel, errorText });`, context);
  const schoolSearch = vm.runInNewContext(`${source('school-search.js')}\nschoolSearch;`, { ...ui, setTimeout, clearTimeout });
  const StudentsView = vm.runInNewContext(`${source('views/students.js')}\nStudentsView;`, { ...ui, schoolSearch, dialog, toast() {} });
  const cloud = { api };
  const control = schoolSearch(cloud);
  const [input, list, status] = control.el.children;
  t.after(() => control.destroy());
  return { control, input, list, status, StudentsView, cloud, ui };
}
const type = (input, text) => { input.value = text; input.fire('input'); };
const find = (el, match) => match(el) ? el : el.children.map((x) => find(x, match)).find(Boolean);

test('학교 검색: 2자·300ms 지연, 결과 라벨, 클릭 선택 후 직접 입력은 코드 삭제', async (t) => {
  const calls = [];
  const f = fixture(t, async (...args) => { calls.push(args); return { schools: hits }; });
  f.control.fill({ school: '기존 학교' });
  assert.equal(f.input.value, '기존 학교');
  type(f.input, '마'); t.mock.timers.tick(300); await settle(); assert.equal(calls.length, 0);
  type(f.input, '마고'); t.mock.timers.tick(200); type(f.input, '마고중');
  t.mock.timers.tick(299); assert.equal(calls.length, 0);
  t.mock.timers.tick(1); await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], '/api/schools/search?q=' + encodeURIComponent('마고중'));
  assert.equal(f.list.children[0].textContent, '마고중학교 · 서울 · 중');
  assert.equal(f.list.children[1].textContent, '마고고등학교 · 서울 · 고');
  f.list.children[0].fire('click');
  assert.deepEqual(plain(f.control.value()), fields(hits[0]));
  assert.equal(f.list.hidden, true);
  type(f.input, '대안학교');
  assert.deepEqual(plain(f.control.value()), { school: '대안학교', schoolOffice: '', schoolCode: '' });
  type(f.input, '');
  assert.deepEqual(plain(f.control.value()), { school: '', schoolOffice: '', schoolCode: '' });
});

test('학교 검색: 방향키 순환·Enter 선택은 폼 저장 안 함, Escape·한글 조합', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return { schools: hits }; });
  f.input.fire('compositionstart'); type(f.input, '마고'); t.mock.timers.tick(300); await settle();
  assert.equal(calls, 0);
  assert.equal(f.input.fire('keydown', { key: 'Enter', isComposing: true }).stopped, true);
  f.input.fire('compositionend'); t.mock.timers.tick(300); await settle();
  f.input.fire('keydown', { key: 'ArrowUp' });
  assert.equal(f.list.children[1].attrs['aria-selected'], 'true');
  f.input.fire('keydown', { key: 'ArrowDown' });
  assert.equal(f.list.children[0].attrs['aria-selected'], 'true');
  const enter = f.input.fire('keydown', { key: 'Enter' });
  assert.ok(enter.prevented && enter.stopped);
  assert.deepEqual(plain(f.control.value()), fields(hits[0]));
  type(f.input, '마고'); t.mock.timers.tick(300); await settle();
  assert.equal(f.input.fire('keydown', { key: 'Escape' }).stopped, true);
  assert.equal(f.list.hidden, true);
  assert.equal(f.input.fire('keydown', { key: 'Escape' }).stopped, false, '목록 닫은 뒤 Escape는 대화상자로');
});

test('학교 검색: 늦은 응답·닫힌 폼 무시, 실패·빈 결과에도 자유 입력 보존', async (t) => {
  const pending = [];
  const f = fixture(t, () => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  type(f.input, '마고'); t.mock.timers.tick(300);
  type(f.input, '다른학교'); t.mock.timers.tick(300);
  pending[0].resolve({ schools: hits }); await settle();
  assert.equal(f.list.hidden, true);
  pending[1].reject(new Error('학교 검색 서버에 연결하지 못했어요.')); await settle();
  assert.match(f.status.textContent, /입력한 이름으로 저장/);
  assert.deepEqual(plain(f.control.value()), { school: '다른학교', schoolOffice: '', schoolCode: '' });
  type(f.input, '대안학교'); t.mock.timers.tick(300);
  pending[2].resolve({ schools: [] }); await settle();
  assert.match(f.status.textContent, /검색 결과가 없어요/);
  type(f.input, '마고'); t.mock.timers.tick(300);
  f.control.destroy(); pending[3].resolve({ schools: hits }); await settle();
  assert.equal(f.list.hidden, true);
});

test('학생 추가 폼: 검색 선택한 학교 이름·교육청·코드를 POST로 저장', async (t) => {
  const calls = [];
  const f = fixture(t, async (method, url, body) => {
    calls.push({ method, url, body });
    return method === 'GET' ? { schools: hits } : { student: { id: 'new', ...body } };
  }, async (d) => {
    find(d.body, (e) => e.attrs.placeholder === '예: 김민준').value = '김학생';
    const input = find(d.body, (e) => e.attrs.role === 'combobox');
    type(input, '마고'); t.mock.timers.tick(300); await settle();
    find(d.body, (e) => e.attrs.role === 'listbox').children[0].fire('click');
    await d.onOk();
    return true;
  });
  const view = Object.assign(Object.create(f.StudentsView.prototype), { cloud: f.cloud, members: [], grades: [], defaultTeacher: () => '', qs: () => '?academy=1', load() {} });
  await view.edit();
  assert.deepEqual(plain(calls.at(-1)), { method: 'POST', url: '/api/students?academy=1', body: { name: '김학생', ...fields(hits[0]), grade: '', teacherId: null, memo: '' } });
});

test('학생 수정 폼: 기존 코드 표시, 같은 교육청의 다른 학교 선택·이름 삭제 PATCH도 코드 쌍 포함', async (t) => {
  const saved = { id: 'student-1', name: '김학생', ...fields(hits[0]), grade: '', memo: '', rev: 3 };
  const calls = [];
  let clear = false;
  const f = fixture(t, async (method, url, body) => {
    calls.push({ method, url, body });
    return method === 'GET' ? { schools: hits } : { student: { ...saved, ...body } };
  }, async (d) => {
    const input = find(d.body, (e) => e.attrs.role === 'combobox');
    assert.equal(input.value, saved.school);
    if (clear) type(input, '');
    else {
      type(input, '마고'); t.mock.timers.tick(300); await settle();
      find(d.body, (e) => e.attrs.role === 'listbox').children[1].fire('click');
    }
    await d.onOk();
    return true;
  });
  const view = Object.assign(Object.create(f.StudentsView.prototype), { cloud: f.cloud, members: [], grades: [], qs: () => '', load() {}, account: async () => ({ el: f.ui.h('section'), save: async () => {} }) });
  await view.edit(saved);
  assert.deepEqual(plain(calls.at(-1)), { method: 'PATCH', url: '/api/students/student-1', body: { ...fields(hits[1]), baseRev: 3 } });
  clear = true;
  await view.edit(saved);
  assert.deepEqual(plain(calls.at(-1).body), { school: '', schoolOffice: '', schoolCode: '', baseRev: 3 });
});

test('동일한 앱 이름은 권한·용량·AI 목록에서 웹/PC 구분', (t) => {
  const { ui } = fixture(t);
  assert.equal(ui.appLabel({ name: '마고 과목내비', platform: 'web' }), '마고 과목내비 · 웹');
  assert.equal(ui.appLabel({ name: '마고 과목내비', platform: 'windows' }), '마고 과목내비 · PC');
});
