// 설정: 이 컴퓨터, 자동 실행, 업데이트, 서버, 정보 (구현민 개발)
import { h, ic, btn, busy, toast, dialog, field, input, toggle, pill, ago, put } from '../ui.js';
import { openInApp } from './home.js';

function row(title, desc, right) {
  return h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'row-title' }, title), desc ? h('div', { class: 'row-desc' }, desc) : null), right);
}

export class SettingsView {
  constructor({ cloud, store }) {
    this.cloud = cloud;
    this.store = store;
    const s = store.state;
    const c = s.config;
    this.web = !!s.web;
    if (this.web) {
      this.el = this.webView(s);
      return;
    }
    const set = (patch, msg) =>
      cloud
        .setConfig(patch)
        .then(() => msg && toast(msg, 'success'))
        .catch((e) => toast(e.message, 'error'));

    const devName = input({ value: c.deviceName, style: 'width: 220px' });
    devName.addEventListener('change', () => set({ deviceName: devName.value.trim() || c.deviceName }, '컴퓨터 이름을 바꿨어요. 다음 로그인부터 보여요.'));
    const webUrl = /^https?:\/\//i.test(c.serverUrl || '') ? c.serverUrl : null;

    this.updRow = h('div');
    this.el = h(
      'div',
      {},
      h('div', { class: 'page-head' }, h('div', { class: 'tt' }, h('h1', { class: 'title' }, '설정'))),
      h(
        'div',
        { class: 'grid2' },
        h(
          'div',
          { class: 'stack' },
          h(
            'div',
            { class: 'card' },
            h('h2', { class: 'card-title' }, '이 컴퓨터'),
            row('컴퓨터 이름', '‘로그인한 기기’ 목록에 보이는 이름이에요.', devName),
            row('컴퓨터를 켜면 자동으로 실행', '트레이에서 조용히 켜져서 동기화하고, ‘함께 켜기’로 정한 프로그램(예: 타종)을 켜요.', toggle(c.autoStart, (v) => set({ autoStart: v }, v ? '자동 실행을 켰어요' : '자동 실행을 껐어요'))),
            row('창을 닫아도 트레이에서 계속', '끄면 창을 닫을 때 통합 클라우드도 꺼져요.', toggle(c.closeToTray, (v) => set({ closeToTray: v }))),
            row('프로그램 자동 업데이트', '새 버전이 나오면 알아서 받아요. 켜져 있는 프로그램은 다음에 켤 때 바뀌어요.', toggle(c.autoUpdateApps, (v) => set({ autoUpdateApps: v }))),
          ),
          h(
            'div',
            { class: 'card' },
            h('h2', { class: 'card-title' }, '서버'),
            row('서버 주소', c.serverUrl, btn('바꾸기', { size: 'sm', onClick: () => this.changeServer() })),
            row('연결', s.online ? '연결되어 있어요' : '연결되지 않았어요', s.online ? pill('정상', 'green') : pill('끊김', 'red')),
            webUrl ? row('웹에서 열기', '브라우저·휴대폰에서도 같은 계정으로 공지·계정·관리를 할 수 있어요.', btn('열기', { size: 'sm', onClick: () => cloud.openExternal(webUrl) })) : null,
          ),
        ),
        h(
          'div',
          { class: 'stack' },
          h('div', { class: 'card' }, h('h2', { class: 'card-title' }, '업데이트'), this.updRow),
          h(
            'div',
            { class: 'card' },
            h('h2', { class: 'card-title' }, '정보'),
            row('프로그램', '마고에듀 통합 클라우드', h('span', { class: 'muted' }, `버전 ${s.version}`)),
            row('만든 사람', null, h('span', { style: { fontWeight: 600 } }, '구현민')),
            row('통합 클라우드 끄기', '켜져 있는 프로그램은 계속 돌아가요. 동기화는 다시 켜면 이어서 해요.', btn('끄기', { size: 'sm', variant: 'danger', onClick: () => this.quit() })),
          ),
        ),
      ),
    );
    this.update(s);
  }

