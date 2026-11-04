// 학생 명단: 담당 선생님이 바뀔 수 있어서 학원 사람(원장·선생님) 누구나 추가·수정·삭제·되살리기
//   삭제한 학생은 정한 기간(기본 30일) 동안 ‘삭제한 학생’에 있다가, 그 학생의 자료와 함께 완전히 지워진다
//   운영자: 학원을 골라서 본다
import { h, ic, btn, busy, toast, dialog, field, input, passwordInput, select, segmented, checkbox, toggle, pill, ago, date, secretDialog, reveal, put } from '../ui.js';
import { editAcademyCode, showCredentials } from '../student-accounts.js';
import { schoolSearch } from '../school-search.js';

const DAY = 24 * 60 * 60 * 1000;
const LEVEL = ['초', '중', '고'];

/** 학년 순서: 초 → 중 → 고, 그 안에서는 숫자 순 (그 밖의 학년은 뒤에) */
function gradeOrder(a, b) {
  const rank = (g) => (LEVEL.includes(g[0]) ? LEVEL.indexOf(g[0]) : LEVEL.length);
  return rank(a) - rank(b) || a.localeCompare(b, 'ko', { numeric: true });
}

function schoolGrade(s) {
  return [s.school, s.grade].filter(Boolean).join(' · ');
}

let pickedAcademy = ''; // 운영자가 마지막에 고른 학원 (학생 명단·학원 AI 가 같이 씀)

/** 운영자: 볼 학원 고르기. ready 는 처음 고른 학원 ID (학원이 없으면 '') */
export function academyPicker(cloud, onChange) {
  const sel = select([['', '학원 불러오는 중']], '', { cls: 'page', style: 'width: 200px' });
  sel.disabled = true;
  sel.addEventListener('change', () => {
    pickedAcademy = sel.value;
    onChange(sel.value);
  });
  const ready = cloud.api('GET', '/api/academies').then((r) => {
    if (!r.academies.length) {
      put(sel, h('option', { value: '' }, '학원이 없어요'));
      return '';
    }
    put(sel, ...r.academies.map((a) => h('option', { value: String(a.id) }, a.name)));
    if (!r.academies.some((a) => String(a.id) === pickedAcademy)) pickedAcademy = String(r.academies[0].id);
    sel.value = pickedAcademy;
    sel.disabled = false;
    return pickedAcademy;
  });
  return { el: sel, ready };
}

