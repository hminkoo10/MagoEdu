 'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(role = 'director', answers = [true, true]) {
  const buttons = [], dialogs = [], calls = [];
  const el = () => ({ style: {}, append() {}, addEventListener() {}, querySelector: () => el() });
  const context = { Set, Map, Date, console, encodeURIComponent,
    h: el, ic: el, input: el, select: el, segmented: el,
    btn: (label, options) => { const b = { ...el(), label, options }; buttons.push(b); return b; },
    dialog: async (options) => { dialogs.push(options); return answers.shift(); },
    toast() {}, errorText: (e) => { throw e; }, put() {},
  };
  let source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/views/students.js'), 'utf8');
  source = source.replace(/^import .*;$/gm, '').replace(/export /g, '');
  vm.runInNewContext(source + '\nthis.StudentsView = StudentsView;', context);
  context.StudentsView.prototype.init = () => {};
  const cloud = { api: async (method, route, body) => {
    calls.push({ method, route, body });
    if (route === '/api/academies') return { academies: [] };
    return { students: 3, files: 120 };
  } };
  const view = new context.StudentsView({ cloud, store: { state: { user: { id: 'me', role } } } });
  view.students = [{ id: 'one', deletedAt: 1 }, { id: 'two', deletedAt: 1 }, { id: 'active' }];
  view.selected.add('one'); view.selected.add('active'); view.load = async () => calls.push({ reload: true });
  return { view, buttons, dialogs, calls };
}

test('완전 삭제 단추: 원장·운영자만, 삭제한 학생 탭에서만', () => {
  for (const role of ['director', 'admin', 'teacher']) {
    const { view, buttons } = fixture(role);
    const deletion = buttons.filter((b) => ['삭제', '모두 삭제'].includes(b.label));
    assert.equal(deletion.length, role === 'teacher' ? 0 : 2);
    view.filter.who = 'all'; view.updateSelection();
    for (const b of deletion) assert.equal(b.style.display, 'none');
    view.filter.who = 'deleted'; view.updateSelection();
    for (const b of deletion) { assert.equal(b.style.display, ''); assert.equal(b.options.iconName, 'trash'); }
  }
});

test('선택 삭제: 실제 수·짧은 확인 문구·활성 학생 제외·한 번 확인', async () => {
  const { view, dialogs, calls } = fixture(); await view.purgeDeleted(false);
  assert.equal(dialogs.length, 1); assert.equal(dialogs[0].title, '완전히 삭제할까요?');
  assert.equal(dialogs[0].sub, '학생 3명과 자료 120개를 지워요. 되돌릴 수 없어요.');
  assert.equal(JSON.stringify(calls[0].body), JSON.stringify({ ids: ['one'] }));
  assert.equal(calls[1].route, '/api/students/purge');
});

test('모두 삭제: 두 번 확인, 어느 확인이든 취소하면 삭제 요청 없음', async () => {
  for (const answers of [[false], [true, false], [true, true]]) {
    const expected = answers.every(Boolean), { view, dialogs, calls } = fixture('director', [...answers]);
    await view.purgeDeleted(true);
    assert.equal(dialogs.length, answers.length);
    assert.equal(calls.some((c) => c.route === '/api/students/purge'), expected);
    assert.equal(JSON.stringify(calls[0].body), JSON.stringify({ all: true }));
  }
});
