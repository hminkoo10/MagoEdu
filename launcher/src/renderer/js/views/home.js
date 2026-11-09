// 프로그램 화면: 설치·열기·업데이트·삭제, 동기화 상태 (Creative Cloud 처럼)
import { errorText, h, ic, btn, busy, toast, dialog, notify, menu, checkbox, bytes, ago, ROLE, put } from '../ui.js';

const TASK_LABEL = { install: '설치하는 중', update: '업데이트하는 중', uninstall: '삭제하는 중', launch: '켜는 중', legacy: '가져오는 중' };

export async function askLegacy(cloud, id, list, store) {
  const app = store.state.apps.find((a) => a.id === id);
  const picks = new Set(list.map((l) => l.id));
  let never = false;
  const rows = list.map((l) =>
    h(
      'div',
      { class: 'row' },
      checkbox('', true, (on) => (on ? picks.add(l.id) : picks.delete(l.id))),
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'row-title' }, l.label),
        h('div', { class: 'row-desc' }, `파일 ${l.files}개 · ${bytes(l.bytes)}`),
        l.importedBy ? h('div', { class: 'row-desc hl' }, `${l.importedBy} 계정으로 이미 가져왔어요`) : null,
      ),
    ),
  );
  const ok = await dialog({
    title: '예전 데이터를 가져올까요?',
    sub: `${app?.name || '프로그램'} 데이터를 내 계정에 복사해요. 원본은 남아요.`,
    body: h('div', {}, ...rows),
    ok: '가져오기',
    cancel: '이번엔 건너뛰기',
    footLeft: checkbox('다시 묻지 않기', false, (on) => (never = on)),
    onOk: async () => {
      if (!picks.size) throw new Error('가져올 데이터를 골라 주세요.');
      let copied = 0;
      for (const lid of picks) copied += (await cloud.legacyImport(id, lid)).copied;
      toast(`예전 데이터 ${copied}개 파일을 가져왔어요`, 'success');
      return true;
    },
  });
  if (!ok || never) for (const l of list) if (!ok || !picks.has(l.id)) await cloud.legacyDismiss(id, l.id);
  return ok;
}

/**
 * 웹: magoedu:// 로 PC 의 통합 클라우드 앱을 연다. 안 열리면(앱이 없으면) 내려받기 안내.
 *   id 없음 → 앱만 열기, kind 'launch' → 그 프로그램 실행(필요하면 설치·업데이트부터), 'install' → 설치·업데이트만
 */
export async function openInApp(cloud, store, id, kind = 'launch') {
  const r = await (!id ? cloud.openApp() : kind === 'install' ? cloud.installInApp(id) : cloud.launch(id));
  if (r?.opened) {
    if (kind === 'install') toast('PC의 통합 클라우드에서 설치를 이어서 해요', 'success');
    return;
  }
  const title = '통합 클라우드가 열리지 않았나요?';
  const sub = '이 PC에 통합 클라우드 앱이 설치되어 있어야 해요.';
  if (!store.state.launcher) return notify(title, sub);
  if (await dialog({ title, sub, ok: '앱 내려받기', cancel: '닫기' })) location.href = '/download/launcher';
}

