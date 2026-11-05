// 공지사항: 모두 보기, 운영자는 전체·학원 공지, 원장은 자기 학원 공지를 올림
import { errorText, h, ic, btn, toast, dialog, field, input, select, checkbox, pill, ago, date, confirmDialog, reveal, put } from '../ui.js';

// 공지 한도 (server/src/routes/admin.js 와 같게)
const LIMIT = { title: 100, body: 2000, lines: 50 };
const lineCount = (t) => t.split(/\r\n?|\n/).length;

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
      put(this.list, h('div', { class: 'empty' }, errorText(e)));
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
            btn('고치기', { variant: 'subtle', size: 'sm', iconName: 'edit', title: '고치기', onClick: () => this.edit(n) }),
            btn('지우기', { variant: 'subtle', size: 'sm', iconName: 'trash', title: '지우기', onClick: () => this.remove(n) }),
          );
        }
        const expired = n.expiresAt && n.expiresAt < Date.now();
        return h(
          'div',
          { class: 'notice' },
          h('div', { class: 'notice-title' }, n.pinned ? pill('고정') : null, h('span', {}, n.title), acts),
          this.body(n.body),
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

  /** 긴 공지는 몇 줄만 보여 주고 '더 보기'로 펼친다 */
  body(text) {
    const el = h('div', { class: 'notice-body clamp' }, text);
    const more = btn('더 보기', { variant: 'subtle', size: 'sm', cls: 'notice-more' });
    more.style.display = 'none'; // .btn 의 display 때문에 hidden 속성은 듣지 않음
    more.addEventListener('click', () => {
      const open = el.classList.toggle('clamp');
      more.textContent = open ? '더 보기' : '접기';
    });
    // 화면에 붙은 뒤에야 넘치는지 알 수 있다
    requestAnimationFrame(() => {
      if (el.scrollHeight > el.clientHeight + 1) more.style.display = '';
      else el.classList.remove('clamp');
    });
    return h('div', {}, el, more);
  }

  async edit(n) {
    const u = this.store.state.user;
    const title = input({ value: n?.title || '', placeholder: '제목', maxlength: LIMIT.title });
    const body = h('textarea', { class: 'input', placeholder: '내용', maxlength: LIMIT.body });
    body.value = n?.body || '';
    const count = h('div', { class: 'notice-count' });
    const recount = () => {
      const lines = lineCount(body.value);
      count.replaceChildren(`${body.value.length.toLocaleString('ko-KR')} / ${LIMIT.body.toLocaleString('ko-KR')}자 · ${lines} / ${LIMIT.lines}줄`);
      count.classList.toggle('over', lines > LIMIT.lines);
    };
    body.addEventListener('input', recount);
    recount();
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
        count,
        h('div', { class: 'form-row', style: { marginTop: '14px', alignItems: 'center' } }, field('보여 줄 기간', days), h('div', { style: { paddingTop: '22px' } }, checkbox('맨 위에 고정', pinned, (v) => (pinned = v)))),
      ),
      ok: n ? '저장' : '올리기',
      onOk: async () => {
        if (lineCount(body.value) > LIMIT.lines) throw new Error(`내용은 ${LIMIT.lines}줄까지 쓸 수 있어요.`);
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
      toast(errorText(e), 'error');
    }
  }
}

