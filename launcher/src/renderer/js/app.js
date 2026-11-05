// 마고에듀 통합 클라우드 화면 - 구현민 개발
import { errorText, h, ic, btn, busy, field, input, passwordInput, toast, dialog, notify, reveal, initial, ROLE, put, useCloud } from './ui.js';
import { HomeView, askLegacy } from './views/home.js';
import { NoticesView } from './views/notices.js';
import { AccountView } from './views/account.js';
import { PeopleView } from './views/people.js';
import { CodesView } from './views/codes.js';
import { AppsAdminView } from './views/apps-admin.js';
import { AuditView } from './views/audit.js';
import { ServerView } from './views/server.js';
import { SettingsView } from './views/settings.js';
import { updateInstallButton } from './update-install.js';
import { StudentsView } from './views/students.js';
import { AcademyAiView } from './views/academy-ai.js';
import { StudentNotesView, StudentNaviView, StudentJoinView } from './views/student.js';

// 앱은 preload 의 window.cloud, 웹은 같은 서버 API 로 바로
const cloud = window.cloud || (await import('./web-cloud.js')).createWebCloud();
useCloud(cloud);
const root = document.getElementById('root');

export const store = {
  state: null,
  listeners: new Set(),
  setUpdate(update) {
    this.state = { ...this.state, update };
    shell?.update(this.state);
  },
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
};

function serverUrl() {
  const config = store.state.config;
  return (config.serverUrl || config.defaultServerUrl || 'https://mago.milky.kr').replace(/\/+$/, '');
}

function navFor(user) {
  const help = { id: 'help', icon: 'help', label: '도움말', title: '브라우저에서 열기' };
  if (user.role === 'student') return [
    { id: 'my-notes', icon: 'list', label: '내 오답노트' },
    { id: 'student-navi', icon: 'graduationCap', label: '마고 과목내비' },
    { id: 'account', icon: 'user', label: '내 계정' },
    help,
  ];
  const items = [
    { id: 'home', icon: 'apps', label: '프로그램' },
    { id: 'notices', icon: 'megaphone', label: '공지사항' },
    { id: 'account', icon: 'user', label: '내 계정' },
  ];
  if (user.academy && user.role !== 'admin') items.push({ id: 'students', icon: 'graduationCap', label: '학생 명단' });
  if (user.role === 'director') items.push({ id: 'teachers', icon: 'users', label: '선생님 관리' });
  if (user.role === 'director' && user.academy) items.push({ id: 'academy-ai', icon: 'key', label: '학원 AI' });
  if (user.role === 'admin') {
    items.push(
      { section: '운영' },
      { id: 'people', icon: 'users', label: '계정 관리' },
      { id: 'students', icon: 'graduationCap', label: '학생 명단' },
      { id: 'academy-ai', icon: 'key', label: '학원 AI' },
      { id: 'codes', icon: 'ticket', label: '원장 가입 코드' },
      { id: 'apps-admin', icon: 'box', label: '프로그램 관리' },
      { id: 'audit', icon: 'activity', label: '활동 기록' },
      { id: 'server', icon: 'server', label: '서버 설정' },
    );
  }
  items.push({ section: '' }, help, { id: 'settings', icon: 'sliders', label: '설정' });
  return items;
}

