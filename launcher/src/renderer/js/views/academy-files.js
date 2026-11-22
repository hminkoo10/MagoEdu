// 운영자가 고른 학원의 자료: 권한은 서버의 원장 규칙을 따른다.
import { errorText, h, btn, busy, toast, dialog, input, select, date, bytes, put } from '../ui.js';

export class AcademyFilesView {
  constructor({ cloud, store, go, opts = {} }) {
    Object.assign(this, { cloud, store, go, academy: opts.academy });
    this.el = h('div');
    if (store.state.user.role !== 'admin') { go('home'); return; }
    this.entries = []; this.members = new Map(); this.q = ''; this.limit = 200; this.loadSeq = 0;
    this.table = h('div', { class: 'table-wrap' });
    this.ready = this.init();
  }
  async init() {
    try {
      const a = (await this.cloud.api('GET', '/api/academies')).academies.find((a) => String(a.id) === String(this.academy));
      if (!a) { this.go('academies'); return; }
      const qs = `?academy=${encodeURIComponent(this.academy)}`;
      const [people, storage, catalog] = await Promise.all([this.cloud.api('GET', `/api/academy/members${qs}`), this.cloud.api('GET', `/api/sync${qs}`), this.cloud.api('GET', '/api/apps')]);
      this.members = new Map(people.members.map((m) => [m.id, m.name]));
      // 이 PC 에 깔렸는지와 상관없이 그 학원 공간에 자료가 있는 프로그램
      const names = new Map((catalog.apps || []).map((p) => [p.id, p.name]));
      const apps = (storage.academy?.apps || []).map((p) => ({ id: p.appId, name: names.get(p.appId) || p.appId }));
      this.app = (apps.find((a) => a.id === 'ohdapnote') || apps[0])?.id;
      const programs = select(apps.map((a) => [a.id, a.name]), this.app, { cls: 'page' });
      programs.addEventListener('change', () => { this.app = programs.value; this.load(); });
      const search = input({ cls: 'page search', placeholder: '찾기' });
      search.addEventListener('input', () => { this.q = search.value.toLowerCase(); this.limit = 200; this.render(); });
      put(this.el,
        h('div', { class: 'page-head' }, h('h1', { class: 'title' }, `${a.name} · 학원 자료`), btn('학원 설정으로', { iconName: 'back', onClick: () => this.go('academy-settings', { academy: a.id }) })),
        h('p', { class: 'subtle' }, '여기서 열거나 바꾼 일은 활동 기록에 남아요.'),
        apps.length ? h('div', { class: 'toolbar' }, programs, search) : null, this.table);
      if (!apps.length) { put(this.table, h('div', { class: 'empty' }, '이 학원의 학원 자료가 없어요.')); return; }
      await this.load();
    } catch (e) { put(this.el, h('div', { class: 'empty' }, errorText(e))); }
  }
  route(file, rev) {
    return `/api/sync/${encodeURIComponent(this.app)}/academy${file ? '/file' : ''}?academy=${encodeURIComponent(this.academy)}${file ? `&path=${encodeURIComponent(file.path)}${rev ? `&baseRev=${file.rev}` : ''}` : '&since=0'}`;
  }
  async load() {
    const seq = ++this.loadSeq;
    try {
      const r = this.app ? await this.cloud.api('GET', this.route()) : { entries: [] };
      if (seq !== this.loadSeq) return;
      this.entries = r.entries.filter((e) => !e.deleted); this.limit = 200; this.render();
    } catch (e) { if (seq === this.loadSeq) put(this.table, h('div', { class: 'empty' }, errorText(e))); }
  }
  async act(kind, file) {
    try {
      if (kind === 'download') {
        if (await this.cloud.academyFileDownload(this.app, this.academy, file.path)) toast('내려받았어요', 'success');
      } else if (kind === 'replace') {
        if (await this.cloud.academyFileReplace(this.app, this.academy, file.path, file.rev)) await this.load();
      } else {
        if (!await dialog({ title: '파일 지우기', body: `${file.path}을(를) 지울까요? 이 학원 PC에서도 지워지고 되돌릴 수 없어요.`, ok: '지우기', danger: true })) return;
        await this.cloud.api('DELETE', this.route(file, true)); await this.load();
      }
    } catch (e) {
      if (e.status === 409) { toast('다른 곳에서 먼저 바뀌었어요. 목록을 새로 불러왔어요.'); await this.load(); }
      else toast(e.status === 403 && e.code === 'not_owner' && file.path.startsWith('members/') ? '선생님 개인 자료는 그 선생님만 고칠 수 있어요.' : errorText(e), 'error');
    }
  }
  render() {
    const files = this.entries.filter((e) => e.path.toLowerCase().includes(this.q));
    if (!files.length) { put(this.table, h('div', { class: 'empty' }, '이 프로그램의 학원 자료가 없어요.')); return; }
    const rows = files.slice(0, this.limit).map((f) => h('tr', {},
      h('td', {}, f.path), h('td', { class: 'subtle' }, bytes(f.size)), h('td', { class: 'subtle' }, date(f.updatedAt, true)), h('td', {}, this.members.get(f.updatedBy) || '-'),
      h('td', { class: 'acts' }, ...[['download', '내려받기', 'download'], ['replace', '바꾸기', 'cloudUpload'], ['delete', '지우기', 'trash']].map(([kind, label, iconName]) => {
        const b = btn(label, { iconName, size: 'sm', variant: kind === 'delete' ? 'danger' : '' });
        b.addEventListener('click', () => busy(b, () => this.act(kind, f))); return b;
      }))));
    const more = btn('더 보기', { onClick: () => { this.limit += 200; this.render(); } });
    put(this.table, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ...['파일', '크기', '고친 날짜', '고친 사람', '동작'].map((s) => h('th', {}, s)))), h('tbody', {}, ...rows)), files.length > this.limit ? more : null);
  }
}
