// 마고에듀 통합 클라우드 화면 - 구현민 개발
import { h, ic, btn, busy, field, input, passwordInput, toast, dialog, notify, reveal, initial, ROLE, put, useCloud } from './ui.js';
import { HomeView, askLegacy } from './views/home.js';
import { NoticesView } from './views/notices.js';
import { AccountView } from './views/account.js';
import { PeopleView } from './views/people.js';
import { CodesView } from './views/codes.js';
import { AppsAdminView } from './views/apps-admin.js';
import { AuditView } from './views/audit.js';
import { ServerView } from './views/server.js';
import { SettingsView } from './views/settings.js';

// 앱은 preload 의 window.cloud, 웹은 같은 서버 API 로 바로
const cloud = window.cloud || (await import('./web-cloud.js')).createWebCloud();
useCloud(cloud);
const root = document.getElementById('root');

export const store = {
  state: null,
  listeners: new Set(),
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
};

function navFor(user) {
  const items = [
    { id: 'home', icon: 'apps', label: '프로그램' },
    { id: 'notices', icon: 'megaphone', label: '공지사항' },
    { id: 'account', icon: 'user', label: '내 계정' },
  ];
  if (user.role === 'director') items.push({ id: 'teachers', icon: 'users', label: '선생님 관리' });
  if (user.role === 'admin') {
    items.push(
      { section: '운영' },
      { id: 'people', icon: 'users', label: '계정 관리' },
      { id: 'codes', icon: 'ticket', label: '원장 가입 코드' },
      { id: 'apps-admin', icon: 'box', label: '프로그램 관리' },
      { id: 'audit', icon: 'activity', label: '활동 기록' },
      { id: 'server', icon: 'server', label: '서버 설정' },
    );
  }
  items.push({ section: '' }, { id: 'settings', icon: 'sliders', label: '설정' });
  return items;
}

const VIEWS = {
  home: HomeView,
  notices: NoticesView,
  account: AccountView,
  teachers: PeopleView,
  people: PeopleView,
  codes: CodesView,
  'apps-admin': AppsAdminView,
  audit: AuditView,
  server: ServerView,
  settings: SettingsView,
};

// ---------------------------------------------------------------- 큰 틀
let shell = null;

class Shell {
  constructor() {
    this.view = null;
    this.current = 'home';
    this.navEls = new Map();
    const web = store.state.web;
    this.page = h('div', { class: 'page' });
    this.offline = h(
      'div',
      { class: 'offline-bar', style: { display: 'none' } },
      ic('cloudOff', 16),
      web ? '서버에 연결되지 않았어요. 인터넷 연결을 확인해 주세요.' : '서버에 연결되지 않았어요. 설치한 프로그램은 그대로 쓸 수 있고, 연결되면 알아서 동기화해요.',
    );
    this.pill = h('div', { class: 'nav-pill' });
    this.nav = h('nav', { class: 'nav' }, this.pill);
    this.foot = h('div', { class: 'sidebar-foot' });
    this.sidebar = h(
      'aside',
      { class: 'sidebar' },
      h('div', { class: 'brand' }, h('img', { class: 'logo', src: 'logo.svg', alt: '' }), h('div', {}, h('div', { class: 'brand-title' }, '마고에듀 클라우드'), h('div', { class: 'brand-sub' }, web ? '웹' : `버전 ${store.state.version}`))),
      this.nav,
      this.foot,
    );
    // 휴대폰·태블릿(960px 이하): 위 막대 + 왼쪽에서 나오는 메뉴
    this.menuBtn = btn('', { variant: 'subtle', iconName: 'menu', title: '메뉴', onClick: () => this.toggleNav() });
    this.menuBtn.setAttribute('aria-expanded', 'false');
    this.topTitle = h('div', { class: 'topbar-title' });
    this.topNotice = btn('', { variant: 'subtle', iconName: 'megaphone', title: '새 공지', cls: 'topbar-notice', onClick: () => this.go('notices') });
    this.topNotice.style.display = 'none';
    this.topbar = h('header', { class: 'topbar' }, this.menuBtn, h('img', { class: 'logo sm', src: 'logo.svg', alt: '' }), this.topTitle, this.topNotice);
    this.scrim = h('div', { class: 'scrim', onClick: () => this.toggleNav(false) });
    this.el = h('div', { class: 'shell' }, this.sidebar, this.scrim, h('main', { class: 'main' }, this.topbar, this.offline, this.page));
    this.buildNav();
  }