export class HomeView {
  constructor({ cloud, store, go }) {
    this.cloud = cloud;
    this.store = store;
    this.go = go;
    this.cards = new Map();
    const s = store.state;
    this.web = !!s.web;
    this.sub = h('div', { class: 'subtitle' });
    const syncAll = this.web ? null : btn('지금 맞추기', { variant: 'white', iconName: 'refresh' });
    syncAll?.addEventListener('click', () =>
      busy(syncAll, async () => {
        try {
          await cloud.syncAll();
          toast('서버와 맞추기를 마쳤어요', 'success', 1800);
        } catch (e) { toast(errorText(e), 'error'); }
      }),
    );
    const reload = btn('새로 고침', { variant: 'white', iconName: 'rotate', title: '목록 새로 고침' });
    reload.addEventListener('click', () => busy(reload, () => cloud.refreshApps().catch((e) => toast(errorText(e), 'error'))));
    this.notice = h('div');
    this.webNote = this.web ? this.makeWebNote(s) : null;
    this.grid = h('div', { class: 'apps-grid' });
    this.empty = h(
      'div',
      { class: 'card empty', style: { display: 'none' } },
      ic('box', 40, 1.6),
      h('div', { style: { fontWeight: 600, color: 'var(--grey700)', fontSize: '15px' } }, '쓸 수 있는 프로그램이 없어요'),
      h('div', { class: 'muted', style: { marginTop: '4px' } }, '프로그램 사용은 원장님·운영자에게 문의하세요.'),
    );
    this.el = h(
      'div',
      {},
      h('div', { class: 'page-head' }, h('div', { class: 'tt' }, h('h1', { class: 'title' }, '프로그램'), this.sub), h('div', { class: 'right' }, reload, syncAll)),
      this.notice,
      this.webNote,
      h('p', { class: 'card-desc' }, this.web ? '' : ''),
      this.grid,
      this.empty,
    );
    this.update(s);
  }

