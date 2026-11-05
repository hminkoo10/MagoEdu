// 활동 기록 (운영자): 누가 언제 계정을 만들고 지웠는지, 코드를 만들었는지 등
import { errorText, h, ic, btn, busy, input, select, pill, date, bytes, reveal, put, subjectText } from '../ui.js';

const LABEL = {
  login: ['로그인', 'grey'],
  'login.failed': ['로그인 실패', 'yellow'],
  signup: ['원장 가입', ''],
  'me.username': ['아이디 바꿈', 'grey'],
  'me.password': ['비밀번호 바꿈', 'grey'],
  'session.revoke': ['기기 로그아웃', 'grey'],
  'session.revoke_others': ['다른 기기 로그아웃', 'grey'],
  'user.create': ['계정 만듦', 'green'],
  'user.update': ['계정 고침', 'grey'],
  'user.delete': ['계정 삭제', 'red'],
  'user.password_reset': ['비밀번호 초기화', 'yellow'],
  'user.suspend': ['사용 중지', 'red'],
  'user.activate': ['다시 사용', 'green'],
  'user.logout_all': ['모든 기기 로그아웃', 'yellow'],
  'code.create': ['가입 코드 만듦', ''],
  'code.revoke': ['가입 코드 취소', 'red'],
  'notice.create': ['공지 올림', 'grey'],
  'notice.update': ['공지 고침', 'grey'],
  'notice.delete': ['공지 지움', 'grey'],
  'academy.create': ['학원 만듦', 'green'],
  'academy.update': ['학원 이름 바꿈', 'grey'],
  'academy.subjects': ['계약 과목 바꿈', 'yellow'],
  'academy.delete': ['학원 지움', 'red'],
  'app.create': ['프로그램 추가', 'green'],
  'app.update': ['프로그램 고침', 'grey'],
  'app.delete': ['프로그램 지움', 'red'],
  'settings.update': ['서버 설정 바꿈', 'yellow'],
  'storage.cold_evict': ['오래된 데이터 정리', 'grey'],
  'storage.cold_run': ['데이터 정리 실행', 'grey'],
};

function detailText(e) {
  const d = e.detail;
  if (!d) return '';
  if (e.action === 'academy.subjects') return `${subjectText(d.subjects)} (전: ${subjectText(d.before)})`;
  if (e.action === 'storage.cold_evict' || e.action === 'storage.cold_run') return `${d.groups || 0}묶음 · 파일 ${d.files || 0}개 · ${bytes(d.bytes || 0)}`;
  if (e.action === 'user.delete' && d.to) return `학원 공간 자료는 ${d.to}에게 넘김 (파일 ${d.files || 0}개)`;
  if (e.action === 'user.create' && d.role) return { admin: '운영자', director: '원장', teacher: '선생님' }[d.role] || '';
  if (d.reason) return `이유: ${d.reason}`;
  if (d.academy) return d.academy;
  if (d.academyName) return d.academyName;
  return '';
}

export class AuditView {
  constructor({ cloud }) {
    this.cloud = cloud;
    this.entries = [];
    this.q = '';
    this.action = '';
    this.table = h('div', { class: 'table-wrap' });
    this.moreBtn = btn('더 보기', { variant: 'white' });
    this.moreBtn.addEventListener('click', () => busy(this.moreBtn, () => this.load(true)));
    const search = input({ cls: 'page search', placeholder: '사람이나 대상으로 찾기' });
    let t = null;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        this.q = search.value.trim();
        this.load();
      }, 250);
    });
    const kind = select(
      [
        ['', '모든 활동'],
        ['user', '계정'],
        ['code', '가입 코드'],
        ['login', '로그인'],
        ['notice', '공지'],
        ['app', '프로그램'],
        ['storage', '데이터 정리'],
        ['settings', '서버 설정'],
      ],
      '',
      { cls: 'page', style: 'width: 160px' },
    );
    kind.addEventListener('change', () => {
      this.action = kind.value;
      this.load();
    });
    this.el = h(
      'div',
      {},
      h('div', { class: 'page-head' }, h('div', { class: 'tt' }, h('h1', { class: 'title' }, '활동 기록'), h('div', { class: 'subtitle' }, ''))),
      h('div', { class: 'toolbar' }, kind, search),
      this.table,
      h('div', { style: { display: 'flex', justifyContent: 'center', marginTop: '14px' } }, this.moreBtn),
    );
    this.load();
  }

  async load(more = false) {
    const qs = new URLSearchParams({ limit: '100' });
    if (this.q) qs.set('q', this.q);
    if (this.action) qs.set('action', this.action);
    if (more && this.entries.length) qs.set('before', String(this.entries[this.entries.length - 1].id));
    try {
      const r = await this.cloud.api('GET', `/api/audit?${qs}`);
      this.entries = more ? [...this.entries, ...r.entries] : r.entries;
      this.moreBtn.style.display = r.more ? '' : 'none';
      this.render();
    } catch (e) {
      put(this.table, h('div', { class: 'empty' }, errorText(e)));
    }
  }

  render() {
    if (!this.entries.length) {
      put(this.table, h('div', { class: 'empty' }, ic('activity', 40, 1.6), '기록이 없어요'));
      return;
    }
    const rows = this.entries.map((e) => {
      const [label, kind] = LABEL[e.action] || [e.action, 'grey'];
      return h(
        'tr',
        {},
        h('td', { class: 'subtle', style: { whiteSpace: 'nowrap' } }, date(e.at, true)),
        h('td', {}, pill(label, kind)),
        h('td', {}, e.actor || h('span', { class: 'subtle' }, '-')),
        h('td', {}, e.target || ''),
        h('td', { class: 'subtle' }, [detailText(e), e.academy].filter(Boolean).join(' · ')),
        h('td', { class: 'subtle mono' }, e.ip),
      );
    });
    put(this.table, 
      h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ...['일시', '활동', '담당자', '대상', '내용', '접속 IP'].map((t) => h('th', {}, t)))), h('tbody', {}, ...rows)),
    );
    reveal(this.table.querySelector('tbody'));
  }
}