  toggleNav(open = !this.el.classList.contains('nav-open')) {
    this.el.classList.toggle('nav-open', open);
    this.menuBtn.setAttribute('aria-expanded', String(open));
  }

  buildNav() {
    const user = store.state.user;
    put(this.nav, this.pill);
    this.navEls.clear();
    for (const it of navFor(user)) {
      if (it.section !== undefined) {
        this.nav.append(it.section ? h('div', { class: 'nav-section' }, it.section) : h('div', { style: { height: '10px' } }));
        continue;
      }
      const el = h('div', { class: 'nav-item', dataset: { id: it.id } }, ic(it.icon, 20), h('span', {}, it.label));
      el.addEventListener('click', () => this.go(it.id));
      this.nav.append(el);
      this.navEls.set(it.id, el);
    }
    this.renderFoot();
    this.markNav(false);
  }

  renderFoot() {
    const s = store.state;
    const u = s.user;
    const items = [];
    if (s.update?.status === 'ready') {
      const card = h('div', { class: 'update-card' }, ic('sparkles', 18), h('span', {}, `새 버전 ${s.update.version} 설치`));
      card.addEventListener('click', async () => {
        if (await dialog({ title: '통합 클라우드를 업데이트할까요?', sub: '잠깐 꺼졌다가 다시 켜져요. 켜져 있는 프로그램은 그대로 계속 돌아가요.', ok: '업데이트' })) {
          await cloud.installUpdate();
        }
      });
      items.push(card);
    }
    const out = btn('', { variant: 'subtle', size: 'sm', iconName: 'logout', title: '로그아웃' });
    out.addEventListener('click', () => logoutFlow());
    items.push(
      h(
        'div',
        { class: 'me-chip' },
        h('div', { class: 'avatar' }, initial(u.name)),
        h('div', { class: 'who' }, h('div', { class: 'nm' }, u.name), h('div', { class: 'rl' }, `${ROLE[u.role]}${u.academy ? ` · ${u.academy.name}` : ''}`)),
        out,
      ),
      h('div', { class: 'dev-credit' }, '구현민 개발'),
    );
    put(this.foot, ...items);
    this._footKey = `${u.name}|${u.role}|${u.academy?.name}|${s.update?.status}`;
  }

  markNav(animate = true) {
    const el = this.navEls.get(this.current) || this.navEls.get(this.current === 'people' ? 'teachers' : 'home');
    for (const [, n] of this.navEls) n.classList.toggle('active', n === el);
    this.topTitle.textContent = el?.querySelector('span')?.textContent || '';
    if (!el) return;
    if (!animate) this.pill.style.transition = 'none';
    this.pill.style.transform = `translateY(${el.offsetTop + 2}px)`;
    if (!animate) requestAnimationFrame(() => (this.pill.style.transition = ''));
  }

  go(id, opts = {}) {
    if (!VIEWS[id]) id = 'home';
    if (id === 'people' && store.state.user.role === 'director') id = 'teachers';
    const same = id === this.current && this.view;
    this.current = id;
    this.toggleNav(false);
    if (store.state.web && !opts.fromHistory) {
      // 웹: 주소에 화면을 남겨 뒤로 가기가 되게
      const hash = `#/${id}`;
      if (location.hash !== hash) {
        if (opts.replace) history.replaceState(null, '', hash);
        else history.pushState(null, '', hash);
      }
    }
    this.markNav();
    if (same && !opts.force) {
      this.view.onNav?.(opts);
      return;
    }
    this.view?.destroy?.();
    const View = VIEWS[id];
    this.page.scrollTop = 0;
    this.view = new View({ cloud, store, go: (v, o) => this.go(v, o), mode: id, opts });
    put(this.page, this.view.el);
    reveal(this.view.el);
    this.view.update?.(store.state);
  }