export class StudentsView {
  constructor({ cloud, store }) {
    this.cloud = cloud;
    this.store = store;
    const u = store.state.user;
    this.me = u.id;
    this.role = u.role;
    this.isAdmin = u.role === 'admin';
    this.academy = ''; // 운영자가 고른 학원
    this.students = [];
    this.selected = new Set();
    this.members = [];
    this.grades = [];
    this.purgeDays = 30;
    this.loaded = false;
    this.seq = 0;
    this.stamp = store.state.academyStamp;
    this.filter = { who: u.role === 'teacher' ? 'mine' : 'all', grade: '', q: '' };
    this.table = h('div', { class: 'table-wrap' });
    this.count = h('span', { class: 'muted' });
    this.codeButton = ['director', 'admin'].includes(this.role) ? btn('학원 코드 정하기', {
      variant: 'white', disabled: this.isAdmin,
      onClick: () => this.editCode(this.qs()).catch((e) => toast(e.message, 'error')),
    }) : null;
    this.bulk = btn('계정 일괄 생성', { variant: 'soft', title: '학생을 고르면 고른 학생만, 안 고르면 지금 목록에서 계정이 없는 학생 모두에게 만들어요' });
    this.bulk.addEventListener('click', async () => {
      await busy(this.bulk, () => this.bulkAccounts());
      this.updateSelection();
    });
    this.deletedNote = h('div', { class: 'note', style: { marginBottom: '14px', display: 'none' } }, ic('info', 18), h('span'));
    this.gradeSel = select([['', '모든 학년']], '', { cls: 'page', style: 'width: 140px' });
    this.gradeSel.addEventListener('change', () => {
      this.filter.grade = this.gradeSel.value;
      this.render();
    });
    const search = input({ cls: 'page search', placeholder: '이름·학교·메모로 찾기' });
    search.addEventListener('input', () => {
      this.filter.q = search.value.trim().toLowerCase();
      this.render();
    });
    const tabs = [
      ['mine', '내 담당'],
      ['all', '전체'],
      ['deleted', '삭제한 학생'],
    ].filter(([v]) => !(this.isAdmin && v === 'mine')); // 운영자는 담당 학생이 없음
    const toolbar = h('div', { class: 'toolbar' });
    if (this.isAdmin) {
      this.picker = academyPicker(cloud, (id) => {
        this.academy = id;
        this.selected.clear();
        this.loaded = false;
        this.updateSelection();
        put(this.table, h('div', { class: 'empty' }, '학생 명단을 불러오고 있어요.'));
        this.load(true);
      });
      toolbar.append(this.picker.el);
    }
    toolbar.append(
      segmented(
        tabs,
        this.filter.who,
        (v) => {
          this.filter.who = v;
          this.selected.clear();
          this.render(true);
        },
        { onPage: true },
      ),
      this.gradeSel,
      search,
      this.bulk,
      h('div', { class: 'spacer' }),
      this.count,
    );
    const where = this.isAdmin ? '고른 학원의' : `${u.academy?.name || '우리 학원'}`;
    this.el = h(
      'div',
      {},
      h(
        'div',
        { class: 'page-head' },
        h(
          'div',
          { class: 'tt' },
          h('h1', { class: 'title' }, '학생 명단'),
          h('div', { class: 'subtitle' }, `${where} 학생 명단은 오답노트 같은 학원 프로그램이 같이 써요. 담당 선생님이 바뀔 수 있어서 학원 사람 누구나 추가·수정할 수 있어요.`),
        ),
        h('div', { class: 'right' }, this.codeButton, btn('학생 추가', { variant: 'primary', iconName: 'userPlus', onClick: () => this.edit(null) })),
      ),
      toolbar,
      this.deletedNote,
      this.table,
    );
    this.init();
  }

  async init() {
    if (this.picker) {
      try {
        this.academy = await this.picker.ready;
      } catch (e) {
        put(this.table, h('div', { class: 'empty' }, e.message));
        return;
      }
      if (!this.academy) {
        put(this.table, h('div', { class: 'empty' }, ic('building', 40, 1.6), '학원이 없어요. ‘계정 관리’의 ‘학원 관리’에서 먼저 만들어 주세요.'));
        return;
      }
    }
    await this.load();
  }

  qs() {
    return this.academy ? `?academy=${encodeURIComponent(this.academy)}` : '';
  }

  async academyCode(qs) {
    const seq = this.seq;
    const r = await this.cloud.api('GET', `/api/academy${qs}`);
    const code = (r.academy || r).code;
    if (this.codeButton && qs === this.qs() && seq === this.seq) {
      this.codeButton.textContent = code ? `학원 코드 ${code}` : '학원 코드 정하기';
      this.codeButton.disabled = false;
      this.codeFor = qs;
    }
    return code;
  }

  async editCode(qs) {
    const saved = await editAcademyCode(this.cloud, qs);
    if (saved) await this.academyCode(qs);
    return saved;
  }

  // 일괄 생성과 학생 추가가 같은 학원 코드 확인·설정 흐름을 쓴다.
  async ensureAcademyCode(qs, required = false) {
    if (!required && await this.academyCode(qs)) return true;
    if (!['director', 'admin'].includes(this.role)) throw new Error('원장님께 학원 코드 설정을 부탁해 주세요. 명단에서 ‘계정 만들기’로 나중에 만들 수 있어요.');
    return this.editCode(qs);
  }

