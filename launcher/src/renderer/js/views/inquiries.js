import { h, btn, field, input, put, toast, errorText, date, dialog, segmented, ROLE } from '../ui.js';
const STATUS = { open: '접수됨', answered: '답변함', closed: '끝남' };

export class InquiriesView {
  constructor({ cloud, store, opts = {} }) {
    Object.assign(this, { cloud, store });
    this.admin = store.state.user.role === 'admin';
    this.urls = new Set();
    this.el = h('div', { class: 'inquiries' });
    this.head = h('div', { class: 'page-head' });
    this.content = h('div', { class: 'stack' });
    this.el.append(this.head, this.content);
    this.onNav(opts);
  }
  onNav(opts = {}) { if (opts.inquiryId) void this.open(opts.inquiryId); else void this.list(); }
  update(s) {
    if (this.stamp === s.inquiryStamp) return;
    const first = this.stamp === undefined;
    this.stamp = s.inquiryStamp;
    if (!first && !this.newForm) void (this.id ? this.refreshConversation() : this.list());
  }
  fail(e) { if (!this.dead) toast(errorText(e), 'error'); }
  async list() {
    const request = this.listRequest = (this.listRequest || 0) + 1;
    this.id = null; this.newForm = false;
    void this.cloud.inquiryViewing(null);
    put(this.head, h('div', { class: 'tt' }, h('h1', { class: 'title' }, this.admin ? '문의' : '문의하기')), this.admin ? null : h('div', { class: 'right' }, btn('새 문의', { variant: 'primary', iconName: 'plus', onClick: () => this.create() })));
    try {
      const r = await this.cloud.api('GET', `/api/inquiries${this.filter ? `?status=${this.filter}` : ''}`);
      if (this.dead || this.id || this.newForm || request !== this.listRequest) return;
      const filters = this.admin ? h('div', { class: 'toolbar' }, segmented([['', '전체'], ...Object.entries(STATUS)], this.filter || '', (v) => { this.filter = v; void this.list(); }, { onPage: true })) : null;
      put(this.content, filters, r.inquiries.length ? h('div', { class: 'card' }, ...r.inquiries.map(i => {
        const b = btn(`${this.admin ? `#${i.id} · ` : ''}${i.title}`, { variant: 'subtle', iconName: 'messageCircle', onClick: () => this.open(i.id) });
        return h('div', { class: 'inquiry-row' }, b, this.admin ? h('div', { class: 'muted' }, [i.senderName, ROLE[i.role], i.academyName, i.client].filter(Boolean).join(' · ')) : null,
          h('div', { class: 'notice-meta' }, STATUS[i.status], ' · ', date(i.lastMessageAt, true), i.unread ? h('span', { class: 'badge-num' }, '새 글') : null));
      })) : h('div', { class: 'empty' }, this.admin ? '받은 문의가 없어요.' : '보낸 문의가 없어요.'));
    } catch (e) { this.fail(e); }
  }
  composer(first = false) {
    const title = first ? input({ placeholder: '제목', maxlength: 100, 'aria-label': '제목' }) : null;
    const body = h('textarea', { class: 'input', rows: 5, maxlength: 2000, placeholder: first ? '내용' : '답글', 'aria-label': first ? '내용' : '답글' });
    const attached = [];
    const previews = h('div', { class: 'inquiry-photos' });
    const picker = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true });
    let uploading = false;
    picker.addEventListener('change', async () => {
      if (uploading) return;
      uploading = true; send.disabled = true;
      try {
        for (const file of picker.files) {
          if (attached.length >= 3) throw new Error('사진은 3장까지 붙일 수 있어요.');
          if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('사진은 한 장 5MB까지 붙일 수 있어요.');
          const { photo } = await this.cloud.inquiryPhotoUpload(new Uint8Array(await file.arrayBuffer()));
          if (this.dead) return;
          const url = URL.createObjectURL(file); this.urls.add(url);
          const item = { id: photo.id, url }; attached.push(item);
          const tile = h('div', {}, h('img', { src: url, alt: '붙인 사진', class: 'inquiry-thumb' }));
          tile.append(btn('빼기', { iconName: 'x', size: 'sm', onClick: () => { attached.splice(attached.indexOf(item), 1); URL.revokeObjectURL(url); this.urls.delete(url); tile.remove(); } }));
          previews.append(tile);
        }
      } catch (e) { this.fail(e); }
      finally { uploading = false; send.disabled = false; picker.value = ''; }
    });
    const send = btn('보내기', { iconName: 'right', variant: 'primary', onClick: async () => {
      if (uploading || send.disabled) return;
      send.disabled = true;
      try {
        const r = await this.cloud.api('POST', first ? '/api/inquiries' : `/api/inquiries/${this.id}/messages`, { ...(first ? { title: title.value } : {}), body: body.value, photoIds: attached.map(p => p.id) });
        body.value = ''; attached.splice(0); put(previews);
        await this.open(first ? r.inquiry.id : this.id);
      } catch (e) { this.fail(e); }
      finally { send.disabled = false; }
    } });
    return h('div', { class: 'card stack' }, title ? field('제목', title) : null, field(first ? '내용' : '답글', body), previews,
      h('div', { class: 'muted' }, '사진은 3장까지, 한 장 5MB까지 붙일 수 있어요.'), picker,
      h('div', { class: 'inquiry-actions' }, btn('사진 붙이기', { iconName: 'plus', onClick: () => picker.click() }), send));
  }
  create() {
    this.id = null; this.newForm = true; void this.cloud.inquiryViewing(null);
    put(this.head, h('div', { class: 'tt' }, h('h1', { class: 'title' }, '새 문의')), h('div', { class: 'right' }, btn('목록', { iconName: 'list', onClick: () => this.list() })));
    put(this.content, this.composer(true));
  }
  async open(id) {
    this.id = Number(id); this.newForm = false;
    void this.cloud.inquiryViewing(this.id);
    this.messages = h('div', { class: 'stack' });
    this.statusLine = h('div', { class: 'muted' });
    put(this.content, this.messages, this.statusLine, this.composer());
    await this.refreshConversation();
  }
  async refreshConversation() {
    const id = this.id;
    const generation = this.generation = (this.generation || 0) + 1;
    try {
      const { inquiry: i, messages } = await this.cloud.api('GET', `/api/inquiries/${id}`);
      if (this.dead || this.id !== id || generation !== this.generation) return;
      for (const url of this.messageUrls || []) { URL.revokeObjectURL(url); this.urls.delete(url); }
      this.messageUrls = [];
      const info = [...(this.admin ? [i.senderName, ROLE[i.role], i.academyName, i.client] : []), STATUS[i.status]].filter(Boolean).join(' · ');
      put(this.head, h('div', { class: 'tt' }, h('h1', { class: 'title' }, `#${i.id} · ${i.title}`), h('div', { class: 'subtitle' }, info)),
        h('div', { class: 'right' }, btn('목록', { iconName: 'list', onClick: () => this.list() }), this.admin ? btn(i.status === 'closed' ? '다시 열기' : '끝내기', { iconName: i.status === 'closed' ? 'undo' : 'check', onClick: async () => {
          try { await this.cloud.api('POST', `/api/inquiries/${id}/${i.status === 'closed' ? 'reopen' : 'close'}`, {}); await this.refreshConversation(); } catch (e) { this.fail(e); }
        } }) : null));
      this.statusLine.textContent = i.status === 'closed' ? (this.admin ? '끝난 문의예요.' : '끝난 문의예요. 답글을 쓰면 다시 열려요.') : '';
      this.statusLine.hidden = i.status !== 'closed';
      put(this.messages, ...messages.map(m => {
        const pictures = h('div', { class: 'inquiry-photos' });
        for (const photoId of m.photoIds) { const slot = h('span', { class: 'inquiry-photo-slot' }); pictures.append(slot); void this.loadPhoto(id, photoId, slot, generation); }
        return h('div', { class: `card inquiry-message${m.fromAdmin ? ' from-admin' : ''}` }, h('div', { class: 'notice-meta' }, m.fromAdmin ? '운영자' : this.admin ? i.senderName || '보낸 사람' : '나', ' · ', date(m.createdAt, true)),
          h('div', { class: 'inquiry-body' }, m.body), pictures, m.photosExpired ? h('div', { class: 'muted' }, '보관 기간이 지나 사진을 지웠어요') : null);
      }));
      void this.cloud.inquiryRefresh();
    } catch (e) { this.fail(e); }
  }
  async loadPhoto(id, photoId, container, generation) {
    try {
      const p = await this.cloud.inquiryPhotoGet(id, photoId);
      if (this.dead || this.id !== id || this.generation !== generation) return;
      const url = URL.createObjectURL(new Blob([new Uint8Array(p.bytes)], { type: p.mime }));
      this.urls.add(url); this.messageUrls.push(url);
      const button = h('button', { type: 'button', class: 'inquiry-photo', title: '사진 크게 보기', onClick: () => dialog({ title: '사진', body: h('img', { src: url, alt: '문의 사진', style: { maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' } }), ok: null, cancel: '닫기' }) },
        h('img', { src: url, alt: '문의 사진', class: 'inquiry-thumb' }));
      container.replaceChildren(button);
    } catch { if (container.isConnected) container.replaceChildren(h('span', { class: 'muted' }, '사진을 불러오지 못했어요.')); }
  }
  destroy() { this.dead = true; void this.cloud.inquiryViewing(null); for (const url of this.urls) URL.revokeObjectURL(url); }
}
