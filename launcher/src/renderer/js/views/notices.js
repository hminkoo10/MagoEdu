// 공지사항: 모두 보기, 운영자는 전체·학원 공지, 원장은 자기 학원 공지를 올림
import { h, ic, btn, toast, dialog, field, input, select, checkbox, pill, ago, date, confirmDialog, reveal, put } from '../ui.js';

export class NoticesView {
  constructor({ cloud, store }) {
    this.cloud = cloud;
    this.store = store;
    const u = store.state.user;
    this.canWrite = u.role === 'admin' || (u.role === 'director' && !!u.academy);
    this.list = h('div', { class: 'card' });
    const right = h('div', { class: 'right' });
    if (this.canWrite) right.append(btn('공지 쓰기', { variant: 'primary', iconName: 'plus', onClick: () => this.edit(null) }));
    this.el = h(
      'div',
      {},
      h(
        'div',
        { class: 'page-head' },
        h('div', { class: 'tt' }, h('h1', { class: 'title' }, '공지사항'), h('div', { class: 'subtitle' }, u.role === 'admin' ? '전체 공지와 학원별 공지를 올릴 수 있어요.' : '운영자와 원장님이 올린 공지예요.')),
        right,
      ),
      this.list,
    );
    this.load(true);
  }

  async load(first = false) {
    try {
      const all = this.store.state.user.role === 'admin';
      const r = await this.cloud.api('GET', `/api/notices${all ? '?all=1' : ''}`);
      this.render(r.notices);
      if (first) {
        await this.cloud.refreshNotices().catch(() => {});
        await this.cloud.noticesSeen();
      }
    } catch (e) {
      put(this.list, h('div', { class: 'empty' }, e.message));
    }
  }

  render(notices) {
    if (!notices.length) {
      put(this.list, h('div', { class: 'empty' }, ic('megaphone', 40, 1.6), '아직 공지가 없어요'));
      return;
    }
    put(this.list, 
      ...notices.map((n) => {
        const acts = h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '4px' } });
        if (n.editable) {
          acts.append(
            btn('', { variant: 'subtle', size: 'sm', iconName: 'edit', title: '고치기', onClick: () => this.edit(n) }),
            btn('', { variant: 'subtle', size: 'sm', iconName: 'trash', title: '지우기', onClick: () => this.remove(n) }),
          );
        }
        const expired = n.expiresAt && n.expiresAt < Date.now();
        return h(
          'div',
          { class: 'notice' },
          h('div', { class: 'notice-title' }, n.pinned ? pill('고정') : null, h('span', {}, n.title), acts),
          h('div', { class: 'notice-body' }, n.body),
          h(
            'div',
            { class: 'notice-meta' },
            pill(n.academy ? n.academy.name : '전체', n.academy ? 'grey' : ''),
            h('span', {}, n.authorName),
            h('span', {}, ago(n.createdAt)),
            n.expiresAt ? h('span', { class: expired ? 'hl' : '' }, expired ? '기간 끝남' : `${date(n.expiresAt)}까지`) : null,
          ),
        );
      }),
    );
    reveal(this.list);
  }

  async edit(n) {
    const u = this.store.state.user;
    const title = input({ value: n?.title || '', placeholder: '제목' });
    const body = h('textarea', { class: 'input', placeholder: '내용' });
    body.value = n?.body || '';
    let pinned = !!n?.pinned;
    const days = select(
      [
        ['0', '계속'],
        ['7', '7일 동안'],
        ['14', '14일 동안'],
        ['30', '30일 동안'],
      ],
      '0',
    );
    let target = null;
    if (u.role === 'admin') {
      const r = await this.cloud.api('GET', '/api/academies');
      target = select([['', '전체 (모든 학원)'], ...r.academies.map((a) => [String(a.id), a.name])], n?.academy ? String(n.academy.id) : '');
    }
    await dialog({
      title: n ? '공지 고치기' : '공지 쓰기',
      wide: true,
      body: h(
        'div',
        {},
        target ? field('보낼 곳', target) : field('보낼 곳', input({ value: u.academy?.name || '', disabled: true })),
        field('제목', title),
        field('내용', body),
        h('div', { class: 'form-row', style: { marginTop: '14px', alignItems: 'center' } }, field('보여 줄 기간', days), h('div', { style: { paddingTop: '22px' } }, checkbox('맨 위에 고정', pinned, (v) => (pinned = v)))),
      ),
      ok: n ? '저장' : '올리기',
      onOk: async () => {
        const payload = { title: title.value, body: body.value, pinned };
        if (!n || days.value !== '0') payload.expiresInDays = Number(days.value);
        if (target) payload.academyId = target.value ? Number(target.value) : null;
        if (n) await this.cloud.api('PATCH', `/api/notices/${n.id}`, payload);
        else await this.cloud.api('POST', '/api/notices', payload);
        toast(n ? '공지를 고쳤어요' : '공지를 올렸어요', 'success');
        await this.load();
        await this.cloud.refreshNotices().catch(() => {});
        await this.cloud.noticesSeen();
      },
    });
  }

  async remove(n) {
    if (!(await confirmDialog('공지를 지울까요?', `‘${n.title}’`, '지우기', true))) return;
    try {
      await this.cloud.api('DELETE', `/api/notices/${n.id}`);
      toast('공지를 지웠어요', 'success');
      await this.load();
      await this.cloud.refreshNotices().catch(() => {});
    } catch (e) {
      toast(e.message, 'error');
    }
  }
}

