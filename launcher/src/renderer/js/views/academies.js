import { errorText, h, ic, btn, toast, dialog, field, input, bytes, subjectChecks, subjectText, confirmDialog, put } from '../ui.js';
import { editAcademyCode } from '../student-accounts.js';
import { AcademyAiView } from './academy-ai.js';
import { CodesView } from './codes.js';

class AcademyActions {
  async loadAcademies() {
    this.academies = (await this.cloud.api('GET', '/api/academies')).academies;
  }
  controls(a) {
    const edit = btn('이름 바꾸기', { variant: 'subtle', size: 'sm', iconName: 'edit' });
    edit.addEventListener('click', async () => {
      const name = input({ value: a.name });
      const ok = await dialog({ title: '학원 이름 바꾸기', body: field('학원 이름', name), ok: '저장', onOk: () => this.cloud.api('PATCH', `/api/academies/${a.id}`, { name: name.value }) });
      if (ok) {
        await this.loadAcademies();
        await this.load();
      }
    });
    const quota = btn('학원 공간 용량', { variant: 'subtle', size: 'sm', iconName: 'drive' });
    quota.addEventListener('click', async () => {
      const q = input({ type: 'number', min: '0', value: a.quotaMb ?? '', placeholder: '비우면 기본값' });
      const ok = await dialog({
        title: `${a.name} 학원 공간 용량`,
        sub: `학원 공용 공간 · ${bytes(a.usageBytes)} 사용 중`,
        body: field('한도 (MB)', q, '0 이면 제한 없음, 비우면 서버 기본값'),
        ok: '저장',
        onOk: () => this.cloud.api('PATCH', `/api/academies/${a.id}`, { quotaMb: q.value === '' ? null : Number(q.value) }),
      });
      if (ok) {
        await this.loadAcademies();
        await this.load();
      }
    });
    const del = btn('지우기', { variant: 'subtle', size: 'sm', iconName: 'trash' });
    del.addEventListener('click', async () => {
      try {
        const count = await this.cloud.api('GET', `/api/academies/${a.id}/delete-preview`);
        const sub = `계정 ${count.accounts}명, 학생 ${count.students}명과 자료 ${count.files}개를 지워요. 되돌릴 수 없어요.`;
        if (!(await dialog({ title: '완전히 삭제할까요?', sub, ok: '삭제', okIcon: 'trash', cancelIcon: 'x', danger: true }))) return;
        if (!(await dialog({ title: `${a.name} 학원을 삭제할까요?`, sub, ok: '학원 삭제', okIcon: 'trash', cancelIcon: 'x', danger: true }))) return;
        await this.cloud.api('DELETE', `/api/academies/${a.id}`);
        await this.loadAcademies();
        await this.load();
      } catch (e) {
        toast(errorText(e), 'error');
      }
    });
    const subjects = btn('과목', { variant: 'subtle', size: 'sm', iconName: 'edit' });
    subjects.addEventListener('click', async () => {
      const checks = subjectChecks(a.subjects);
      const ok = await dialog({
        title: `${a.name} 계약 과목`,
        sub: '선택한 과목만 새 교재를 등록해요. 기존 교재는 유지돼요.',
        body: field('계약 과목', checks.el),
        ok: '저장',
        onOk: async () => {
          const selected = checks.value();
          if (!selected.length && !(await confirmDialog('과목을 하나도 고르지 않았어요.', '이 학원은 새 교재를 등록할 수 없어요.', '저장'))) return false;
          await this.cloud.api('PATCH', `/api/academies/${a.id}`, { subjects: selected });
        },
      });
      if (ok) {
        await this.loadAcademies();
        await this.load();
      }
    });
    return { edit, quota, del, subjects };
  }
}

export class AcademiesView extends AcademyActions {
  constructor({ cloud, store, go, opts = {} }) {
    super(); Object.assign(this, { cloud, store, go });
    this.table = h('div', { class: 'table-wrap' });
    this.codes = new CodesView({ cloud });
    this.codes.el = h('section', { id: 'signup-codes', class: 'card' }, h('h2', { class: 'card-title' }, ic('ticket', 18), '가입 코드'), this.codes.table);
    this.el = h('div', {}, h('div', { class: 'page-head' }, h('div', { class: 'tt' }, h('h1', { class: 'title' }, '학원')), h('div', { class: 'right' },
      btn('가입 코드 만들기', { iconName: 'ticket', onClick: () => this.codes.create() }),
      btn('학원 추가', { variant: 'primary', iconName: 'plus', onClick: () => this.createAcademy() }))),
      h('div', { class: 'stack' }, this.table, this.codes.el));
    this.load();
    if (opts.section === 'codes') queueMicrotask(() => this.codes.el.scrollIntoView({ block: 'start' }));
  }
  onNav(opts = {}) {
    this.load(); this.codes.load();
    if (opts.section === 'codes') this.codes.el.scrollIntoView({ block: 'start' });
  }
  async createAcademy() {
    const name = input({ placeholder: '새 학원 이름' });
    const subjects = subjectChecks();
    const ok = await dialog({ title: '학원 추가', body: h('div', {}, field('새 학원 이름', name), field('계약 과목', subjects.el)), ok: '추가',
      onOk: () => this.cloud.api('POST', '/api/academies', { name: name.value, subjects: subjects.value() }) });
    if (ok) await this.load();
  }
  async load() {
    try {
      await this.loadAcademies();
      put(this.table, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ...['학원 이름', '과목', '원장·선생님 수', '학원 공간', '동작'].map((t) => h('th', {}, t)))),
        h('tbody', {}, ...this.academies.map((a) => {
          const { del } = this.controls(a);
          return h('tr', {}, h('td', {}, a.name), h('td', {}, subjectText(a.subjects)), h('td', {}, `원장 ${a.directors}명 · 선생님 ${a.teachers}명`),
            h('td', {}, `${bytes(a.usageBytes)} / ${a.quotaBytes ? bytes(a.quotaBytes) : '제한 없음'}`),
            h('td', { class: 'acts' }, btn('학원 설정', { iconName: 'building', size: 'sm', onClick: () => this.go('academy-settings', { academy: a.id, force: true }) }), del));
        }))));
    } catch (e) { put(this.table, h('div', { class: 'empty' }, errorText(e))); }
  }
}