const VIEWS = {
  'my-notes': StudentNotesView,
  'student-navi': StudentNaviView,
  home: HomeView,
  notices: NoticesView,
  account: AccountView,
  teachers: PeopleView,
  people: PeopleView,
  students: StudentsView,
  'academy-ai': AcademyAiView,
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
      web ? '인터넷 연결을 확인해요. 서버에 연결되지 않았어요.' : '인터넷 연결을 확인해요. 설치한 프로그램은 쓸 수 있어요.',
    );
    this.pill = h('div', { class: 'nav-pill' });
    this.nav = h('nav', { class: 'nav' }, this.pill);
    this.foot = h('div', { class: 'sidebar-foot' });
    this.sidebar = h(
      'aside',
      { class: 'sidebar', id: 'main-menu', 'aria-label': '화면 메뉴' },
      h('div', { class: 'brand' }, h('img', { class: 'logo', src: 'logo.png', alt: '' }), h('div', {}, h('div', { class: 'brand-title' }, '마고에듀 클라우드'), h('div', { class: 'brand-sub' }, web ? '웹' : `버전 ${store.state.version}`))),
      this.nav,
      this.foot,
    );
    this.sidebar.prepend(btn('메뉴 닫기', { variant: 'subtle', iconName: 'x', cls: 'nav-close', onClick: () => this.toggleNav(false) }));
    // 휴대폰·태블릿(960px 이하): 위 막대 + 왼쪽에서 나오는 메뉴
    this.menuBtn = btn('', { variant: 'subtle', iconName: 'menu', title: '메뉴', onClick: () => this.toggleNav() });
    this.menuBtn.setAttribute('aria-expanded', 'false');
    this.menuBtn.setAttribute('aria-controls', 'main-menu');
    this.menuBtn.setAttribute('aria-label', '메뉴 열기');
    this.topTitle = h('div', { class: 'topbar-title' });
    this.topNotice = btn('', { variant: 'subtle', iconName: 'megaphone', title: '새 공지', cls: 'topbar-notice', onClick: () => this.go('notices') });
    this.topNotice.style.display = 'none';
    this.topbar = h('header', { class: 'topbar' }, this.menuBtn, h('img', { class: 'logo sm', src: 'logo.png', alt: '' }), this.topTitle, this.topNotice);
    this.scrim = h('div', { class: 'scrim', onClick: () => this.toggleNav(false) });
    this.main = h('main', { class: 'main' }, this.topbar, this.offline, this.page);
    this.el = h('div', { class: 'shell' }, this.sidebar, this.scrim, this.main);
    this.mobile = matchMedia('(max-width: 960px)');
    this.onResize = () => { if (!this.mobile.matches) this.toggleNav(false); };
    this.mobile.addEventListener('change', this.onResize);
    // 공통 표도 휴대폰 카드에서 각 칸의 뜻을 알 수 있게 해요.
    this.tables = new MutationObserver(() => {
      for (const table of document.querySelectorAll('.table')) {
        const labels = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
        for (const row of table.querySelectorAll('tbody tr')) {
          [...row.children].forEach((cell, i) => {
            cell.dataset.label = cell.colSpan > 1 ? '' : labels[i] || '';
          });
        }
      }
    });
    this.tables.observe(document.body, { childList: true, subtree: true });
    this.buildNav();
  }

  toggleNav(open = !this.el.classList.contains('nav-open'), fromHistory = false) {
    if (open && (!this.mobile.matches || this.navBackPending)) return;
    const wasOpen = this.el.classList.contains('nav-open');
    if (store.state.web && !fromHistory) {
      if (open && !wasOpen) history.pushState({ mobileNav: true }, '', location.href);
      else if (!open && history.state?.mobileNav && !this.navBackPending) {
        this.navBackPending = true;
        history.back();
      }
    }
    this.el.classList.toggle('nav-open', open);
    this.menuBtn.setAttribute('aria-expanded', String(open));
    this.main.inert = open;
    if (open) this.sidebar.querySelector('.nav-close').focus();
    else if (wasOpen && this.mobile.matches) this.menuBtn.focus();
  }

  destroy() {
    this.view?.destroy?.();
    this.tables.disconnect();
    this.mobile.removeEventListener('change', this.onResize);
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
      const el = h('div', { class: 'nav-item', role: 'button', tabindex: '0', dataset: { id: it.id }, title: it.title }, ic(it.icon, 20), h('span', {}, it.label), it.id === 'help' ? ic('external', 14) : null);
      const pick = () => {
        if (it.id === 'help') {
          const page = { director: 'director.html', teacher: 'teacher.html', student: 'student.html', admin: 'index.html' }[store.state.user.role] || 'index.html';
          if (this.el.classList.contains('nav-open')) this.toggleNav(false);
          cloud.openExternal(`${serverUrl()}/help/${page}`).catch((e) => toast(errorText(e), 'error'));
          return;
        }
        this.go(it.id);
      };
      el.addEventListener('click', pick);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
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
    if (['ready', 'installing', 'deferred'].includes(s.update?.status) || s.update?.canRetryInstall) {
      const card = h('div', { class: 'update-card', role: 'status', 'aria-live': 'polite' },
        h('span', {}, `새 버전 ${s.update.version || ''}`),
        s.update.message ? h('span', { class: 'update-message' }, s.update.status === 'error' ? `업데이트를 설치하지 못했어요: ${s.update.message}` : s.update.message) : null,
        updateInstallButton(cloud, store, { confirm: true }),
      );
      items.push(card);
    }
    const out = btn('', { variant: 'subtle', size: 'sm', iconName: 'logout', title: '로그아웃' });
    out.addEventListener('click', () => { this.toggleNav(false); logoutFlow(); });
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
    this._footKey = `${u.name}|${u.role}|${u.academy?.name}|${JSON.stringify(s.update)}`;
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
    // 서랍 기록을 먼저 닫은 뒤 이동해야 뒤로 가기가 꼬이지 않아요.
    if (store.state.web && !opts.fromHistory && (history.state?.mobileNav || this.navBackPending)) {
      this.pendingNav = { id, opts };
      this.toggleNav(false);
      return;
    }
    const user = store.state.user;
    if (user.role === 'student') {
      if (user.mustChangePassword) id = 'account';
      else if (!navFor(user).some((it) => it.id === id)) id = 'my-notes';
    } else if (id === 'my-notes' || id === 'student-navi') id = 'home';
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
    const n = s.user.role === 'student' ? 0 : s.unreadNotices;
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
    const key = `${s.user.name}|${s.user.role}|${s.user.academy?.name}|${JSON.stringify(s.update)}`;
    if (key !== this._footKey) this.renderFoot();
    this.view?.update?.(s);
  }
}

