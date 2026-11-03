// 학생 명단: 담당 선생님이 바뀔 수 있어서 학원 사람(원장·선생님) 누구나 추가·수정·삭제·되살리기
//   삭제한 학생은 정한 기간(기본 30일) 동안 ‘삭제한 학생’에 있다가, 그 학생의 자료와 함께 완전히 지워진다
//   운영자: 학원을 골라서 본다
import { h, ic, btn, busy, toast, dialog, field, input, select, segmented, pill, ago, reveal, put } from '../ui.js';

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
    this.members = [];
    this.grades = [];
    this.purgeDays = 30;
    this.loaded = false;
    this.seq = 0;
    this.stamp = store.state.academyStamp;
    this.filter = { who: u.role === 'teacher' ? 'mine' : 'all', grade: '', q: '' };
    this.table = h('div', { class: 'table-wrap' });
    this.count = h('span', { class: 'muted' });
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
          this.render(true);
        },
        { onPage: true },
      ),
      this.gradeSel,
      search,
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
        h('div', { class: 'right' }, btn('학생 추가', { variant: 'primary', iconName: 'userPlus', onClick: () => this.edit(null) })),
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

  /** animate: 줄이 차례로 올라오게 (처음·학원을 바꿀 때만, 다시 불러올 때는 깜빡이지 않게) */
  async load(animate = false) {
    if (this.isAdmin && !this.academy) return;
    const seq = ++this.seq; // 늦게 온 예전 응답(다른 학원 등)은 버림
    try {
      const [r, m] = await Promise.all([this.cloud.api('GET', `/api/students${this.qs()}`), this.cloud.api('GET', `/api/academy/members${this.qs()}`)]);
      if (seq !== this.seq) return;
      this.students = r.students;
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

  render(animate = false) {
    if (!this.loaded) return;
    const f = this.filter;
    const active = this.students.filter((s) => !s.deletedAt);
    const deleted = this.students.filter((s) => s.deletedAt);
    this.fillGrades(active);
    const trash = f.who === 'deleted';
    this.deletedNote.style.display = trash ? '' : 'none';
    this.deletedNote.lastChild.textContent = `삭제한 학생은 ${this.purgeDays}일 동안 여기 있어요. 그 안에는 학원 사람 누구나 되살릴 수 있고, 지나면 그 학생의 자료(오답노트 등)와 함께 완전히 지워져요.`;
    let list = trash ? deleted : f.who === 'mine' ? active.filter((s) => s.teacher?.id === this.me) : active;
    const filtered = !!(f.grade || f.q);
    if (f.grade) list = list.filter((s) => s.grade === f.grade);
    if (f.q) list = list.filter((s) => [s.name, s.school, s.memo].some((t) => String(t || '').toLowerCase().includes(f.q)));
    this.count.textContent = `${list.length}명`;
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
    const head = trash ? ['이름', '학교·학년', '삭제한 사람', '남은 기간', ''] : ['이름', '학교·학년', '담당 선생님', '마지막 수정', ''];
    put(
      this.table,
      h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ...head.map((t) => h('th', {}, t)))), h('tbody', {}, ...list.map((s) => (trash ? this.deletedRow(s) : this.row(s))))),
    );
    if (animate) reveal(this.table.querySelector('tbody'));
  }

  row(s) {
    const mine = s.teacher?.id === this.me;
    return h(
      'tr',
      {},
      h(
        'td',
        {},
        h('div', { style: { fontWeight: 600 } }, s.name),
        s.memo ? h('div', { class: 'subtle', title: s.memo, style: { maxWidth: '320px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, s.memo) : null,
      ),
      h('td', {}, schoolGrade(s) || h('span', { class: 'subtle' }, '-')),
      h('td', {}, s.teacher ? h('span', { class: mine ? 'hl' : '' }, s.teacher.name) : h('span', { class: 'subtle' }, '없음')),
      h('td', { class: 'subtle' }, [s.updatedBy?.name, ago(s.updatedAt)].filter(Boolean).join(' · ')),
      h(
        'td',
        { class: 'acts' },
        btn('', { variant: 'subtle', size: 'sm', iconName: 'edit', title: '고치기', onClick: () => this.edit(s) }),
        btn('', { variant: 'subtle', size: 'sm', iconName: 'trash', title: '삭제', onClick: () => this.remove(s) }),
      ),
    );
  }

  deletedRow(s) {
    const left = Math.max(0, Math.ceil((s.purgeAt - Date.now()) / DAY));
    const back = btn('되살리기', { variant: 'soft', size: 'sm', iconName: 'undo' });
    back.addEventListener('click', () => busy(back, () => this.restore(s)));
    return h(
      'tr',
      {},
      h('td', {}, h('div', { style: { fontWeight: 600 } }, s.name)),
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
    let base = s; // 고치기 시작한 때의 서버 내용 (다른 사람이 먼저 고치면 바뀜)
    const name = input({ placeholder: '예: 김민준' });
    const school = input({ placeholder: '예: 마고중학교' });
    const grade = input({ placeholder: '예: 중2', list: 'student-grades' });
    const teacher = select([], '');
    const memo = h('textarea', { class: 'input', placeholder: '예: 화·목 수업, 서술형이 약함', style: { minHeight: '84px' } });
    const fill = (st) => {
      name.value = st?.name || '';
      school.value = st?.school || '';
      grade.value = st?.grade || '';
      memo.value = st?.memo || '';
      const opts = [['', '없음'], ...this.members.map((m) => [m.id, `${m.name} (${m.roleLabel})`])];
      // 사용 중지된 선생님 등 목록에 없는 담당도 그대로 두기
      if (st?.teacher && !this.members.some((m) => m.id === st.teacher.id)) opts.push([st.teacher.id, st.teacher.name]);
      put(teacher, ...opts.map(([v, label]) => h('option', { value: v }, label)));
      teacher.value = st ? st.teacher?.id || '' : this.defaultTeacher();
    };
    fill(s);
    const values = () => ({ name: name.value.trim(), school: school.value.trim(), grade: grade.value.trim(), teacherId: teacher.value || null, memo: memo.value.trim() });
    let saved = null;
    const ok = await dialog({
      title: s ? `${s.name} 고치기` : '학생 추가',
      sub: s ? '학원 사람 누구나 고칠 수 있어요. 고친 내용은 학원 사람 모두에게 보여요.' : '학원 사람 누구나 이 학생을 보고 고칠 수 있어요. 담당 선생님은 나중에 바꿀 수 있어요.',
      wide: true,
      body: h(
        'div',
        {},
        h('div', { class: 'form-row' }, field('이름', name), field('학년', grade)),
        field('학교', school),
        field('담당 선생님', teacher, '담당이 바뀌면 여기서 바꿔 주세요. 담당 선생님은 ‘내 담당’에서 바로 찾을 수 있어요.'),
        field('메모', memo),
        h('datalist', { id: 'student-grades' }, ...this.grades.map((g) => h('option', { value: g }))),
      ),
      ok: s ? '저장' : '추가',
      onOk: async () => {
        const v = values();
        if (!v.name) throw new Error('학생 이름을 입력해 주세요.');
        if (!base) {
          saved = (await this.cloud.api('POST', `/api/students${this.qs()}`, v)).student;
          return;
        }
        // 바꾼 칸만 보낸다
        const cur = { name: base.name, school: base.school || '', grade: base.grade || '', teacherId: base.teacher?.id || null, memo: base.memo || '' };
        const patch = Object.fromEntries(Object.entries(v).filter(([k, x]) => x !== cur[k]));
        if (!Object.keys(patch).length) return;
        try {
          saved = (await this.cloud.api('PATCH', `/api/students/${encodeURIComponent(base.id)}${this.qs()}`, { ...patch, baseRev: base.rev })).student;
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
    });
    if (!ok) return;
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
