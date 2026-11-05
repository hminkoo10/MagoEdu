import { errorText, h, ic, btn, busy, toast, field, input, passwordInput, pill, date, put } from '../ui.js';
import { downloadBlob } from '../student-accounts.js';

// 학생은 웹 전용. 공개 아이콘 경로로 카탈로그의 원본을 쓰며 프로그램 목록 권한은 필요 없다.
function naviIcon(size) {
  return h('img', { src: '/api/apps/mago-navi/icon?logo=pc', alt: '', width: size, height: size, style: { flex: 'none' } });
}

export class StudentNotesView {
  constructor({ cloud }) {
    this.cloud = cloud;
    this.seq = 0;
    this.list = h('div', { class: 'table-wrap' });
    const reload = btn('새로 고침', { iconName: 'rotate' });
    reload.addEventListener('click', () => busy(reload, () => this.load()));
    this.el = h('div', {},
      h('div', { class: 'page-head' }, h('div', { class: 'tt' }, h('h1', { class: 'title' }, '내 오답노트'), h('div', { class: 'subtitle' }, '답지는 선생님이 허용한 노트에만 포함돼요.')), h('div', { class: 'right' }, reload)),
      this.list,
    );
    this.load();
  }

  async load() {
    const seq = ++this.seq;
    put(this.list, h('div', { class: 'empty' }, '오답노트를 불러오고 있어요.'));
    try {
      const notes = await this.cloud.api('GET', '/api/me/notes');
      if (seq !== this.seq) return;
      if (!notes.length) return put(this.list, h('div', { class: 'empty' }, ic('list', 40), '아직 내 오답노트가 없어요.'));
      put(this.list, h('table', { class: 'table notes-table' },
        h('thead', {}, h('tr', {}, ...['노트', '문항', '마지막 수정', '답지', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, ...notes.map((note) => {
          const open = btn('PDF 보기', { size: 'sm', variant: 'soft', iconName: 'external' });
          const save = btn('PDF 받기', { size: 'sm', iconName: 'download' });
          open.addEventListener('click', () => busy(open, () => this.pdf(note, false)));
          save.addEventListener('click', () => busy(save, () => this.pdf(note, true)));
          return h('tr', {}, h('td', { class: 'note-name' }, note.title), h('td', {}, `${note.problemCount}문항`), h('td', {}, date(note.updatedAt, true)),
            h('td', {}, pill(note.answersAllowed ? '답지 포함' : '문제만', note.answersAllowed ? 'green' : 'grey')), h('td', { class: 'acts' }, open, save));
        })),
      ));
    } catch (e) {
      if (seq === this.seq) put(this.list, h('div', { class: 'empty' }, errorText(e)));
    }
  }

  async pdf(note, download) {
    let tab = null;
    try {
      if (!download) {
        tab = window.open('about:blank', '_blank');
        if (!tab) throw new Error('새 탭을 열지 못했어요. 팝업을 허용하거나 PDF 받기를 눌러 주세요.');
        tab.opener = null;
        tab.document.title = note.title;
        tab.document.body.textContent = 'PDF를 준비하고 있어요.';
      }
      const blob = await this.cloud.studentNotePdf(note.id);
      if (download) downloadBlob(blob, `${(note.title || '오답노트').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.pdf`);
      else if (!tab.closed) {
        const url = URL.createObjectURL(blob);
        tab.location.replace(url);
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } catch (e) {
      tab?.close();
      toast(errorText(e), 'error');
    }
  }

  onNav() { this.load(); }
  destroy() { this.seq += 1; }
}

export class StudentNaviView {
  constructor({ cloud, store }) {
    const user = store.state.user;
    const open = btn('열기', { variant: 'primary', iconName: 'external', onClick: () => cloud.openExternal('https://magonavi.milky.kr').catch((e) => toast(errorText(e), 'error')) });
    this.el = h('div', {},
      h('div', { class: 'page-head' }, h('div', { class: 'tt' }, h('h1', { class: 'title' }, '마고 과목내비'), h('div', { class: 'subtitle' }, '내 과목과 진로를 살펴봐요.'))),
      h('div', { class: 'apps-grid' }, h('div', { class: 'app-card' },
        h('div', { class: 'app-head' }, h('div', { class: 'app-icon', style: { background: '#fff' } }, naviIcon(56)), h('div', {}, h('div', { class: 'app-name' }, '마고 과목내비'), h('div', { class: 'app-ver' }, '웹 프로그램'))),
        h('div', { class: 'app-desc' }, user.aiMode === 'teacher' ? `담당 선생님 키를 써요.${user.student?.teacherName ? ` 담당: ${user.student.teacherName} 선생님` : ''}` : '학원 AI를 써요.'),
        h('div', { class: 'app-foot' }, h('div', { class: 'sync' }, ic('globe', 15), '새 탭에서 열어요'), open),
      )),
    );
  }
}

export class StudentJoinView {
  constructor({ cloud, code = '', verified = null, back }) {
    const invite = input({ value: code, placeholder: '선생님께 받은 초대 코드', autocomplete: 'off' });
    const username = input({ placeholder: '영문 소문자·숫자·._- 3~32자', autocomplete: 'username' });
    const password = passwordInput({ placeholder: '6자 이상', autocomplete: 'new-password' });
    const again = passwordInput({ placeholder: '한 번 더', autocomplete: 'new-password' });
    const info = h('div');
    const fields = h('div', { style: { display: 'none' } }, field('아이디', username), field('비밀번호', password), field('비밀번호 확인', again));
    const error = h('div', { class: 'error-text', style: { display: 'none' } });
    const check = btn('초대 확인', { variant: 'soft' });
    const join = btn('가입하기', { variant: 'primary', size: 'lg', cls: 'block', disabled: true });
    let checkedCode = null;
    const showAccount = (r, value) => {
      checkedCode = value;
      put(info, h('div', { class: 'note', style: { margin: '16px 0' } }, `${r.academyName} · ${r.studentName} 학생이 맞는지 확인해 주세요.`));
      fields.style.display = '';
      join.disabled = false;
    };
    invite.addEventListener('input', () => { checkedCode = null; join.disabled = true; fields.style.display = 'none'; put(info); });
    const showError = (e) => { error.textContent = errorText(e); error.style.display = ''; };
    check.addEventListener('click', () => busy(check, async () => {
      checkedCode = null;
      join.disabled = true;
      fields.style.display = 'none';
      put(info);
      error.style.display = 'none';
      const value = invite.value.trim();
      try {
        if (!value) throw new Error('초대 코드를 넣어 주세요.');
        const r = await cloud.checkStudentInvite(value);
        if (value !== invite.value.trim()) return;
        showAccount(r, value);
      } catch (e) { showError(e); }
    }));
    join.addEventListener('click', () => busy(join, async () => {
      error.style.display = 'none';
      try {
        if (!checkedCode || checkedCode !== invite.value.trim()) throw new Error('초대 코드를 먼저 확인해 주세요.');
        if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username.value.trim())) throw new Error('아이디는 영문 소문자·숫자로 시작하고, 영문 소문자·숫자·._-로 3~32자를 넣어 주세요.');
        if (password.input.value.length < 6) throw new Error('비밀번호는 6자 이상 넣어 주세요.');
        if (password.input.value !== again.input.value) throw new Error('비밀번호가 서로 달라요.');
        await cloud.joinStudent({ code: checkedCode, username: username.value.trim(), password: password.input.value });
        password.input.value = again.input.value = '';
        toast('가입했어요. 내 오답노트에서 시작해요.', 'success');
      } catch (e) { showError(e); }
    }));
    this.el = h('div', {}, verified ? null : [field('학생 초대 코드', invite), check], info, fields, error, h('div', { style: { height: '20px' } }), join,
      h('div', { class: 'auth-links' }, h('button', { class: 'link', onClick: back }, '로그인으로 돌아가기')));
    if (verified) showAccount(verified, code);
    else if (code) check.click();
  }
}