async function logoutFlow() {
  const running = store.state.apps.filter((a) => a.running);
  await dialog({
    title: '로그아웃할까요?',
    sub: store.state.web
      ? '다른 기기는 로그아웃되지 않아요.'
      : running.length
        ? `켜져 있는 프로그램(${running.map((a) => a.name).join(', ')})을 끄고, 데이터를 서버에 올린 뒤 로그아웃해요.`
        : '이 컴퓨터에 받아 둔 데이터는 그대로 남아요.',
    ok: '로그아웃',
    onOk: () => cloud.logout(),
  });
}

// ---------------------------------------------------------------- 로그인 전 화면
function authFrame(...children) {
  const s = store.state;
  const help = h('button', {
    class: 'link',
    onClick: () => cloud.openExternal(`${serverUrl()}/help/`).catch((e) => toast(e.message, 'error')),
  }, '처음이세요? 사용 설명서 보기');
  const support = children.find((el) => el?.classList?.contains('auth-support'));
  if (support) {
    help.textContent = '사용 설명서';
    support.append(help);
  }
  const card = h(
    'div',
    { class: 'auth-card' },
    ...children,
    support ? null : h('div', { class: 'auth-links', style: { justifyContent: 'center' } }, help),
    h('div', { class: 'auth-foot' }, `마고에듀 통합 클라우드 ${s.version} · 구현민 개발`),
  );
  const wrap = h('div', { class: 'auth' }, card);
  reveal(card);
  return wrap;
}

function authHead(title, sub) {
  return h('div', { class: 'auth-head' }, h('img', { class: 'logo lg', src: 'logo.png', alt: '' }), h('h1', {}, title), sub ? h('p', {}, sub) : null);
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
        store.state = await cloud.getState();
        render(true); // 로그인→서버 연결→로그인은 phase가 같아도 화면을 돌아가게 함
        toast('서버에 연결했어요', 'success');
      } catch (e) {
        err.textContent = errorText(e);
        err.style.display = '';
      }
    });
  go.addEventListener('click', submit);
  url.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  return authFrame(
    authHead('서버 연결', '운영자에게 받은 서버 주소를 입력해요.'),
    field('서버 주소', url),
    err,
    h('div', { style: { height: '20px' } }),
    go,
    back ? h('div', { class: 'auth-links', style: { justifyContent: 'center' } }, h('button', { class: 'link', onClick: back }, '돌아가기')) : null,
  );
}

