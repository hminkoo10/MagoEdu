// 원장 가입 코드 (운영자): 코드를 만들어 원장님께 주면, 원장님이 직접 가입해 학원과 계정을 만든다
import { errorText, h, ic, btn, toast, dialog, field, input, select, pill, date, ago, confirmDialog, secretDialog, reveal, put, subjectChecks, subjectText } from '../ui.js';

const STATE = { active: ['쓸 수 있음', 'green'], used: ['다 씀', 'grey'], expired: ['기간 끝남', 'yellow'], revoked: ['취소함', 'red'] };

export class CodesView {
  constructor({ cloud }) {
    this.cloud = cloud;
    this.table = h('div', { class: 'table-wrap' });
    this.el = h(
      'div',
      {},
      h(
        'div',
        { class: 'page-head' },
        h('div', { class: 'tt' }, h('h1', { class: 'title' }, '원장 가입 코드'), h('div', { class: 'subtitle' }, '코드를 만들어 원장님께 드리면, 통합 클라우드에서 ‘가입 코드가 있어요’로 직접 가입해요.')),
        h('div', { class: 'right' }, btn('코드 만들기', { variant: 'primary', iconName: 'plus', onClick: () => this.create() })),
      ),
      this.table,
    );
    this.load();
  }

  async load() {
    try {
      const r = await this.cloud.api('GET', '/api/codes');
      this.render(r.codes);
    } catch (e) {
      put(this.table, h('div', { class: 'empty' }, errorText(e)));
    }
  }

  render(codes) {
    if (!codes.length) {
      put(this.table, h('div', { class: 'empty' }, ic('ticket', 40, 1.6), '아직 만든 코드가 없어요'));
      return;
    }
    const rows = codes.map((c) => {
      const copy = btn('복사', { variant: 'subtle', size: 'sm', iconName: 'copy', title: '복사' });
      copy.addEventListener('click', async () => {
        await this.cloud.copy(c.code);
        toast('코드를 복사했어요', 'success', 1600);
      });
      const revoke = c.state === 'active' ? btn('취소', { size: 'sm', variant: 'danger' }) : null;
      revoke?.addEventListener('click', async () => {
        if (!(await confirmDialog('코드를 취소할까요?', `${c.code} 로는 더 가입할 수 없어요.`, '취소하기', true))) return;
        await this.cloud.api('DELETE', `/api/codes/${c.id}`);
        toast('코드를 취소했어요', 'success');
        this.load();
      });
      const [label, kind] = STATE[c.state] || ['', 'grey'];
      return h(
        'tr',
        {},
        h('td', {}, h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } }, h('span', { class: 'mono selectable', style: { fontWeight: 700, fontSize: '15px' } }, c.code), copy)),
        h('td', {}, c.academyName || h('span', { class: 'subtle' }, '가입할 때 입력')),
        h('td', {}, subjectText(c.subjects)),
        h('td', {}, c.memo || h('span', { class: 'subtle' }, '-')),
        h('td', { class: 'num' }, `${c.uses} / ${c.maxUses}`),
        h('td', { class: 'subtle' }, c.expiresAt ? `${date(c.expiresAt)}까지` : '기한 없음'),
        h('td', {}, pill(label, kind)),
        h('td', { class: 'subtle' }, `${c.createdBy} · ${ago(c.createdAt)}`),
        h('td', { class: 'acts' }, revoke),
      );
    });
    put(this.table, 
      h(
        'table',
        { class: 'table' },
        h('thead', {}, h('tr', {}, ...['코드', '학원', '과목', '메모', '사용', '기간', '상태', '만든 사람', ''].map((t, i) => h('th', { class: i === 4 ? 'num' : '' }, t)))),
        h('tbody', {}, ...rows),
      ),
    );
    reveal(this.table.querySelector('tbody'));
  }

  async create() {
    const academy = input({ placeholder: '비우면 원장님이 가입할 때 입력' });
    const subjects = subjectChecks();
    const memo = input({ placeholder: '예: 마고수학학원 본원 원장님' });
    const uses = select(
      [
        ['1', '한 번'],
        ['3', '세 번'],
        ['10', '열 번'],
      ],
      '1',
    );
    const days = select(
      [
        ['1', '1일'],
        ['7', '7일'],
        ['30', '30일'],
        ['0', '기한 없음'],
      ],
      '7',
    );
    let made = null;
    const ok = await dialog({
      title: '원장 가입 코드 만들기',
      sub: '이 코드로 가입하면 새 학원과 원장 계정이 만들어져요.',
      body: h('div', {}, field('학원 이름', academy), field('계약 과목', subjects.el), field('메모', memo), h('div', { class: 'form-row', style: { marginTop: '14px' } }, field('쓸 수 있는 횟수', uses), field('쓸 수 있는 기간', days))),
      ok: '만들기',
      onOk: async () => {
        const r = await this.cloud.api('POST', '/api/codes', { academyName: academy.value, subjects: subjects.value(), memo: memo.value, maxUses: Number(uses.value), expiresInDays: Number(days.value) });
        made = r.code;
      },
    });
    if (!ok || !made) return;
    await secretDialog('가입 코드를 만들었어요', '원장님께 이 코드와 서버 주소를 알려 주세요.', made.code);
    this.load();
  }
}