  makeWebNote(s) {
    if (!s.client?.canOpenApp) {
      const text =
        s.client?.os === 'android'
          ? 'PC 프로그램은 Windows에서 사용해요.'
          : 'PC 프로그램은 Windows에서 사용해요.';
      return h('div', { class: 'note', style: { marginBottom: '16px' } }, ic('info', 18), h('span', {}, text));
    }
    const open = btn('통합 클라우드 열기', { variant: 'primary', size: 'sm', iconName: 'cloud' });
    open.addEventListener('click', () => openInApp(this.cloud, this.store).catch((e) => toast(errorText(e), 'error')));
    const download = s.launcher ? h('a', { class: 'btn white sm', href: '/download/launcher' }, ic('download', 16), '앱 내려받기') : null;
    return h(
      'div',
      { class: 'note', style: { marginBottom: '16px' } },
      ic('info', 18),
      h(
        'div',
        { style: { flex: 1, minWidth: 0 } },
        h('div', {}, 'PC 프로그램은 설치된 통합 클라우드 앱에서 열려요.'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' } }, open, download),
      ),
    );
  }

  update(s) {
    const u = s.user;
    const who = u.name === ROLE[u.role] ? u.name : `${u.name} ${ROLE[u.role]}`;
    this.sub.textContent = `${who}${who.endsWith('님') ? '' : '님'}${u.academy ? ` · ${u.academy.name}` : ''}`;
    this.renderNotice(s);
    const ids = new Set(s.apps.map((a) => a.id));
    for (const [id, c] of this.cards) {
      if (!ids.has(id)) {
        c.el.remove();
        this.cards.delete(id);
      }
    }
    s.apps.forEach((a, i) => {
      let c = this.cards.get(a.id);
      if (!c) {
        c = this.makeCard(a);
        c.el.style.setProperty('--i', i + 2);
        this.cards.set(a.id, c);
      }
      if (this.grid.children[i] !== c.el) this.grid.insertBefore(c.el, this.grid.children[i] || null);
      this.fillCard(c, a);
    });
    this.empty.style.display = s.apps.length ? 'none' : '';
  }

  renderNotice(s) {
    const n = s.notices[0];
    const key = n ? `${n.id}|${s.notices.length}|${s.unreadNotices}` : '';
    if (key === this._noticeKey) return;
    this._noticeKey = key;
    if (!n) return this.notice.replaceChildren();
    const strip = h(
      'div',
      { class: 'notice-strip' },
      h('div', { class: 'bubble' }, ic('megaphone', 20)),
      h(
        'div',
        { class: 'txt' },
        h('div', { class: 't1' }, n.title),
        h('div', { class: 't2' }, `${n.academy ? n.academy.name : '전체'} 공지 · ${n.authorName} · ${ago(n.createdAt)}${s.notices.length > 1 ? ` · 공지 ${s.notices.length}개` : ''}`),
      ),
      s.unreadNotices ? h('span', { class: 'pill' }, `새 공지 ${s.unreadNotices}`) : null,
      ic('right', 18),
    );
    strip.addEventListener('click', () => this.go('notices'));
    put(this.notice, strip);
  }

  makeCard(a) {
    const c = {};
    c.icon = h('div', { class: 'app-icon' });
    c.name = h('div', { class: 'app-name' });
    c.ver = h('div', { class: 'app-ver' });
    c.desc = h('div', { class: 'app-desc' });
    c.taskText = h('span');
    c.taskPct = h('span');
    c.bar = h('i');
    c.progress = h('div', { class: 'progress' }, c.bar);
    c.task = h('div', { class: 'app-task', style: { display: 'none' } }, h('div', { class: 't' }, c.taskText, c.taskPct), c.progress);
    c.sync = h('div', { class: 'sync' });
    c.primary = btn('', { variant: 'primary' });
    c.second = btn('', { variant: 'soft' }); // 웹: ‘PC에 설치’
    c.second.style.display = 'none';
    c.more = btn('', { iconName: 'more', title: '더 보기' });
    c.el = h(
      'div',
      { class: 'app-card' },
      h('div', { class: 'app-head' }, c.icon, h('div', { style: { minWidth: 0 } }, c.name, c.ver)),
      c.desc,
      c.task,
      h('div', { class: 'app-foot' }, c.sync, c.more, c.second, c.primary),
    );
    c.primary.addEventListener('click', () => this.primary(c.app));
    c.second.addEventListener('click', () => openInApp(this.cloud, this.store, c.app.id, 'install').catch((e) => toast(errorText(e), 'error')));
    c.more.addEventListener('click', () => this.openMenu(c.more, c.app));
    return c;
  }

  fillCard(c, a) {
    c.app = a;
    const iconKey = a.icon || a.name;
    if (c._icon !== iconKey) {
      c._icon = iconKey;
      const letter = () => {
        c.icon.style.background = a.color ? `linear-gradient(135deg, ${a.color}cc, ${a.color})` : '';
        put(c.icon, (a.name || '?')[0]);
      };
      if (a.icon) {
        c.icon.style.background = '#fff';
        put(c.icon, h('img', { src: a.icon, alt: '', onError: letter })); // 웹: 아이콘이 없으면(404) 글자로
      } else letter();
    }
    c.name.textContent = a.name;
    c.desc.textContent = a.description || '';
    if (a.platform === 'android') return this.fillPhoneCard(c, a);
    if (a.platform === 'web') return this.fillLinkCard(c, a);
    if (this.web) return this.fillWebCard(c, a);

    const ver = [h('span', {}, 'PC 프로그램'), h('span', {}, '·')];
    if (a.running) ver.push(h('span', { class: 'dot pulse' }), h('span', { style: { color: 'var(--success)', fontWeight: 600 } }, '실행 중'), h('span', {}, '·'));
    if (a.installed) {
      ver.push(h('span', {}, `버전 ${a.running && a.runningVersion ? a.runningVersion : a.installed.version}`));
      if (a.restartForUpdate) ver.push(h('span', { class: 'pill' }, `다시 켜면 ${a.installed.version}`));
      else if (a.updateAvailable) ver.push(h('span', { class: 'pill' }, `${a.release.version} 새 버전`));
    } else if (a.release) {
      ver.push(h('span', {}, `최신 ${a.release.version} · ${bytes(a.release.size)}`));
    } else {
      ver.push(h('span', {}, '아직 배포 전'));
    }
    put(c.ver, ...ver);

    // 진행
    const t = a.task;
    c.task.style.display = t ? '' : 'none';
    if (t) {
      c.taskText.textContent = t.text || TASK_LABEL[t.kind] || '';
      const pct = t.progress === null || t.progress === undefined ? null : Math.round(t.progress * 100);
      c.taskPct.textContent = pct === null ? '' : `${pct}%`;
      c.progress.classList.toggle('indeterminate', pct === null);
      c.bar.style.width = `${pct ?? 0}%`;
    }

    // 기본 버튼
    let label;
    let iconName = null;
    let variant = 'primary';
    let disabled = false;
    if (t) {
      label = TASK_LABEL[t.kind] || '진행 중';
      disabled = true;
    } else if (!a.installed) {
      label = a.release ? '설치' : '준비 중';
      iconName = 'download';
      disabled = !a.release;
    } else if (a.running) {
      label = '열기';
      variant = 'soft';
      iconName = 'play';
    } else if (a.updateAvailable) {
      label = '업데이트';
      iconName = 'download';
    } else {
      label = '열기';
      iconName = 'play';
    }
    const key = `${label}|${variant}|${disabled}|${iconName}`;
    if (c._primary !== key) {
      c._primary = key;
      c.primary.className = `btn ${variant}`;
      c.primary.disabled = disabled;
      put(c.primary, ...(iconName ? [ic(iconName, 18)] : []), document.createTextNode(label));
    }

    // 동기화
    const sy = a.sync;
    let syncEl = [];
    let warn = false;
    if (!a.installed) syncEl = [];
    else if (!sy) syncEl = [ic('cloudPending', 15), '아직 서버와 맞추기 전'];
    else if (sy.status === 'syncing') syncEl = [h('span', { class: 'spinner', style: { width: '13px', height: '13px', borderWidth: '2px' } }), '서버와 맞추는 중'];
    else if (sy.status === 'offline') syncEl = [ic('cloudOff', 15), '연결되면 자동으로 맞춰요'];
    else if (sy.status === 'error') {
      warn = true;
      syncEl = [ic('alert', 15), '서버와 맞추기 실패'];
    } else if (sy.quotaExceeded) {
      warn = true;
      syncEl = [ic('warning', 15), '서버 용량이 꽉 찼어요'];
    } else if (sy.localOnly?.files) {
      warn = true;
      syncEl = [ic('drive', 15), `이 컴퓨터에만 있는 데이터 ${sy.localOnly.groups || sy.localOnly.files}개`];
    } else syncEl = [ic('cloudCheck', 15), `서버와 맞춤 · ${ago(sy.at)}`];
    c.sync.className = `sync ${warn ? 'warn' : ''}`;
    c.sync.title = sy?.localOnly?.files
      ? `서버 보관 ${a.coldStorage?.days || 30}일 경과. 이 PC에 남아 있고, 다시 쓰면 서버에 올라가요.`
      : sy?.error || '';
    put(c.sync, ...syncEl);
    c.more.style.display = a.installed || a.running || a.release?.notes ? '' : 'none';
  }

  // 웹: 이 PC 에 무엇이 설치돼 있는지는 모르니, Windows PC 면 통합 클라우드 앱에 ‘PC에 설치’·‘PC에서 실행’을 부탁한다
  fillWebCard(c, a) {
    put(c.ver, h('span', {}, a.release ? `PC 프로그램 · 최신 ${a.release.version}` : 'PC 프로그램 · 아직 배포 전'));
    c.task.style.display = 'none';
    const canOpen = !!this.store.state.client?.canOpenApp;
    c.sync.className = 'sync';
    c.sync.style.display = canOpen ? 'none' : ''; // 버튼 셋이 한 줄에 들어가게
    c.sync.title = canOpen ? '' : 'Windows PC의 통합 클라우드 앱에서 사용해요';
    if (canOpen) put(c.sync);
    else put(c.sync, ic('monitor', 15), 'Windows PC에서 사용해요');
    const key = `web|${canOpen}|${!!a.release}`;
    if (c._primary !== key) {
      c._primary = key;
      c.primary.className = 'btn primary';
      c.primary.style.display = canOpen ? '' : 'none';
      c.primary.disabled = !a.release;
      put(c.primary, ...(a.release ? [ic('play', 18)] : []), document.createTextNode(a.release ? 'PC에서 실행' : '준비 중'));
      c.second.style.display = canOpen && a.release ? '' : 'none';
      put(c.second, document.createTextNode('PC에 설치'));
    }
    c.more.style.display = a.release?.notes ? '' : 'none';
  }

  /** 이 화면이 안드로이드 휴대폰 브라우저인지 (안드로이드 항목을 바로 받을 수 있음) */
  onPhone() {
    return this.web && this.store.state.client?.os === 'android';
  }

  // 안드로이드 항목: 설치·동기화는 없고, 휴대폰에서 내려받기만
  fillPhoneCard(c, a) {
    put(c.ver, h('span', {}, a.release ? `안드로이드 · 최신 ${a.release.version}${a.release.size ? ` · ${bytes(a.release.size)}` : ''}` : '안드로이드 · 아직 배포 전'));
    c.task.style.display = 'none';
    c.sync.className = 'sync';
    c.sync.title = '';
    put(c.sync);
    const here = this.onPhone();
    const key = `phone|${here}|${!!a.release}`;
    if (c._primary !== key) {
      c._primary = key;
      c.primary.className = `btn ${here ? 'primary' : 'soft'}`;
      c.primary.style.display = '';
      c.primary.disabled = !a.release;
      put(c.primary, ...(a.release ? [ic(here ? 'download' : 'phone', 18)] : []), document.createTextNode(!a.release ? '준비 중' : here ? '내려받기' : '휴대폰으로 받기'));
    }
    c.more.style.display = a.release ? '' : 'none'; // ⋯ 에는 언제나 ‘이 기기에서 받기’
  }

  // 웹 프로그램: 설치·동기화 없이 브라우저에서 열기만 (로그인은 통합 클라우드 계정으로)
  fillLinkCard(c, a) {
    const host = (() => {
      try {
        return new URL(a.url).host;
      } catch {
        return '';
      }
    })();
    put(c.ver, h('span', {}, host ? `웹 프로그램 · ${host}` : '웹 프로그램'));
    c.task.style.display = 'none';
    c.sync.className = 'sync';
    c.sync.style.display = '';
    c.sync.title = '';
    put(c.sync, ic('globe', 15), '브라우저에서 열려요');
    const key = `link|${!!a.url}`;
    if (c._primary !== key) {
      c._primary = key;
      c.primary.className = 'btn primary';
      c.primary.style.display = '';
      c.primary.disabled = !a.url;
      put(c.primary, ...(a.url ? [ic('external', 18)] : []), document.createTextNode(a.url ? '열기' : '준비 중'));
      c.second.style.display = 'none';
    }
    c.more.style.display = 'none'; // 설치·업데이트·동기화·자동 실행·바로 가기·데이터가 없음
  }

  /** 이 기기에서 APK 를 받는다 (10분짜리 주소). 앱에서는 기본 브라우저가 받음. */
  async downloadHere(a) {
    const r = await this.cloud.api('POST', `/api/apps/${encodeURIComponent(a.id)}/download-link`, {});
    if (this.web) location.href = r.url;
    else {
      await this.cloud.openExternal(`${this.store.state.config.serverUrl}${r.url}`);
      toast('브라우저에서 내려받기를 시작해요', 'success');
    }
  }

  /** 안드로이드 기기면 바로 받고, 아니면 휴대폰·태블릿에서 받는 방법을 알려 줌 */
  getPhoneApp(a) {
    return this.onPhone() ? this.downloadHere(a) : this.phoneGuide(a);
  }

  /** 휴대폰·태블릿에서 받는 방법 (사이트 주소). 지금 이 기기에서 바로 받을 수도 있음 */
  async phoneGuide(a) {
    const site = this.store.state.config.serverUrl || location.origin;
    const copy = btn('복사', { variant: 'white', size: 'sm', iconName: 'copy' });
    copy.addEventListener('click', async () => {
      try {
        await this.cloud.copy(site);
        toast('주소를 복사했어요', 'success', 1600);
      } catch (e) {
        toast(errorText(e), 'error');
      }
    });
    const here = btn('이 기기에서 받기', { variant: 'subtle', iconName: 'download', title: 'APK 파일 내려받기' });
    const shown = dialog({
      title: `${a.name}은(는) 휴대폰에서 받아요`,
      sub: '안드로이드에서 아래 주소에 로그인해 내려받아요.',
      body: h(
        'div',
        {},
        h('div', { class: 'secret' }, h('span', { class: 'mono' }, site), copy),
        h('div', { class: 'note', style: { marginTop: '12px' } }, ic('info', 18), h('span', {}, '설치 시 ‘알 수 없는 앱 설치’ 허용이 필요해요.')),
      ),
      ok: '확인',
      cancel: null,
      footLeft: here,
    });
    const close = dialog.okButton;
    here.addEventListener('click', () =>
      busy(here, async () => {
        try {
          await this.downloadHere(a);
          close?.click();
        } catch (e) {
          toast(errorText(e), 'error');
        }
      }),
    );
    await shown;
  }

  async primary(a) {
    try {
      if (a.platform === 'android') {
        if (a.release) await this.getPhoneApp(a);
        return;
      }
      if (a.platform === 'web') {
        if (!a.url) return;
        if (this.web) window.open(a.url, '_blank', 'noopener');
        else {
          await this.cloud.openExternal(a.url);
          toast(`브라우저에서 ${a.name}을(를) 열어요`, 'success', 1800);
        }
        return;
      }
      if (this.web) {
        if (a.release) await openInApp(this.cloud, this.store, a.id);
        return;
      }
      if (!a.running && (!a.installed || a.updateAvailable)) {
        await this.cloud.install(a.id);
        return;
      }
      await this.launch(a);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  async launch(a) {
    const r = await this.cloud.launch(a.id);
    if (r?.needsLegacy) {
      await askLegacy(this.cloud, a.id, r.needsLegacy, this.store);
      await this.cloud.launch(a.id, { skipLegacyCheck: true });
    }
  }

  async openMenu(anchor, a) {
    let legacy = [];
    if (!this.web && a.installed && !['web', 'android'].includes(a.platform)) {
      try { legacy = await this.cloud.legacyDetect(a.id); } catch (e) { toast(errorText(e), 'error'); }
    }
    const items = [];
    if (a.platform === 'android' && a.release) {
      // 기기를 잘못 알아봐도(태블릿 등) 언제든 이 기기에서 받을 수 있게
      items.push({ icon: 'download', label: '이 기기에서 받기', onClick: () => this.downloadHere(a).catch((e) => toast(errorText(e), 'error')) });
      if (this.onPhone()) items.push({ icon: 'phone', label: '다른 휴대폰에서 받는 방법', onClick: () => this.phoneGuide(a) });
    }
    if (a.installed) {
      items.push(
        { icon: 'folder', label: '데이터 폴더 열기', onClick: () => this.cloud.openData(a.id, 'sync') },
      );
      if (a.sync?.conflicts?.length) items.push({ icon: 'copy', label: '따로 보관한 파일 보기', onClick: () => this.cloud.openData(a.id, 'conflicts') });
      if (legacy.length) items.push({
        icon: 'history',
        label: '예전 데이터 가져오기',
        onClick: async () => {
          try {
            const list = await this.cloud.legacyDetect(a.id);
            if (!list.length) return notify('예전 데이터를 찾지 못했어요', '이 컴퓨터에는 따로 설치해서 쓰던 데이터가 없어요.');
            await askLegacy(this.cloud, a.id, list, this.store);
          } catch (e) {
            toast(errorText(e), 'error');
          }
        },
      });
      const autoBox = h('span', { class: 'end' }, a.autoLaunch ? ic('check', 16, 2.6) : '');
      items.push({
        icon: 'power',
        label: '윈도우 시작 시 실행',
        end: autoBox,
        onClick: () => {
          const alsoCloud = !a.autoLaunch && !this.store.state.config.autoStart; // 통합 클라우드 자동 실행도 함께 켜짐
          this.cloud.setAutoLaunch(a.id, !a.autoLaunch);
          toast(
            !a.autoLaunch ? `윈도우가 켜지면 ${a.name}도 실행해요${alsoCloud ? ' (통합 클라우드 자동 실행도 켰어요)' : ''}` : `${a.name}은(는) 윈도우가 켜져도 실행하지 않아요`,
            'success',
          );
        },
      });
      if (this.store.state.shortcuts) {
        // 바로 가기를 누르면 통합 클라우드가 이 계정으로 켜 줌 (시작 메뉴에는 언제나 있음)
        const deskBox = h('span', { class: 'end' }, a.desktopShortcut ? ic('check', 16, 2.6) : '');
        items.push({
          icon: 'monitor',
          label: '바탕 화면 바로 가기',
          end: deskBox,
          onClick: async () => {
            try {
              await this.cloud.setDesktopShortcut(a.id, !a.desktopShortcut);
              toast(!a.desktopShortcut ? `바탕 화면에 ${a.name} 바로 가기를 만들었어요` : `바탕 화면의 ${a.name} 바로 가기를 지웠어요`, 'success');
            } catch (e) {
              toast(errorText(e), 'error');
            }
          },
        });
      }
    }
    if (a.release?.notes) {
      items.push({ icon: 'history', label: `${a.release.version} 새로워진 점`, onClick: () => notify(`${a.name} ${a.release.version}`, a.release.notes.replace(/^#+\s*/gm, '').replace(/\*\*/g, '')) });
    }
    if (a.running) items.push({ icon: 'stop', label: '끄기', onClick: () => this.stopApp(a) });
    if (a.installed) items.push('-', { icon: 'trash', label: '삭제', danger: true, onClick: () => this.uninstall(a) });
    menu(anchor, items);
  }

  async stopApp(a) {
    const ok = await dialog({ title: `${a.name}을(를) 끌까요?`, sub: '저장하지 않은 내용은 사라질 수 있어요.', ok: '끄기', danger: true });
    if (ok) this.cloud.stop(a.id);
  }

  async uninstall(a) {
    if (a.running) return notify('프로그램이 켜져 있어요', `${a.name}을(를) 먼저 꺼 주세요.`);
    let removeData = false;
    const info = await this.cloud.dataInfo(a.id).catch(() => null);
    const localOnly = a.sync?.localOnly?.files || 0;
    const warnBox = h('div', { class: 'note danger', style: { display: 'none', marginTop: '12px' } }, ic('warning', 18), h('span', {}, `이 컴퓨터에만 있는 데이터 ${localOnly}개는 지우면 복구할 수 없어요.`));
    const ok = await dialog({
      title: `${a.name}을(를) 삭제할까요?`,
      sub: '데이터는 서버와 이 컴퓨터에 남아요.',
      body: h(
        'div',
        {},
        checkbox(`이 컴퓨터에 받아 둔 데이터도 지우기${info ? ` (${bytes(info.sync.bytes + info.local.bytes)})` : ''}`, false, (on) => {
          removeData = on;
          warnBox.style.display = on && localOnly ? '' : 'none';
        }),
        warnBox,
      ),
      ok: '삭제',
      danger: true,
      onOk: () => this.cloud.uninstall(a.id, { removeData }),
    });
    return ok;
  }
}