  // 웹: 앱 내려받기·열기, 이 브라우저, 정보 (업데이트·서버 주소·끄기 없음)
  webView(s) {
    const l = s.launcher;
    const download = l ? h('a', { class: 'btn sm', href: '/download/launcher' }, ic('download', 16), '내려받기') : btn('내려받기', { size: 'sm', iconName: 'download', disabled: true });
    const open = s.client?.canOpenApp ? btn('열기', { size: 'sm', onClick: () => openInApp(this.cloud, this.store).catch((e) => toast(e.message, 'error')) }) : null;
    return h(
      'div',
      {},
      h('div', { class: 'page-head' }, h('div', { class: 'tt' }, h('h1', { class: 'title' }, '설정'))),
      h(
        'div',
        { class: 'grid2' },
        h(
          'div',
          { class: 'stack' },
          h(
            'div',
            { class: 'card' },
            h('h2', { class: 'card-title' }, '통합 클라우드 앱'),
            row('앱 내려받기', l ? `Windows 10 이상 · 버전 ${l.version}` : '아직 배포된 설치 파일이 없어요', download),
            open ? row('앱 열기', '이 PC에 설치된 통합 클라우드를 열어요.', open) : null,
          ),
          h(
            'div',
            { class: 'card' },
            h('h2', { class: 'card-title' }, '이 브라우저'),
            row('기기 이름', '‘로그인한 기기’ 목록에 보이는 이름이에요.', h('span', { style: { fontWeight: 600 } }, s.config.deviceName)),
            row('연결', s.online ? '연결되어 있어요' : '연결되지 않았어요', s.online ? pill('정상', 'green') : pill('끊김', 'red')),
          ),
        ),
        h(
          'div',
          { class: 'stack' },
          h(
            'div',
            { class: 'card' },
            h('h2', { class: 'card-title' }, '정보'),
            row('서비스', '마고에듀 통합 클라우드 (웹)', h('span', { class: 'muted' }, `버전 ${s.version}`)),
            row('만든 사람', null, h('span', { style: { fontWeight: 600 } }, '구현민')),
          ),
        ),
      ),
    );
  }

  update(s) {
    if (this.web) return;
    const u = s.update || {};
    const key = JSON.stringify(u);
    if (key === this._uk) return;
    this._uk = key;
    let desc = '';
    let right = null;
    switch (u.status) {
      case 'disabled':
        desc = u.message || '자동 업데이트를 쓸 수 없어요.';
        break;
      case 'checking':
        desc = '확인하고 있어요';
        right = h('span', { class: 'spinner' });
        break;
      case 'available':
      case 'downloading':
        desc = `${u.version} 받는 중 ${u.percent ? `${u.percent}%` : ''}`;
        right = h('span', { class: 'spinner' });
        break;
      case 'ready':
        desc = `${u.version} 설치 준비 완료 · 켜진 프로그램이 없고 창이 닫혀 있을 때 알아서 설치해요.`;
        right = btn('지금 설치', { variant: 'primary', size: 'sm', onClick: () => this.cloud.installUpdate() });
        break;
      case 'latest':
        desc = `최신 버전이에요${u.checkedAt ? ` · ${ago(u.checkedAt)} 확인` : ''}`;
        break;
      case 'error':
        desc = u.message || '업데이트를 확인하지 못했어요.';
        break;
      default:
        desc = '아직 확인하지 않았어요';
    }
    if (!right && u.status !== 'disabled') {
      right = btn('확인', { size: 'sm' });
      right.addEventListener('click', () => busy(right, () => this.cloud.checkUpdate()));
    }
    put(this.updRow, row(`통합 클라우드 ${s.version}`, desc, right || h('span')));
  }

  async changeServer() {
    const url = input({ value: this.store.state.config.serverUrl });
    await dialog({
      title: '서버 주소 바꾸기',
      sub: '다른 서버로 바꾸면 로그아웃하고 그 서버 계정으로 다시 로그인해요.',
      body: field('서버 주소', url),
      ok: '바꾸기',
      onOk: () => this.cloud.setServer(url.value),
    });
  }

  async quit() {
    const ok = await dialog({ title: '통합 클라우드를 끌까요?', sub: '켜져 있는 프로그램은 계속 돌아가요.', ok: '끄기', danger: true });
    if (ok) this.cloud.quit();
  }
}

