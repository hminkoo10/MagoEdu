'use strict';

// 설치된 앱·실제 서버 없이, 격리한 Electron 창에서 실제 렌더러와 가짜 IPC를 시험한다.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = process.argv[2];
const renderer = path.resolve(__dirname, '../../src/renderer');
app.setPath('userData', path.join(root, 'user-data'));
app.setPath('sessionData', path.join(root, 'session-data'));
app.disableHardwareAcceleration();

async function exercise(rendererUrl) {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const ready = { status: 'ready', current: '1.0.0', version: '1.1.0' };
  const notice = '업데이트를 설치하려고 잠시 닫아요. 1분쯤 뒤에 다시 켜져요.';
  const state = {
    phase: 'ready', version: '1.0.0', online: true, user: { id: 'test', role: 'teacher', name: '시험 계정' },
    config: { serverUrl: '', deviceName: '시험 PC', closeToTray: true }, apps: [], notices: [], unreadNotices: 0, update: ready,
  };
  let onState;
  let respond;
  let reject;
  let calls = 0;
  window.cloud = {
    getState: async () => state, onState: (fn) => { onState = fn; }, onToast() {}, onNavigate() {},
    installUpdate: () => { calls++; return new Promise((yes, no) => { respond = yes; reject = no; }); },
  };
  const errors = [];
  window.addEventListener('error', (event) => errors.push(event.message));
  window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
  await import(`${rendererUrl}js/app.js`);
  await settle();
  document.querySelector('.nav-item[data-id="settings"]').click();
  const settings = () => document.querySelector('.update-settings');
  const card = () => document.querySelector('.update-card');
  const button = (el) => el.querySelector('button');
  const publish = (update) => onState({ ...state, update });
  const locked = () => {
    assert(button(settings()).disabled && button(card()).disabled, '두 설치 단추 모두 잠금');
    assert(/설치 준비 중/.test(button(settings()).textContent), '설치 준비 글자');
    assert(settings().textContent.includes(notice) && card().textContent.includes(notice), '종료 전 시간 안내');
  };
  const layout = () => {
    for (const [selector, size] of [
      ['.update-settings .row-title', 15], ['.update-settings .row-desc', 13],
      ['.update-settings .btn', 13], ['.update-card', 13], ['.update-card .btn', 13],
    ]) {
      const el = document.querySelector(selector);
      assert(parseFloat(getComputedStyle(el).fontSize) === size, `${selector}: 기존 ${size}px 유지`);
      assert(el.scrollWidth <= el.clientWidth + 1, `${selector}: 가로 잘림 없음`);
    }
    for (const el of [settings(), card()]) {
      assert(button(el).querySelector('svg')?.childElementCount > 0, '아이콘과 글자 단추');
      assert(button(el).classList.contains('sm') && button(el).getBoundingClientRect().height === 32, '기존 작은 단추 유지');
    }
  };
  layout();
  assert(settings().querySelector('.row-desc').textContent === '1.1.0 설치 준비 완료', '준비 문구');
  const { icon } = await import(`${rendererUrl}js/icons.js`);
  const expectedIcon = document.createElement('div');
  expectedIcon.innerHTML = icon('download', 16);
  assert(button(card()).querySelector('svg').isEqualNode(expectedIcon.firstElementChild), '업데이트 카드 내려받기 아이콘');
  const original = button(settings());
  original.click();
  original.click();
  locked();
  assert(calls === 1, '중복 요청 없음');
  respond({ ...ready, status: 'deferred', message: '프로그램 설치가 끝나면 바로 업데이트해요.' });
  await settle();
  assert(/프로그램 설치가 끝나면/.test(settings().textContent), 'IPC 대기 이유 표시');
  assert(/설치 대기 중/.test(button(card()).textContent), '카드 대기 글자');
  assert(button(settings()).disabled && button(card()).disabled, '대기 중 중복 설치 방지');
  layout();
  publish({ ...ready, status: 'installing', message: notice });
  locked();
  publish({ ...ready, status: 'error', canRetryInstall: true, message: '설치 파일 실행 실패' });
  assert(settings().textContent.includes('업데이트를 설치하지 못했어요: 설치 파일 실행 실패'), '설치 오류 이유 표시');
  assert(card().textContent.includes('업데이트를 설치하지 못했어요: 설치 파일 실행 실패'), '카드 설치 오류 이유 표시');
  assert(!button(settings()).disabled && /다시 설치/.test(button(settings()).textContent), '설치 재시도 가능');
  publish({ ...ready, status: 'error', canRetryInstall: true, message: '다른 설치 오류' });
  assert(/다른 설치 오류/.test(card().textContent), '상태가 같아도 오류 문구 갱신');
  button(settings()).click();
  reject(new Error('연결 응답 없음'));
  await settle();
  assert(/연결 응답 없음/.test(settings().textContent) && !button(settings()).disabled, 'IPC 실패 표시·잠금 해제');
  button(settings()).click();
  respond(false);
  await settle();
  assert(card().textContent.includes('설치를 시작하지 못했어요. 업데이트를 다시 확인해 주세요.'), '거절된 IPC 결과도 표시');
  button(settings()).click();
  reject(new Error());
  await settle();
  assert(settings().textContent.includes('설치 요청을 보내지 못했어요.'), '빈 IPC 오류 기본 안내');
  publish({ ...ready, status: 'error', canRetryInstall: false, message: '연결 응답 없음' });
  assert(settings().textContent.includes('업데이트를 확인하지 못했어요: 연결 응답 없음'), '확인 오류 이유 표시');
  assert(button(settings()).textContent === '확인' && button(settings()).classList.contains('sm') && button(settings()).querySelector('svg'), '작은 확인 단추와 아이콘 유지');
  publish(ready);
  button(card()).click();
  assert(document.querySelector('.dialog'), '카드 확인 창 유지');
  assert(document.querySelector('.dialog .primary svg'), '확인 단추 아이콘');
  assert(document.querySelector('.update-notice').textContent === `${notice} 켜져 있는 프로그램은 계속 실행돼요.`, '확인 창 안내 문구');
  assert(getComputedStyle(document.querySelector('.update-notice')).fontSize === getComputedStyle(document.querySelector('.update-notice').parentElement).fontSize, '확인 창 글자 크기 상속');
  document.querySelector('.dialog .primary').click();
  await settle();
  locked();
  assert(calls === 5, '카드에서도 실제 요청');
  respond({ ...ready, status: 'error', canRetryInstall: true, message: '다시 시도할 오류' });
  await settle();
  assert(!button(card()).disabled && /다시 설치/.test(button(card()).textContent), '카드 실패 재시도');
  assert(errors.length === 0, `렌더러 오류 없음: ${errors.join(', ')}`);
  window.verifyUpdateLayout = layout;
  window.publishUpdate = publish;
  publish({ ...ready, status: 'deferred', message: '프로그램 설치가 끝나면 바로 업데이트해요.' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  return true;
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data):/.test(details.url) }));
  const html = path.join(root, 'index.html');
  const url = pathToFileURL(`${renderer}${path.sep}`).href;
  fs.writeFileSync(html, `<!doctype html><html lang="ko"><meta charset="utf-8"><base href="${url}"><link rel="stylesheet" href="styles.css"><div id="root"></div></html>`);
  const win = new BrowserWindow({ width: 1200, height: 780, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadFile(html);
  await win.webContents.executeJavaScript(`(${exercise.toString()})(${JSON.stringify(url)})`);
  const shots = process.env.MAGOEDU_UPDATE_UI_SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const states = [
    { status: 'ready' },
    { status: 'installing', message: '업데이트를 설치하려고 잠시 닫아요. 1분쯤 뒤에 다시 켜져요.' },
    { status: 'deferred', message: '프로그램 설치가 끝나면 바로 업데이트해요.' },
    { status: 'error', canRetryInstall: true, message: '설치 파일 실행 실패' },
  ];
  const paint = () => win.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => setTimeout(resolve, 200)))');
  for (const width of [1200, 980]) {
    win.setContentSize(width, 780);
    for (const state of states) {
      const update = { current: '1.0.0', version: '1.1.0', ...state };
      await win.webContents.executeJavaScript(`window.publishUpdate(${JSON.stringify(update)})`);
      await paint();
      await win.webContents.executeJavaScript('window.verifyUpdateLayout()');
      if (shots) {
        fs.writeFileSync(path.join(shots, `settings-${state.status}-${width}.png`), (await win.webContents.capturePage()).toPNG());
        if (state.status === 'ready') {
          const rect = await win.webContents.executeJavaScript(`(() => {
            const r = document.querySelector('.update-card').getBoundingClientRect();
            return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) };
          })()`);
          fs.writeFileSync(path.join(shots, `menu-card-${width}.png`), (await win.webContents.capturePage(rect)).toPNG());
        }
      }
    }
    if (shots) {
      await win.webContents.executeJavaScript('document.querySelector(".update-card button").click()');
      // 숨긴 시험 창에서도 전환 중간이 아닌 완성된 확인 창을 저장한다.
      await win.webContents.executeJavaScript(`
        document.querySelector('.dim').getAnimations({ subtree: true }).forEach(animation => animation.finish());
      `);
      await paint();
      fs.writeFileSync(path.join(shots, `confirmation-${width}.png`), (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript('document.querySelector(".dialog-head button").click()');
      await paint();
    }
  }
  console.log('UPDATE_UI_OK');
  win.destroy();
  app.quit();
}).catch((err) => { console.error(err); app.exit(1); });
