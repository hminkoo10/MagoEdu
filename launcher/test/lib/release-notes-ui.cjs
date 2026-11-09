'use strict';

async function exercise(rendererUrl) {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
  const { SettingsView } = await import(`${rendererUrl}js/views/settings.js`);
  let notes = { next: ['아직 미배포'], releases: [
    { version: '1.2.9', notes: ['이전 내역'] },
    { version: '1.2.10', notes: ['새 내역', '<img src=x onerror=alert(1)>'] },
  ] };
  const cloud = { getReleaseNotes: async () => { if (notes instanceof Error) throw notes; return notes; } };
  const state = { user: { role: 'teacher', name: '시험', username: 'teacher' }, apps: [], version: '1.2.17', config: { deviceName: '시험 PC' }, online: true, update: { status: 'latest' } };
  const root = document.getElementById('root');
  root.style.padding = '24px';
  const close = async (selector) => {
    document.querySelector(selector).click();
    await settle();
    assert(!document.querySelector('.dialog'), '창 닫힘');
  };
  const open = async () => {
    root.querySelector('.release-notes-button').click();
    await settle();
    return document.querySelector('.release-notes');
  };
  for (const web of [false, true]) {
    const view = new SettingsView({ cloud, store: { state: { ...state, web } } });
    root.replaceChildren(view.el);
    const button = root.querySelector('.release-notes-button');
    assert(button.textContent === '업데이트 내역' && button.querySelector('svg'), '아이콘+글자 단추');
    assert(!!button.closest('.update-settings') === !web, 'PC 업데이트 줄, 웹 정보 줄');
    assert(getComputedStyle(button).fontSize === '13px' && button.getBoundingClientRect().height === 32, '기존 작은 단추');
    const body = await open();
    button.click();
    assert(document.querySelectorAll('.dialog').length === 1, '중복 열기 방지');
    assert(body.querySelector('h3').textContent === '버전 1.2.10', '최근 버전 먼저');
    assert(!body.textContent.includes('아직 미배포'), 'next 숨김');
    assert(body.textContent.includes('<img') && !body.querySelector('img'), '내역은 HTML이 아닌 글자');
    assert(body.scrollWidth <= body.clientWidth + 1, '가로 잘림 없음');
    await close('.dialog-foot button');
    await open();
    await close('.dialog-head button');
    await open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    assert(!document.querySelector('.dialog'), 'Esc로 닫힘');
  }
  for (const data of [null, { releases: [] }, { releases: '깨짐' }, new Error('없는 파일')]) {
    notes = data;
    assert((await open()).textContent === '내역이 없어요.', '누락·깨진 파일 안내');
    await close('.dialog-foot button');
  }
  let resolve;
  cloud.getReleaseNotes = () => new Promise((yes) => { resolve = yes; });
  assert((await open()).textContent.includes('불러오고 있어요.'), '읽는 중 표시');
  await close('.dialog-head button');
  resolve({ releases: [{ version: '1.0.0', notes: ['늦게 도착'] }] });
  await settle();
  assert(!document.querySelector('.dialog'), '읽는 중 닫아도 다시 열리지 않음');
}

{
  const { app, BrowserWindow, session } = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const root = process.argv[2];
  app.setPath('userData', path.join(root, 'user-data'));
  app.setPath('sessionData', path.join(root, 'session-data'));
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !/^(file|data):/.test(details.url) }));
    const url = pathToFileURL(path.resolve(__dirname, '../../src/renderer') + path.sep).href;
    const html = path.join(root, 'index.html');
    fs.writeFileSync(html, `<!doctype html><html lang="ko"><meta charset="utf-8"><base href="${url}"><link rel="stylesheet" href="styles.css"><div id="root"></div></html>`);
    const win = new BrowserWindow({ width: 980, height: 780, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    await win.loadFile(html);
    await win.webContents.executeJavaScript(`(${exercise.toString()})(${JSON.stringify(url)})`);
    console.log('RELEASE_NOTES_UI_OK');
    win.destroy();
    app.quit();
  }).catch((err) => { console.error(err); app.exit(1); });
}