  async createAccounts(studentIds, qs) {
    try {
      return await this.cloud.api('POST', `/api/students/accounts/bulk${qs}`, { studentIds });
    } catch (e) {
      if (e.code !== 'academy_code_required') throw e;
      if (!(await this.ensureAcademyCode(qs, true))) return null;
      return this.cloud.api('POST', `/api/students/accounts/bulk${qs}`, { studentIds });
    }
  }

  /** animate: 줄이 차례로 올라오게 (처음·학원을 바꿀 때만, 다시 불러올 때는 깜빡이지 않게) */
  async load(animate = false) {
    if (this.isAdmin && !this.academy) return;
    const seq = ++this.seq; // 늦게 온 예전 응답(다른 학원 등)은 버림
    // 학원이 바뀌었을 때만 (다시 불러올 때마다 버튼이 깜빡이지 않게)
    if (this.codeButton && this.codeFor !== this.qs()) {
      this.codeButton.disabled = true;
      this.codeButton.textContent = '학원 코드 불러오는 중';
    }
    try {
      // 코드 조회가 실패해도 학생 명단은 보여 주고, 버튼으로 다시 확인하게 한다.
      const [r, m] = await Promise.all([
        this.cloud.api('GET', `/api/students${this.qs()}`), this.cloud.api('GET', `/api/academy/members${this.qs()}`),
        this.codeButton ? this.academyCode(this.qs()).catch(() => null) : null,
      ]);
      if (seq !== this.seq) return;
      this.students = r.students;
      const activeIds = new Set(this.students.filter((s) => !s.deletedAt).map((s) => s.id));
      for (const id of this.selected) if (!activeIds.has(id)) this.selected.delete(id);
      this.purgeDays = r.purgeDays;
      this.members = m.members;
      const first = !this.loaded;
      this.loaded = true;
      this.render(first || animate);
    } catch (e) {
      if (seq !== this.seq) return;
      this.loaded = false;
      this.count.textContent = '';
      put(this.table, h('div', { class: 'empty' }, e.message));
    } finally {
      // 코드를 못 불러왔으면 눌러서 다시 확인하게
      if (seq === this.seq && this.codeButton?.disabled) {
        this.codeButton.textContent = '학원 코드 확인하기';
        this.codeButton.disabled = false;
      }
    }
  }

  // 같은 메뉴를 다시 누르면 새로 불러옴
  onNav() {
    this.load();
  }

  // 통합 클라우드 앱: 학원 사람이 명단을 고치면 academyStamp 가 바뀜 (웹은 없음)
  update(s) {
    if (s.academyStamp === this.stamp) return;
    this.stamp = s.academyStamp;
    this.load();
  }

  fillGrades(active) {
    const grades = [...new Set(active.map((s) => s.grade).filter(Boolean))].sort(gradeOrder);
    if (this.filter.grade && !grades.includes(this.filter.grade)) this.filter.grade = '';
    const key = grades.join('\n');
    if (key !== this._grades) {
      this._grades = key;
      put(this.gradeSel, h('option', { value: '' }, '모든 학년'), ...grades.map((g) => h('option', { value: g }, g)));
    }
    this.gradeSel.value = this.filter.grade;
    this.grades = grades;
  }

  /** 지금 탭·학년·검색으로 보이는 학생 */
  visible() {
    const f = this.filter;
    const active = this.students.filter((s) => !s.deletedAt);
    let list = f.who === 'deleted' ? this.students.filter((s) => s.deletedAt) : f.who === 'mine' ? active.filter((s) => s.teacher?.id === this.me) : active;
    if (f.grade) list = list.filter((s) => s.grade === f.grade);
    if (f.q) list = list.filter((s) => [s.name, s.school, s.memo].some((t) => String(t || '').toLowerCase().includes(f.q)));
    return list;
  }