  update(s) {
    this.offline.style.display = s.online ? 'none' : '';
    const n = s.unreadNotices;
    const nEl = this.navEls.get('notices');
    if (nEl) {
      nEl.querySelector('.badge-num')?.remove();
      if (n > 0) nEl.append(h('span', { class: 'badge-num' }, n > 9 ? '9+' : n));
    }
    this.topNotice.querySelector('.badge-num')?.remove();
    this.topNotice.style.display = n > 0 ? '' : 'none';
    if (n > 0) this.topNotice.append(h('span', { class: 'badge-num' }, n > 9 ? '9+' : n));
    const sEl = this.navEls.get('settings');
    if (sEl) {
      sEl.querySelector('.badge-dot')?.remove();
      if (s.update?.status === 'ready') sEl.append(h('span', { class: 'badge-dot' }));
    }
    const key = `${s.user.name}|${s.user.role}|${s.user.academy?.name}|${s.update?.status}`;
    if (key !== this._footKey) this.renderFoot();
    this.view?.update?.(s);
  }
}

async function logoutFlow() {
  const running = store.state.apps.filter((a) => a.running);
  const ok = await dialog({
    title: '로그아웃할까요?',
    sub: store.state.web
      ? '이 브라우저에서만 로그아웃해요. 다른 기기는 그대로예요.'
      : running.length
        ? `켜져 있는 프로그램(${running.map((a) => a.name).join(', ')})은 계속 돌아가지만, 다시 로그인할 때까지 동기화하지 않아요.`
        : '이 컴퓨터에 받아 둔 데이터는 그대로 남아요.',
    ok: '로그아웃',
  });
  if (ok) await cloud.logout();
}

// ---------------------------------------------------------------- 로그인 전 화면
function authFrame(...children) {
  const s = store.state;
  const card = h(
    'div',
    { class: 'auth-card' },
    ...children,
    h('div', { class: 'auth-foot' }, `마고에듀 통합 클라우드 ${s.version} · 구현민 개발`),
  );
  const wrap = h('div', { class: 'auth' }, card);
  reveal(card);
  return wrap;
}

function authHead(title, sub) {
  return h('div', { class: 'auth-head' }, h('img', { class: 'logo lg', src: 'logo.svg', alt: '' }), h('h1', {}, title), sub ? h('p', {}, sub) : null);
}

function serverView({ back } = {}) {
  const url = input({ cls: 'lg', placeholder: '예: http://192.168.0.10:8470', value: store.state.config.serverUrl || '' });
  const err = h('div', { class: 'error-text', style: { display: 'none' } });
  const go = btn('연결', { variant: 'primary', size: 'lg', cls: 'block' });
  const submit = () =>
    busy(go, async () => {
      err.style.display = 'none';
      try {
        await cloud.setServer(url.value);
        toast('서버에 연결했어요', 'success');
      } catch (e) {
        err.textContent = e.message;
        err.style.display = '';
      }
    });
  go.addEventListener('click', submit);
  url.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  return authFrame(
    authHead('서버 연결', '학원 서버 주소를 운영자에게 받아서 넣어 주세요.'),
    field('서버 주소', url),
    err,
    h('div', { style: { height: '20px' } }),
    go,
    back ? h('div', { class: 'auth-links', style: { justifyContent: 'center' } }, h('button', { class: 'link', onClick: back }, '돌아가기')) : null,
  );
}