export class AcademySettingsView extends AcademyActions {
  constructor({ cloud, store, go, opts = {} }) {
    super(); Object.assign(this, { cloud, store, go, opts });
    this.isAdmin = store.state.user.role === 'admin';
    this.el = h('div');
    this.load();
  }
  async load() {
    try {
      let a;
      if (this.isAdmin) {
        await this.loadAcademies();
        a = this.academies.find((a) => String(a.id) === String(this.opts.academy));
        if (!a) { this.go('academies'); return; }
      } else {
        a = (await this.cloud.api('GET', '/api/academy')).academy;
        const storage = await this.cloud.refreshStorage();
        a = { ...this.store.state.user.academy, ...a, ...storage.academy };
      }
      const controls = this.controls(a);
      const rename = this.isAdmin ? controls.edit : btn('바꾸기', { iconName: 'edit', size: 'sm', onClick: async () => {
        const name = input({ value: a.name });
        const ok = await dialog({ title: '학원 이름 바꾸기', body: field('학원 이름', name), ok: '저장', onOk: () => this.cloud.api('PATCH', `/api/academies/${a.id}`, { name: name.value }) });
        if (ok) { await this.cloud.refreshMe(); toast('학원 이름을 바꿨어요', 'success'); await this.load(); }
      } });
      const qs = this.isAdmin ? `?academy=${encodeURIComponent(a.id)}` : '';
      const academy = (await this.cloud.api('GET', `/api/academy${qs}`)).academy;
      const code = btn(academy?.code ? '바꾸기' : '정하기', { iconName: 'edit', size: 'sm', onClick: async () => { if (await editAcademyCode(this.cloud, qs)) await this.load(); } });
      this.ai?.destroy?.();
      this.ai = new AcademyAiView({ cloud: this.cloud, store: this.store, academy: this.isAdmin ? a.id : null });
      put(this.el,
        h('div', { class: 'page-head' }, h('h1', { class: 'title' }, this.isAdmin ? `${a.name} · 학원 설정` : '학원 설정')),
        h('div', { class: 'stack' },
          h('section', { class: 'card' }, h('h2', { class: 'card-title' }, ic('building', 18), '학원 정보'),
            h('div', { class: 'row' }, h('div', { class: 'grow' }, a.name), rename),
            h('div', { class: 'row' }, h('div', { class: 'grow' }, `학원 코드 ${academy?.code || '없음'}`), code),
            h('div', { class: 'row' }, h('div', { class: 'grow' }, `계약 과목 · ${subjectText(a.subjects)}`), this.isAdmin ? controls.subjects : null),
            this.isAdmin ? null : h('p', { class: 'card-desc' }, '과목 변경은 운영자에게 문의하세요.')),
          h('section', { class: 'card' }, h('h2', { class: 'card-title' }, ic('drive', 18), '학원 공간'),
            h('div', { class: 'row' }, h('div', { class: 'grow' }, `${bytes(a.usageBytes)} / ${a.quotaBytes ? bytes(a.quotaBytes) : '제한 없음'}`), this.isAdmin ? controls.quota : null)),
          this.ai.el,
          this.isAdmin ? btn('학원 지우기', { iconName: 'trash', variant: 'danger', onClick: () => controls.del.click() }) : null));
      if (this.opts.section === 'academy-ai') this.ai.el.scrollIntoView({ block: 'start' });
      controls.edit.replaceChildren(ic('edit', 16), '바꾸기');
      controls.subjects.replaceChildren(ic('edit', 16), '바꾸기');
      controls.quota.replaceChildren(ic('drive', 16), '용량 바꾸기');
      for (const b of [controls.edit, controls.subjects, controls.quota]) b.classList.remove('subtle');
    } catch (e) { put(this.el, h('div', { class: 'empty' }, errorText(e))); }
  }
  update(s) { this.ai?.update(s); }
  onNav(opts = {}) {
    this.opts.section = opts.section;
    if (opts.section === 'academy-ai') this.ai?.el.scrollIntoView({ block: 'start' });
  }
  destroy() { this.ai?.destroy?.(); }
}