  render(animate = false) {
    if (!this.loaded) return;
    const f = this.filter;
    const active = this.students.filter((s) => !s.deletedAt);
    this.fillGrades(active);
    const trash = f.who === 'deleted';
    this.deletedNote.style.display = trash ? '' : 'none';
    this.deletedNote.lastChild.textContent = `삭제한 학생은 ${this.purgeDays}일 동안 여기 있어요. 그 안에는 학원 사람 누구나 되살릴 수 있고, 지나면 그 학생의 자료(오답노트 등)와 함께 완전히 지워져요.`;
    const list = this.visible();
    const filtered = !!(f.grade || f.q);
    this.count.textContent = `${list.length}명`;
    this.updateSelection();
    if (!list.length) {
      const text = filtered
        ? '찾는 학생이 없어요'
        : trash
          ? '삭제한 학생이 없어요'
          : f.who === 'mine' && active.length
            ? '내가 담당인 학생이 없어요. ‘전체’에서 학생을 찾아 담당 선생님을 정할 수 있어요.'
            : '아직 학생이 없어요. ‘학생 추가’를 눌러 넣어 주세요.';
      put(this.table, h('div', { class: 'empty' }, ic(trash ? 'trash' : 'graduationCap', 40, 1.6), text));
      return;
    }
    const all = checkbox('선택', list.every((s) => this.selected.has(s.id)), (on) => {
      for (const s of list) on ? this.selected.add(s.id) : this.selected.delete(s.id);
      this.render();
    });
    all.querySelector('input').indeterminate = list.some((s) => this.selected.has(s.id)) && !list.every((s) => this.selected.has(s.id));
    const head = trash ? ['이름', '학교·학년', '삭제한 사람', '남은 기간', ''] : [all, '이름', '학교·학년', '담당 선생님', '계정', '마지막 수정', ''];
    put(
      this.table,
      h('table', { class: 'table students-table' }, h('thead', {}, h('tr', {}, ...head.map((t) => h('th', {}, t)))), h('tbody', {}, ...list.map((s) => (trash ? this.deletedRow(s) : this.row(s))))),
    );
    if (animate) reveal(this.table.querySelector('tbody'));
  }