function loginView() {
  const s = store.state;
  const user = input({ cls: 'lg', placeholder: '아이디', value: s.config.lastUsername || '', autocomplete: 'username' });
  const pw = passwordInput({ cls: 'lg', placeholder: '비밀번호', autocomplete: 'current-password' });
  const err = h('div', { class: 'error-text', style: { display: 'none' } });
  const go = btn('로그인', { variant: 'primary', size: 'lg', cls: 'block' });
  const submit = () =>
    busy(go, async () => {
      err.style.display = 'none';
      try {
        await cloud.login(user.value, pw.input.value);
      } catch (e) {
        err.textContent = e.message;
        err.style.display = '';
        pw.input.select();
      }
    });
  go.addEventListener('click', submit);
  for (const el of [user, pw.input]) el.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  const host = (() => {
    try {
      return new URL(s.config.serverUrl).host;
    } catch {
      return s.config.serverUrl;
    }
  })();
  const server = h('button', { class: 'link server-chip', title: s.config.serverUrl }, ic('server', 14), h('span', {}, host));
  server.addEventListener('click', () => mount(serverView({ back: () => render(true) })));
  const signup = h('button', { class: 'link' }, '원장 가입 코드가 있어요');
  signup.addEventListener('click', () => mount(signupView()));
  // 웹: 서버 주소는 이 페이지 주소라 바꿀 수 없음, 대신 앱 내려받기
  const download =
    s.web && s.launcher
      ? h('div', { class: 'auth-links', style: { justifyContent: 'center' } }, h('a', { class: 'link', href: '/download/launcher', style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, ic('download', 14), 'Windows 프로그램 내려받기'))
      : null;
  const view = authFrame(
    authHead('마고에듀 통합 클라우드', '학원 계정으로 로그인해 주세요.'),
    s.authMessage ? h('div', { class: 'note warn', style: { marginBottom: '16px' } }, ic('warning', 18), h('span', {}, s.authMessage)) : null,
    field(null, user),
    h('div', { style: { height: '10px' } }),
    field(null, pw),
    err,
    h('div', { style: { height: '20px' } }),
    go,
    s.web ? h('div', { class: 'auth-links', style: { justifyContent: 'center' } }, signup) : h('div', { class: 'auth-links' }, signup, server),
    download,
  );
  setTimeout(() => (user.value ? pw.input : user).focus(), 50);
  return view;
}

function signupView() {
  let step = 1;
  let codeInfo = null;
  const code = input({ cls: 'lg mono', placeholder: 'MAGO-XXXX-XXXX' });
  const academy = input({ placeholder: '예: 마고수학학원' });
  const name = input({ placeholder: '예: 홍길동' });
  const username = input({ placeholder: '영어 소문자·숫자 3자 이상' });
  const pw = passwordInput({ placeholder: '6자 이상' });
  const pw2 = passwordInput({ placeholder: '한 번 더' });
  const err = h('div', { class: 'error-text', style: { display: 'none' } });
  const next = btn('다음', { variant: 'primary', size: 'lg', cls: 'block' });
  const nextLabel = next.lastChild; // busy() 가 잠시 바꿔도 이 글자 노드는 그대로 돌아옴
  const steps = h('div', { class: 'steps' }, h('i', { class: 'on' }), h('i'));
  const body = h('div');
  const showErr = (m) => {
    err.textContent = m;
    err.style.display = m ? '' : 'none';
  };

  const renderStep = () => {
    steps.children[1].classList.toggle('on', step === 2);
    if (step === 1) {
      put(body, field('가입 코드', code, '운영자에게 받은 원장 가입 코드를 넣어 주세요.'));
      nextLabel.textContent = '다음';
      setTimeout(() => code.focus(), 30);
    } else {
      if (codeInfo.academyName) {
        academy.value = codeInfo.academyName;
        academy.disabled = true;
      }
      put(body, 
        field('학원 이름', academy),
        field('이름', name),
        field('아이디', username, '로그인할 때 쓰는 아이디예요. 나중에 바꿀 수 있어요.'),
        field('비밀번호', pw),
        field('비밀번호 확인', pw2),
      );
      nextLabel.textContent = '가입하기';
      setTimeout(() => (academy.disabled ? name : academy).focus(), 30);
    }
    reveal(body);
  };

  const submit = () =>
    busy(next, async () => {
      showErr('');
      try {
        if (step === 1) {
          codeInfo = await cloud.checkCode(code.value.trim());
          step = 2;
          renderStep();
          return;
        }
        if (pw.input.value !== pw2.input.value) throw new Error('비밀번호가 서로 달라요.');
        await cloud.signup({ code: code.value.trim(), academyName: academy.value, name: name.value, username: username.value, password: pw.input.value });
        toast('가입했어요. 환영해요!', 'success');
      } catch (e) {
        showErr(e.message);
      }
    });
  next.addEventListener('click', submit);
  body.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  const back = h('button', { class: 'link' }, '로그인으로 돌아가기');
  back.addEventListener('click', () => {
    if (step === 2) {
      step = 1;
      renderStep();
    } else render(true);
  });
  renderStep();
  return authFrame(authHead('원장 가입', '가입하면 학원과 원장 계정이 만들어지고, 선생님 계정을 직접 만들 수 있어요.'), steps, body, err, h('div', { style: { height: '20px' } }), next, h('div', { class: 'auth-links', style: { justifyContent: 'center' } }, back));
}

// 처음 받은 비밀번호는 로그인하자마자 바꾸게 한다
let askingPassword = false;
async function forcePasswordChange() {
  if (askingPassword) return;
  askingPassword = true;
  const cur = passwordInput({ placeholder: '지금 비밀번호 (받은 비밀번호)' });
  const pw = passwordInput({ placeholder: '6자 이상' });
  const pw2 = passwordInput({ placeholder: '한 번 더' });
  const done = await dialog({
    title: '새 비밀번호를 정해 주세요',
    sub: '처음 받은 비밀번호나 초기화된 비밀번호는 바로 바꿔야 해요.',
    body: h('div', {}, field('지금 비밀번호', cur), field('새 비밀번호', pw), field('새 비밀번호 확인', pw2)),
    ok: '바꾸기',
    cancel: '로그아웃',
    onOk: async () => {
      if (pw.input.value !== pw2.input.value) throw new Error('새 비밀번호가 서로 달라요.');
      await cloud.changePassword(cur.input.value, pw.input.value, false);
    },
  });
  askingPassword = false;
  if (done) toast('비밀번호를 바꿨어요', 'success');
  else await cloud.logout();
}

// ---------------------------------------------------------------- 그리기
let lastPhase = null;
let lastUserKey = null;

function mount(el) {
  shell = null;
  put(root, el);
}

function render(force = false) {
  const s = store.state;
  const userKey = s.user ? `${s.user.id}|${s.user.role}` : null;
  if (!force && s.phase === lastPhase && userKey === lastUserKey) {
    if (shell) shell.update(s);
    return;
  }
  lastPhase = s.phase;
  lastUserKey = userKey;
  if (s.phase === 'boot') return;
  if (s.phase === 'setup') return mount(serverView());
  if (s.phase === 'login') return mount(loginView());
  const prev = shell?.current || (s.web && hashView(s.user)) || 'home';
  shell = new Shell();
  put(root, shell.el);
  shell.go(prev, { force: true, replace: true });
  shell.update(s);
}

/** 웹: 주소 해시(#/notices)가 가리키는 화면 (이 계정 메뉴에 있을 때만) */
function hashView(user) {
  const m = /^#\/([\w-]+)$/.exec(location.hash);
  return m && navFor(user).some((it) => it.id === m[1]) ? m[1] : null;
}

async function start() {
  store.state = await cloud.getState();
  render(true);
  cloud.onState((s) => {
    store.state = s;
    render();
    store.listeners.forEach((fn) => fn(s));
    if (s.phase === 'ready' && s.user?.mustChangePassword) forcePasswordChange();
  });
  cloud.onToast((t) => toast(t.text, t.kind));
  cloud.onNavigate(async (n) => {
    if (!shell) return;
    shell.go(n.view || 'home');
    if (n.legacyFor && n.legacy) await askLegacy(cloud, n.legacyFor, n.legacy, store);
  });
  if (store.state.web) {
    window.addEventListener('popstate', () => {
      if (shell && store.state.phase === 'ready') shell.go(hashView(store.state.user) || 'home', { fromHistory: true });
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shell?.el.classList.contains('nav-open')) shell.toggleNav(false);
  });
  if (store.state.phase === 'ready' && store.state.user?.mustChangePassword) forcePasswordChange();
}

window.addEventListener('error', (e) => console.error(e.error || e.message));
start().catch((e) => notify('화면을 여는 중 문제가 생겼어요', e.message));