function loginView() {
  const s = store.state;
  const user = input({ cls: 'lg', placeholder: '아이디', 'aria-label': '아이디', value: s.config.lastUsername || '', autocomplete: 'username' });
  const pw = passwordInput({ cls: 'lg', placeholder: '비밀번호', 'aria-label': '비밀번호', autocomplete: 'current-password' });
  const err = h('div', { class: 'error-text', style: { display: 'none' } });
  const go = btn('로그인', { variant: 'primary', size: 'lg', cls: 'block' });
  const submit = () =>
    busy(go, async () => {
      err.style.display = 'none';
      try {
        await cloud.login(user.value, pw.input.value);
      } catch (e) {
        err.textContent = e.code === 'student_web_only' || /student_web_only/.test(errorText(e)) ? `학생 계정은 인터넷 브라우저에서 ${serverUrl()} 에 들어가서 써요.` : errorText(e);
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
  const signup = h('button', { class: 'link' }, '가입 코드가 있어요');
  signup.addEventListener('click', () => mount(signupView()));
  // 웹: 서버 주소는 이 페이지 주소라 바꿀 수 없음, 대신 앱 내려받기
  const download =
    s.web && s.launcher
      ? h('div', { class: 'auth-links', style: { justifyContent: 'center' } }, h('a', { class: 'link', href: '/download/launcher', style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, ic('download', 14), 'Windows 프로그램 내려받기'))
      : null;
  const view = authFrame(
    authHead('마고에듀 통합 클라우드', ''),
    s.authMessage ? h('div', { class: 'note warn', style: { marginBottom: '16px' } }, ic('warning', 18), h('span', {}, s.authMessage)) : null,
    sso ? h('div', { class: 'note', style: { marginBottom: '16px' } }, ic('info', 18), h('span', {}, '로그인하면 웹 프로그램으로 바로 돌아가요.')) : null,
    field(null, user),
    h('div', { style: { height: '10px' } }),
    field(null, pw),
    err,
    h('div', { style: { height: '20px' } }),
    go,
    s.web ? h('div', { class: 'auth-links', style: { justifyContent: 'center' } }, signup) : h('div', { class: 'auth-links' }, signup, server),
    download,
    h('div', { class: 'auth-links auth-support' }, h('button', {
      class: 'link',
      onClick: () => dialog({
        title: '비밀번호를 잊었어요',
        body: h('div', { class: 'dialog-sub' },
          h('div', {}, '선생님: 원장님께 비밀번호 초기화를 요청하세요.'),
          h('div', {}, '원장님: 운영자에게 문의하세요.'),
          h('div', {}, '학생: 담당 선생님께 비밀번호 초기화를 요청하세요.'),
        ),
        ok: '확인',
        cancel: null,
      }),
    }, '비밀번호를 잊었어요')),
  );
  setTimeout(() => (user.value ? pw.input : user).focus(), 50);
  return view;
}

function joinView({ code, verified } = {}) {
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  const view = new StudentJoinView({ cloud, code: code ?? query.get('code') ?? '', verified, back: () => {
    history.replaceState(null, '', '#/home');
    render(true);
  } });
  return authFrame(authHead('학생 계정 만들기'), view.el);
}

function signupView() {
  let step = 1;
  let codeInfo = null;
  const code = input({ cls: 'lg mono', placeholder: '받은 가입 코드', autocomplete: 'off' });
  const head = authHead('가입 코드 확인', '새 학원이 만들어져요.');
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
      head.querySelector('h1').textContent = '가입 코드 확인';
      head.querySelector('p').style.display = 'none'; // 제목만으로 충분
      put(body, field('가입 코드', code));
      nextLabel.textContent = '다음';
      setTimeout(() => code.focus(), 30);
    } else {
      head.querySelector('h1').textContent = '원장 가입';
      head.querySelector('p').textContent = '새 학원이 만들어져요.';
      head.querySelector('p').style.display = '';
      academy.disabled = false;
      if (codeInfo.academyName) {
        academy.value = codeInfo.academyName;
        academy.disabled = true;
      }
      put(body, 
        field('학원 이름', academy),
        field('이름', name),
        field('아이디', username),
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
          const value = code.value.trim();
          if (!value) throw new Error('코드를 다시 확인해 주세요');
          codeInfo = await cloud.checkCode(value);
          if (value !== code.value.trim()) return;
          if (codeInfo.role === 'student') {
            if (store.state.web) mount(joinView({ code: value, verified: codeInfo }));
            else await cloud.openExternal(`${serverUrl()}/#/join?code=${encodeURIComponent(value)}`);
            return;
          }
          step = 2;
          renderStep();
          return;
        }
        if (pw.input.value !== pw2.input.value) throw new Error('비밀번호가 서로 달라요.');
        await cloud.signup({ code: code.value.trim(), academyName: academy.value, name: name.value, username: username.value, password: pw.input.value });
        toast('가입했어요', 'success');
      } catch (e) {
        showErr(errorText(e));
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
  return authFrame(head, steps, body, err, h('div', { style: { height: '20px' } }), next, h('div', { class: 'auth-links', style: { justifyContent: 'center' } }, back));
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
    sub: '',
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

// ---------------------------------------------------------------- 웹 프로그램 로그인 (웹: #/sso)
// 웹 프로그램(예: 마고 과목내비)이 #/sso?app=<ID>&state=<값> 으로 보내면, 로그인한 계정으로 일회용 코드를 받아 돌려보낸다.
// 로그인 화면을 거쳐 왔으면 다시 묻지 않고 바로 돌려보낸다.
let sso = null; // { app, state, auto }
let ssoPage = null;

function readSso() {
  const m = /^#\/sso(?:\?(.*))?$/.exec(location.hash);
  if (!m) return null;
  const q = new URLSearchParams(m[1] || '');
  return { app: q.get('app') || '', state: q.get('state') || '', auto: false };
}

/** 로그인 요청을 그만두고 통합 클라우드 화면으로 (#/sso 는 방문 기록에 남기지 않음) */
function leaveSso() {
  sso = null;
  history.replaceState(null, '', '#/home');
  render(true);
}

function ssoView() {
  const u = store.state.user;
  const appName = () => store.state.apps.find((a) => a.id === sso.app)?.name || sso.app; // 목록을 받기 전이면 ID
  const names = [h('span', {}, appName()), h('span', {}, appName())];
  const err = h('div', { class: 'error-text', style: { display: 'none', textAlign: 'center', margin: '0 0 14px' } });
  const go = btn('계속', { variant: 'primary', size: 'lg', cls: 'block' });
  const showErr = (m) => {
    err.textContent = m;
    err.style.display = '';
  };
  const submit = () =>
    busy(go, async () => {
      err.style.display = 'none';
      try {
        const r = await cloud.api('POST', '/api/sso/authorize', { appId: sso.app, state: sso.state });
        location.replace(r.redirect);
        await new Promise(() => {}); // 웹 프로그램으로 넘어갈 때까지 돌아가는 표시 그대로
      } catch (e) {
        showErr(errorText(e));
      }
    });
  go.addEventListener('click', submit);
  const other = h('button', { class: 'link' }, '다른 계정으로');
  other.addEventListener('click', async () => {
    sso.auto = true; // 다시 로그인하면 바로 이어서
    await cloud.logout();
  });
  const home = h('button', { class: 'link' }, '통합 클라우드로 가기');
  home.addEventListener('click', leaveSso);
  const el = authFrame(
    authHead(names[0], [names[1], `에 ${u.name}(${u.username}) 계정으로 로그인할까요?`]),
    err,
    go,
    h('div', { class: 'auth-links' }, other, home),
  );
  el.classList.add('sso');
  if (!sso.app) {
    go.style.display = 'none';
    showErr('로그인 주소가 잘못됐어요. 웹 프로그램에서 다시 로그인해 주세요.');
  } else if (sso.auto && !u.mustChangePassword) {
    setTimeout(submit, 0); // 처음 받은 비밀번호면 먼저 바꾸게 하고 ‘계속’을 누르게
  }
  sso.auto = false;
  return {
    el,
    update() {
      const n = appName();
      for (const x of names) if (x.textContent !== n) x.textContent = n;
    },
  };
}

// ---------------------------------------------------------------- 그리기
let lastPhase = null;
let lastUserKey = null;

function mount(el) {
  shell?.destroy();
  shell = null;
  ssoPage = null;
  put(root, el);
}

function render(force = false) {
  const s = store.state;
  const userKey = s.user ? `${s.user.id}|${s.user.role}|${!!s.user.mustChangePassword}` : null;
  if (!force && s.phase === lastPhase && userKey === lastUserKey) {
    if (shell) shell.update(s);
    else ssoPage?.update(s);
    return;
  }
  lastPhase = s.phase;
  lastUserKey = userKey;
  if (s.phase === 'boot') return;
  if (s.phase === 'setup') return mount(serverView());
  if (s.phase === 'login') {
    if (sso) sso.auto = true; // 로그인하면 묻지 않고 바로 웹 프로그램으로
    if (s.web && /^#\/join(?:\?|$)/.test(location.hash)) return mount(joinView());
    return mount(loginView());
  }
  if (sso && !(s.user.role === 'student' && s.user.mustChangePassword)) {
    const page = ssoView();
    mount(page.el);
    ssoPage = page;
    return;
  }
  const prev = shell?.current || (s.web && hashView(s.user)) || 'home';
  shell?.destroy();
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
  if (store.state.web) sso = readSso(); // 앱에서는 #/sso 를 쓰지 않음
  render(true);
  cloud.onState((s) => {
    store.state = s;
    render();
    store.listeners.forEach((fn) => fn(s));
    if (s.phase === 'ready' && s.user?.mustChangePassword && s.user.role !== 'student') forcePasswordChange();
  });
  cloud.onToast((t) => toast(t.text, t.kind));
  cloud.onNavigate(async (n) => {
    if (!shell) return;
    shell.go(n.view || 'home');
    if (n.legacyFor && n.legacy) await askLegacy(cloud, n.legacyFor, n.legacy, store);
  });
  if (store.state.web) {
    const navigate = () => {
      if (shell?.navBackPending) {
        const pending = shell.pendingNav;
        shell.navBackPending = false;
        shell.pendingNav = null;
        shell.toggleNav(false, true);
        if (pending) shell.go(pending.id, pending.opts);
        return;
      }
      if (shell && history.state?.mobileNav && shell.mobile.matches) {
        shell.toggleNav(true, true);
        return;
      }
      if (shell?.el.classList.contains('nav-open')) {
        shell.toggleNav(false, true);
        if (location.hash === `#/${shell.current}`) return;
      }
      if (store.state.phase === 'login' && /^#\/join(?:\?|$)/.test(location.hash)) {
        sso = null;
        render(true);
        return;
      }
      // 주소창에서 #/sso 로 바꾸거나, 거기서 뒤로 가면
      const next = readSso();
      if (next || sso) {
        sso = next;
        render(true);
        return;
      }
      if (shell && store.state.phase === 'ready') shell.go(hashView(store.state.user) || 'home', { fromHistory: true });
      else if (store.state.phase === 'login') render(true);
    };
    window.addEventListener('popstate', navigate);
    window.addEventListener('hashchange', navigate);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shell?.el.classList.contains('nav-open')) shell.toggleNav(false);
    if (e.key === 'Tab' && shell?.el.classList.contains('nav-open')) {
      const items = [...shell.sidebar.querySelectorAll('button:not(:disabled), [tabindex="0"]')].filter((el) => el.getClientRects().length);
      const edge = e.shiftKey ? items[0] : items.at(-1);
      if (document.activeElement === edge) {
        e.preventDefault();
        (e.shiftKey ? items.at(-1) : items[0]).focus();
      }
    }
  });
  if (store.state.phase === 'ready' && store.state.user?.mustChangePassword && store.state.user.role !== 'student') forcePasswordChange();
}

window.addEventListener('error', (e) => console.error(e.error || e.message));
start().catch((e) => notify('화면을 여는 중 문제가 생겼어요', errorText(e)));
