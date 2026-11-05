import { h, btn, dialog, put } from './ui.js';

// next 는 아직 배포하지 않은 메모. 화면에는 번호가 붙은 내역만 보여 준다.
export function releasedNotes(data) {
  if (!Array.isArray(data?.releases)) return [];
  return data.releases
    .filter((r) => r && typeof r.version === 'string' && /^\d+\.\d+\.\d+$/.test(r.version) && Array.isArray(r.notes))
    .map((r) => ({ version: r.version, notes: r.notes.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim()) }))
    .filter((r) => r.notes.length)
    .sort((a, b) => {
      const av = a.version.split('.').map(Number);
      const bv = b.version.split('.').map(Number);
      return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2];
    });
}

// 웹은 같은 서버의 정적 파일, PC는 앱에 함께 넣은 파일을 IPC로 읽는다.
export async function loadReleaseNotes(cloud) {
  try {
    if (cloud.getReleaseNotes) return releasedNotes(await cloud.getReleaseNotes());
    const res = await fetch(new URL('../release-notes.json', import.meta.url), { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    return res.ok ? releasedNotes(await res.json()) : [];
  } catch {
    return [];
  }
}

let opened = false;
export function releaseNotesButton(cloud) {
  return btn('업데이트 내역', { size: 'sm', iconName: 'history', cls: 'release-notes-button', onClick: async () => {
    if (opened) return;
    opened = true;
    const body = h('div', { class: 'release-notes', 'aria-live': 'polite' }, h('p', { class: 'muted' }, '불러오고 있어요.'));
    const closed = dialog({ title: '업데이트 내역', body, ok: null, cancel: '닫기' });
    loadReleaseNotes(cloud).then((releases) => {
      put(body, releases.length ? releases.map((r) => h('section', { class: 'release-note' },
        h('h3', { class: 'row-title' }, `버전 ${r.version}`),
        h('ul', {}, r.notes.map((note) => h('li', {}, note))),
      )) : h('p', { class: 'muted' }, '내역이 없어요.'));
    });
    try { await closed; } finally { opened = false; }
  } });
}
