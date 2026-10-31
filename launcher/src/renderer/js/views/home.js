// 프로그램 화면: 설치·열기·업데이트·삭제, 동기화 상태 (Creative Cloud 처럼)
import { h, ic, btn, busy, toast, dialog, notify, menu, checkbox, bytes, ago, ROLE, put } from '../ui.js';

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
        l.importedBy ? h('div', { class: 'row-desc hl' }, `이 컴퓨터에서 ${l.importedBy} 계정으로 이미 가져온 적이 있어요`) : null,
      ),
    ),
  );
  const ok = await dialog({
    title: '예전 데이터를 가져올까요?',
    sub: `이 컴퓨터에 따로 설치해서 쓰던 ${app?.name || '프로그램'} 데이터가 있어요.\n내 계정으로 가져오면 다른 컴퓨터에서도 같이 쓸 수 있어요. (예전 데이터는 그대로 남아요)`,
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

/** 웹: magoedu:// 로 PC 앱을 연다 (id 가 있으면 그 프로그램 실행). 안 열리면 내려받기 안내. */
export async function openInApp(cloud, store, id) {
  const r = await (id ? cloud.launch(id) : cloud.openApp());
  if (r?.opened) return;
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
    const syncAll = this.web ? null : btn('모두 동기화', { variant: 'white', iconName: 'refresh' });
    syncAll?.addEventListener('click', () =>
      busy(syncAll, async () => {
        await cloud.syncAll();
        toast('동기화했어요', 'success', 1800);
      }),
    );
    const reload = btn('', { variant: 'white', iconName: 'rotate', title: '목록 새로 고침' });
    reload.addEventListener('click', () => busy(reload, () => cloud.refreshApps().catch((e) => toast(e.message, 'error'))));
    this.notice = h('div');
    this.webNote = this.web ? this.makeWebNote(s) : null;
    this.grid = h('div', { class: 'apps-grid' });
    this.empty = h(
      'div',
      { class: 'card empty', style: { display: 'none' } },
      ic('box', 40, 1.6),
      h('div', { style: { fontWeight: 600, color: 'var(--grey700)', fontSize: '15px' } }, '쓸 수 있는 프로그램이 없어요'),
      h('div', { class: 'muted', style: { marginTop: '4px' } }, '원장님이나 운영자에게 프로그램 사용 권한을 받아 주세요.'),
    );
    this.el = h(
      'div',
      {},
      h('div', { class: 'page-head' }, h('div', { class: 'tt' }, h('h1', { class: 'title' }, '프로그램'), this.sub), h('div', { class: 'right' }, reload, syncAll)),
      this.notice,
      this.webNote,
      this.grid,
      this.empty,
    );
    this.update(s);
  }

  makeWebNote(s) {
    if (!s.client?.canOpenApp) {
      return h('div', { class: 'note', style: { marginBottom: '16px' } }, ic('info', 18), h('span', {}, '프로그램은 Windows PC의 통합 클라우드 앱에서 쓸 수 있어요. 여기서는 공지·계정·관리 기능을 쓸 수 있어요.'));
    }
    const open = btn('통합 클라우드 열기', { variant: 'primary', size: 'sm', iconName: 'cloud' });
    open.addEventListener('click', () => openInApp(this.cloud, this.store).catch((e) => toast(e.message, 'error')));
    const download = s.launcher ? h('a', { class: 'btn white sm', href: '/download/launcher' }, ic('download', 16), '앱 내려받기') : null;
    return h(
      'div',
      { class: 'note', style: { marginBottom: '16px' } },
      ic('info', 18),
      h(
        'div',
        { style: { flex: 1, minWidth: 0 } },
        h('div', {}, '프로그램 설치·실행과 데이터 동기화는 PC의 통합 클라우드 앱에서 해요. ‘앱에서 열기’를 누르면 앱이 열리고 바로 실행돼요.'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' } }, open, download),
      ),
    );
  }

  update(s) {
    const u = s.user;
    const who = u.name === ROLE[u.role] ? u.name : `${u.name} ${ROLE[u.role]}`;
    this.sub.textContent = `안녕하세요, ${who}${who.endsWith('님') ? '' : '님'}${u.academy ? ` · ${u.academy.name}` : ''}`;
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
    c.more = btn('', { iconName: 'more', title: '더 보기' });
    c.el = h(
      'div',
      { class: 'app-card' },
      h('div', { class: 'app-head' }, c.icon, h('div', { style: { minWidth: 0 } }, c.name, c.ver)),
      c.desc,
      c.task,
      h('div', { class: 'app-foot' }, c.sync, c.more, c.primary),
    );
    c.primary.addEventListener('click', () => this.primary(c.app));
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
    if (this.web) return this.fillWebCard(c, a);

    const ver = [];
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
      label = '켜져 있음';
      variant = 'soft';
      iconName = 'circleCheck';
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
    else if (!sy) syncEl = [ic('cloud', 15), '아직 동기화 전'];
    else if (sy.status === 'syncing') syncEl = [h('span', { class: 'spinner', style: { width: '13px', height: '13px', borderWidth: '2px' } }), '동기화 중'];
    else if (sy.status === 'offline') syncEl = [ic('cloudOff', 15), '연결되면 동기화해요'];
    else if (sy.status === 'error') {
      warn = true;
      syncEl = [ic('alert', 15), '동기화 실패'];
    } else if (sy.quotaExceeded) {
      warn = true;
      syncEl = [ic('warning', 15), '서버 용량이 꽉 찼어요'];
    } else if (sy.localOnly?.files) {
      warn = true;
      syncEl = [ic('drive', 15), `이 컴퓨터에만 있는 데이터 ${sy.localOnly.groups || sy.localOnly.files}개`];
    } else syncEl = [ic('cloudCheck', 15), `동기화됨 · ${ago(sy.at)}`];
    c.sync.className = `sync ${warn ? 'warn' : ''}`;
    c.sync.title = sy?.localOnly?.files
      ? `오래 쓰지 않아 서버 보관 기간(${a.coldStorage?.days || 30}일)이 지난 데이터예요. 이 컴퓨터에는 그대로 있고, 다시 쓰면 서버에 다시 올라가요.`
      : sy?.error || '';
    put(c.sync, ...syncEl);
    c.more.style.display = a.installed || a.release ? '' : 'none';
  }

  // 웹: 설치·동기화 상태는 없고, Windows PC 면 ‘앱에서 열기’만
  fillWebCard(c, a) {
    put(c.ver, h('span', {}, a.release ? `최신 ${a.release.version}` : '아직 배포 전'));
    c.task.style.display = 'none';
    put(c.sync);
    const canOpen = !!this.store.state.client?.canOpenApp;
    const key = `web|${canOpen}|${!!a.release}`;
    if (c._primary !== key) {
      c._primary = key;
      c.primary.className = 'btn primary';
      c.primary.style.display = canOpen ? '' : 'none';
      c.primary.disabled = !a.release;
      put(c.primary, ...(a.release ? [ic('play', 18)] : []), document.createTextNode(a.release ? '앱에서 열기' : '준비 중'));
    }
    c.more.style.display = a.release?.notes ? '' : 'none';
  }

  async primary(a) {
    try {
      if (this.web) {
        if (a.release) await openInApp(this.cloud, this.store, a.id);
        return;
      }
      if (!a.installed || a.updateAvailable) {
        await this.cloud.install(a.id);
        return;
      }
      if (a.running) {
        toast(`${a.name}은(는) 이미 켜져 있어요. 작업 표시줄이나 트레이를 확인해 주세요.`, 'info');
        return;
      }
      await this.launch(a);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async launch(a) {
    const r = await this.cloud.launch(a.id);
    if (r?.needsLegacy) {
      await askLegacy(this.cloud, a.id, r.needsLegacy, this.store);
      await this.cloud.launch(a.id, { skipLegacyCheck: true });
    }
  }

  openMenu(anchor, a) {
    const items = [];
    if (a.installed) {
      items.push(
        { icon: 'refresh', label: '지금 동기화', onClick: () => this.cloud.sync(a.id).then((r) => r && toast('동기화했어요', 'success', 1600)) },
        { icon: 'folder', label: '데이터 폴더 열기', onClick: () => this.cloud.openData(a.id, 'sync') },
      );
      if (a.sync?.conflicts?.length) items.push({ icon: 'copy', label: '따로 보관한 파일 보기', onClick: () => this.cloud.openData(a.id, 'conflicts') });
      items.push({
        icon: 'history',
        label: '예전 데이터 가져오기',
        onClick: async () => {
          try {
            const list = await this.cloud.legacyDetect(a.id);
            if (!list.length) return notify('예전 데이터를 찾지 못했어요', '이 컴퓨터에는 따로 설치해서 쓰던 데이터가 없어요.');
            await askLegacy(this.cloud, a.id, list, this.store);
          } catch (e) {
            toast(e.message, 'error');
          }
        },
      });
      const autoBox = h('span', { class: 'end' }, a.autoLaunch ? ic('check', 16, 2.6) : '');
      items.push({
        icon: 'power',
        label: '통합 클라우드와 함께 켜기',
        end: autoBox,
        onClick: () => {
          this.cloud.setAutoLaunch(a.id, !a.autoLaunch);
          toast(!a.autoLaunch ? `컴퓨터를 켜면 ${a.name}도 함께 켜요` : `${a.name} 자동 실행을 껐어요`, 'success');
        },
      });
    }
    if (a.release?.notes) {
      items.push({ icon: 'sparkles', label: `${a.release.version} 새로워진 점`, onClick: () => notify(`${a.name} ${a.release.version}`, a.release.notes.replace(/^#+\s*/gm, '').replace(/\*\*/g, '')) });
    }
    if (a.running) items.push({ icon: 'stop', label: '끄기', onClick: () => this.stopApp(a) });
    if (a.installed) items.push('-', { icon: 'trash', label: '삭제', danger: true, onClick: () => this.uninstall(a) });
    menu(anchor, items);
  }

  async stopApp(a) {
    const ok = await dialog({ title: `${a.name}을(를) 끌까요?`, sub: '저장하지 않은 내용이 있으면 프로그램에서 먼저 저장해 주세요.', ok: '끄기', danger: true });
    if (ok) this.cloud.stop(a.id);
  }

  async uninstall(a) {
    if (a.running) return notify('프로그램이 켜져 있어요', `${a.name}을(를) 먼저 꺼 주세요.`);
    let removeData = false;
    const info = await this.cloud.dataInfo(a.id).catch(() => null);
    const localOnly = a.sync?.localOnly?.files || 0;
    const warnBox = h('div', { class: 'note danger', style: { display: 'none', marginTop: '12px' } }, ic('warning', 18), h('span', {}, `이 컴퓨터에만 있는 데이터 ${localOnly}개(서버 보관 기간이 지난 것)는 지우면 되살릴 수 없어요.`));
    const ok = await dialog({
      title: `${a.name}을(를) 삭제할까요?`,
      sub: '프로그램만 지우고, 데이터는 서버와 이 컴퓨터에 그대로 남아요. 다시 설치하면 이어서 쓸 수 있어요.',
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