  row(s) {
    const mine = s.teacher?.id === this.me;
    const pick = checkbox('', this.selected.has(s.id), (on) => {
      on ? this.selected.add(s.id) : this.selected.delete(s.id);
      this.render();
    });
    pick.querySelector('input').setAttribute('aria-label', `${s.name} 선택`);
    return h(
      'tr',
      {},
      h('td', { class: 'student-select' }, pick),
      h(
        'td',
        { class: 'student-name' },
        h('div', { style: { fontWeight: 600 } }, s.name),
        s.memo ? h('div', { class: 'subtle', title: s.memo, style: { maxWidth: '320px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, s.memo) : null,
      ),
      h('td', {}, schoolGrade(s) || h('span', { class: 'subtle' }, '-')),
      h('td', {}, s.teacher ? h('span', { class: mine ? 'hl' : '' }, s.teacher.name) : h('span', { class: 'subtle' }, '없음')),
      h('td', { class: 'student-account' },
        h('div', { class: 'account-cell' },
          s.account ? h('div', {}, h('div', { class: 'mono selectable' }, s.account.username),
            h('div', { class: 'pills' },
              s.account.status === 'disabled' ? pill('꺼짐', 'grey') : pill('켜짐', 'green'),
              s.account.mustChangePassword ? pill('비밀번호 바꿔야 해요', 'yellow') : null,
            ),
          ) : h('span', { class: 'subtle' }, '없음'),
          btn(s.account ? '계정 관리' : '계정 만들기', { size: 'sm', variant: 'soft', onClick: () => this.account(s) }),
        ),
      ),
      h('td', { class: 'subtle student-updated' }, [s.updatedBy?.name, ago(s.updatedAt)].filter(Boolean).join(' · ')),
      h(
        'td',
        { class: 'acts' },
        btn('', { variant: 'subtle', size: 'sm', iconName: 'edit', title: '고치기', cls: 'student-edit', onClick: () => this.edit(s) }),
        btn('', { variant: 'subtle', size: 'sm', iconName: 'trash', title: '삭제', cls: 'student-remove', onClick: () => this.remove(s) }),
      ),
    );
  }

  // 버튼은 끄지 않음: 못 만들 때는 눌렀을 때 이유를 알려 줌 (삭제한 학생 탭에서는 숨김)
  updateSelection() {
    this.bulk.style.display = this.filter.who === 'deleted' ? 'none' : '';
    this.bulk.textContent = this.selected.size ? `계정 일괄 생성 (${this.selected.size}명)` : '계정 일괄 생성';
  }

  async bulkAccounts() {
    const qs = this.qs();
    if (!this.loaded) {
      toast(this.isAdmin && !this.academy ? '학원을 먼저 골라 주세요.' : '학생 명단을 불러온 뒤에 다시 눌러 주세요.', 'warning');
      return;
    }
    // 고른 학생이 없으면 지금 목록에서 계정이 없는 학생 모두
    const picked = this.selected.size > 0;
    const list = this.visible();
    const studentIds = picked ? [...this.selected] : list.filter((s) => !s.account).map((s) => s.id);
    if (!studentIds.length) {
      toast(list.length ? '지금 목록의 학생은 모두 계정이 있어요.' : '계정을 만들 학생이 없어요. ‘학생 추가’로 학생을 먼저 넣어 주세요.', 'warning', 4000);
      return;
    }
    try {
      if (!(await this.ensureAcademyCode(qs))) return;
      let result;
      const ok = await dialog({
        title: picked ? `${studentIds.length}명의 계정을 만들까요?` : `계정이 없는 학생 ${studentIds.length}명의 계정을 만들까요?`,
        sub: picked
          ? '이미 계정이 있는 학생은 건너뛰어요. 새 임시 비밀번호는 한 번만 보여요.'
          : '고른 학생이 없어서 지금 목록에서 계정이 없는 학생 모두에게 만들어요. 새 임시 비밀번호는 한 번만 보여요.',
        ok: '일괄 생성',
        onOk: async () => {
          result = await this.createAccounts(studentIds, qs);
          if (!result) return false;
        },
      });
      if (!ok || !result) return;
      this.selected.clear();
      this.load();
      await showCredentials(result);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      this.updateSelection();
    }
  }

  async showInvite(r) {
    const url = new URL(this.store.state.config.serverUrl);
    url.hash = `/join?code=${encodeURIComponent(r.code)}`;
    const copy = (label, text, message) => {
      const b = btn(label, { size: 'sm', variant: 'soft' });
      b.addEventListener('click', () => busy(b, async () => {
        try { await this.cloud.copy(text); toast(message, 'success'); } catch (e) { toast(e.message, 'error'); }
      }));
      return b;
    };
    await dialog({ title: '학생 초대 코드를 만들었어요', wide: true, sub:`${date(r.expiresAt, true)}까지 한 번 쓸 수 있어요. 코드는 지금 한 번만 보여요.`,
      body: h('div', {}, h('div', { class: 'secret' }, h('span', { class: 'mono selectable' }, r.code), copy('코드 복사', r.code, '코드를 복사했어요')), h('p', { class: 'selectable', style: { overflowWrap: 'anywhere' } }, url.href)),
      footLeft: copy('가입 주소 복사', url.href, '가입 주소를 복사했어요'), ok: '닫기', cancel: null });
  }

  async account(s) {
    const qs = this.qs();
    const path = `/api/students/${encodeURIComponent(s.id)}`;
    const a = s.account;
    const username = input({ value: a?.username || '', placeholder: '영문 소문자·숫자·._- 3~32자' });
    const password = passwordInput({ placeholder: '6자 이상', autocomplete: 'new-password' });
    const ai = select([['academy', '학원 AI'], ['teacher', '담당 선생님 키']], a?.aiMode || 'academy');
    let active = a?.status !== 'disabled';
    const action = (label, fn, danger = false) => {
      const b = btn(label, { size: 'sm', variant: danger ? 'danger' : 'soft' });
      b.addEventListener('click', () => busy(b, async () => {
        try { await fn(); } catch (e) { toast(e.message, 'error'); }
      }));
      return b;
    };
    let close;
    const refresh = () => { close?.click(); this.load(); };
    const invite = action('초대 코드 만들기', async () => {
      let r;
      const ok = await dialog({ title: `${s.name} 초대 코드를 만들까요?`, sub: '7일 동안 한 번 쓸 수 있어요. 새 코드를 만들면 이전 코드는 쓸 수 없어요.', ok: '만들기', onOk: async () => { r = await this.cloud.api('POST', `${path}/invite${qs}`, {}); } });
      if (!ok || !r) return;
      await this.showInvite(r);
    });
    const revoke = action('초대 코드 취소', async () => {
      await dialog({ title: '초대 코드를 취소할까요?', sub: '이 학생에게 발급한 초대 코드로 더 가입할 수 없어요.', ok: '초대 취소', danger: true,
        onOk: async () => { await this.cloud.api('DELETE', `${path}/invite${qs}`); toast('초대 코드를 취소했어요', 'success'); } });
    });
    const reset = action('비밀번호 초기화', async () => {
      let r;
      const ok = await dialog({ title: `${s.name} 비밀번호를 초기화할까요?`, sub: '로그인한 기기는 로그아웃돼요. 새 임시 비밀번호는 한 번만 보여요.', ok: '초기화', danger: true,
        onOk: async () => { r = await this.cloud.api('PATCH', `${path}/account${qs}`, { resetPassword: true }); } });
      if (!ok || !r) return;
      refresh();
      await secretDialog('임시 비밀번호를 만들었어요', '지금 한 번만 보여요. 학생에게 전달해 주세요. 처음 로그인할 때 바꿔야 해요.', r.password);
    });
    const remove = action('계정 지우기', async () => {
      const ok = await dialog({ title: `${s.name} 계정을 지울까요?`, sub: '학생 명단과 자료는 남고, 로그인 계정만 지워져요.', ok: '계정 지우기', danger: true,
        onOk: () => this.cloud.api('DELETE', `${path}/account${qs}`) });
      if (ok) { refresh(); toast('계정을 지웠어요', 'success'); }
    }, true);
    const shown = dialog({
      title: `${s.name} ${a ? '계정 관리' : '계정 만들기'}`,
      sub: a ? '아이디·사용 여부·과목내비 AI를 바꿀 수 있어요.' : '직접 만들거나 초대 코드로 학생이 아이디·비밀번호를 정하게 해요.',
      body: h('div', {}, field('아이디', username),
        a ? field('계정 켜기', toggle(active, (on) => { active = on; }), '끄면 학생이 로그인할 수 없어요.') : field('비밀번호', password),
        a ? field('마고 과목내비 AI', ai, '담당 선생님 키는 명단의 담당 선생님이 등록한 키를 써요.') : null,
        a ? h('p', { class: 'muted' }, `마지막 로그인: ${a.lastLoginAt ? date(a.lastLoginAt, true) : '아직 없어요'}`) : null,
        h('div', { class: 'toolbar' }, ...(a ? [reset, remove] : [invite, revoke])),
      ),
      ok: a ? '저장' : '직접 만들기', cancel: '닫기',
      onOk: async () => {
        const value = username.value.trim();
        if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(value)) throw new Error('아이디는 영문 소문자·숫자로 시작하고, 영문 소문자·숫자·._-로 3~32자를 넣어 주세요.');
        if (!a && password.input.value.length < 6) throw new Error('비밀번호는 6자 이상 넣어 주세요.');
        await this.cloud.api(a ? 'PATCH' : 'POST', `${path}/account${qs}`, a
          ? { username: value, status: active ? 'active' : 'disabled', aiMode: ai.value }
          : { username: value, password: password.input.value });
        toast(a ? '계정을 저장했어요' : '계정을 만들었어요', 'success');
      },
    });
    close = username.closest('.dialog').querySelector('.dialog-head button');
    await shown;
    password.input.value = '';
    this.load();
  }

  deletedRow(s) {
    const left = Math.max(0, Math.ceil((s.purgeAt - Date.now()) / DAY));
    const back = btn('되살리기', { variant: 'soft', size: 'sm', iconName: 'undo' });
    back.addEventListener('click', () => busy(back, () => this.restore(s)));
    return h(
      'tr',
      {},
      h('td', { class: 'student-name' }, h('div', { style: { fontWeight: 600 } }, s.name)),
      h('td', {}, schoolGrade(s) || h('span', { class: 'subtle' }, '-')),
      h('td', { class: 'subtle' }, [s.deletedBy?.name, ago(s.deletedAt)].filter(Boolean).join(' · ')),
      h('td', {}, pill(left > 0 ? `${left}일 뒤 완전히 삭제` : '곧 완전히 삭제', left <= 3 ? 'red' : 'grey')),
      h('td', { class: 'acts' }, back),
    );
  }

  /** 새 학생의 담당: 선생님이거나 ‘내 담당’을 보고 있으면 나 */
  defaultTeacher() {
    const me = this.members.some((m) => m.id === this.me);
    return me && (this.role === 'teacher' || this.filter.who === 'mine') ? this.me : '';
  }

  async edit(s) {
    const qs = this.qs();
    let base = s; // 고치기 시작한 때의 서버 내용 (다른 사람이 먼저 고치면 바뀜)
    const name = input({ placeholder: '예: 김민준' });
    const school = schoolSearch(this.cloud);
    const grade = input({ placeholder: '예: 중2', list: 'student-grades' });
    const teacher = select([], '');
    const memo = h('textarea', { class: 'input', placeholder: '예: 화·목 수업, 서술형이 약함', style: { minHeight: '84px' } });
    let accountMode = 'later';
    const hints = {
      later: '명단에서 ‘계정 만들기’로 언제든 만들 수 있어요.',
      invite: '학생이 7일 안에 직접 아이디·비밀번호를 정해요.',
      temp: '학원 코드로 아이디를 만들고 임시 비밀번호는 한 번만 보여요. 처음 로그인할 때 바꿔야 해요.',
    };
    const accountField = s ? null : field('계정', segmented([['later', '나중에'], ['invite', '초대 코드'], ['temp', '아이디·임시 비밀번호']], accountMode, (v) => {
      accountMode = v;
      accountField.querySelector('.hint').textContent = hints[v];
    }), hints.later);
    const fill = (st) => {
      name.value = st?.name || '';
      school.fill(st);
      grade.value = st?.grade || '';
      memo.value = st?.memo || '';
      const opts = [['', '없음'], ...this.members.map((m) => [m.id, `${m.name} (${m.roleLabel})`])];
      // 사용 중지된 선생님 등 목록에 없는 담당도 그대로 두기
      if (st?.teacher && !this.members.some((m) => m.id === st.teacher.id)) opts.push([st.teacher.id, st.teacher.name]);
      put(teacher, ...opts.map(([v, label]) => h('option', { value: v }, label)));
      teacher.value = st ? st.teacher?.id || '' : this.defaultTeacher();
    };
    fill(s);
    const values = () => ({ name: name.value.trim(), ...school.value(), grade: grade.value.trim(), teacherId: teacher.value || null, memo: memo.value.trim() });
    let saved = null;
    const ok = await dialog({
      title: s ? `${s.name} 고치기` : '학생 추가',
      sub: s ? '학원 사람 누구나 고칠 수 있어요. 고친 내용은 학원 사람 모두에게 보여요.' : '학원 사람 누구나 이 학생을 보고 고칠 수 있어요. 담당 선생님은 나중에 바꿀 수 있어요.',
      wide: true,
      body: h(
        'div',
        {},
        h('div', { class: 'form-row' }, field('이름', name), field('학년', grade)),
        field('학교', school.el),
        field('담당 선생님', teacher, '담당이 바뀌면 여기서 바꿔 주세요. 담당 선생님은 ‘내 담당’에서 바로 찾을 수 있어요.'),
        field('메모', memo),
        accountField,
        h('datalist', { id: 'student-grades' }, ...this.grades.map((g) => h('option', { value: g }))),
      ),
      ok: s ? '저장' : '추가',
      onOk: async () => {
        const v = values();
        if (!v.name) throw new Error('학생 이름을 입력해 주세요.');
        if (!base) {
          saved = (await this.cloud.api('POST', `/api/students${qs}`, v)).student;
          return;
        }
        // 바꾼 칸만 보낸다
        const cur = { name: base.name, school: base.school || '', schoolOffice: base.schoolOffice || '', schoolCode: base.schoolCode || '', grade: base.grade || '', teacherId: base.teacher?.id || null, memo: base.memo || '' };
        const patch = Object.fromEntries(Object.entries(v).filter(([k, x]) => x !== cur[k]));
        if (!Object.keys(patch).length) return;
        // 같은 교육청 안에서 학교만 바뀌어도 두 코드를 함께 보낸다.
        if (['school', 'schoolOffice', 'schoolCode'].some((k) => k in patch)) {
          Object.assign(patch, school.value());
        }
        try {
          saved = (await this.cloud.api('PATCH', `/api/students/${encodeURIComponent(base.id)}${qs}`, { ...patch, baseRev: base.rev })).student;
        } catch (e) {
          if (e.code === 'conflict' && e.extra?.student) {
            base = e.extra.student;
            this.load();
            if (base.deletedAt) throw new Error('그사이 다른 사람이 이 학생을 삭제했어요. ‘삭제한 학생’에서 되살린 뒤 고쳐 주세요.');
            fill(base);
            throw new Error(`그사이 ${base.updatedBy ? `${base.updatedBy.name}님이` : '다른 사람이'} 먼저 고쳤어요. 고친 내용으로 바꿔 놓았으니, 확인하고 다시 저장해 주세요.`);
          }
          if (e.code === 'student_deleted' || e.code === 'no_student') this.load();
          throw e;
        }
      },
    }).finally(() => school.destroy());
    if (!ok) return;
    // 학생 저장은 끝났으므로 계정 생성 실패로 추가창을 다시 열거나 학생을 다시 만들지 않는다.
    if (!s && saved && accountMode !== 'later') {
      try {
        if (accountMode === 'invite') {
          const r = await this.cloud.api('POST', `/api/students/${encodeURIComponent(saved.id)}/invite${qs}`, {});
          await this.showInvite(r);
        } else {
          const cancelled = '학원 코드 설정을 취소했어요. 명단에서 ‘계정 만들기’로 나중에 만들 수 있어요.';
          if (!(await this.ensureAcademyCode(qs))) throw new Error(cancelled);
          const result = await this.createAccounts([saved.id], qs);
          if (!result) throw new Error(cancelled);
          await showCredentials(result);
        }
      } catch (e) {
        toast(`학생은 추가했어요. 계정은 만들지 못했어요: ${e.message}`, 'error');
      } finally {
        await this.load();
      }
      return;
    }
    if (saved) toast(s ? '저장했어요' : `${saved.name} 학생을 추가했어요`, 'success');
    this.load();
  }

  async remove(s) {
    const ok = await dialog({
      title: `${s.name} 학생을 삭제할까요?`,
      sub: `삭제해도 ${this.purgeDays}일 안에는 누구나 ‘삭제한 학생’에서 되살릴 수 있어요. 그 뒤에는 이 학생의 자료(오답노트 등)도 함께 완전히 지워져요.`,
      ok: '삭제',
      danger: true,
      onOk: () => this.cloud.api('DELETE', `/api/students/${encodeURIComponent(s.id)}${this.qs()}`),
    });
    if (!ok) return;
    toast(`${s.name} 학생을 삭제했어요`, 'success');
    this.load();
  }

  async restore(s) {
    try {
      await this.cloud.api('POST', `/api/students/${encodeURIComponent(s.id)}/restore${this.qs()}`, {});
      toast(`${s.name} 학생을 되살렸어요`, 'success');
      await this.load();
    } catch (e) {
      toast(e.message, 'error');
    }
  }
}
