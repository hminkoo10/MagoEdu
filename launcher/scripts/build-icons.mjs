// lucide-static 에서 필요한 아이콘만 골라 src/renderer/js/icons.js 로 만듭니다.
// 구름 아이콘(cloud)은 앱 아이콘의 손글씨 ‘클라우드’(build/cloud-glyph.png, scripts/build-app-icon.py 가 만듦),
// 동기화 표시(cloudCheck·cloudUpload·cloudOff)는 꽉 찬 구름 모양을 직접 그려 씁니다 (CUSTOM).
// 사용: node scripts/build-icons.mjs   (lucide-static 은 개발용 의존성)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAP = {
  apps: 'layout-grid',
  user: 'user-round',
  users: 'users-round',
  userPlus: 'user-plus',
  key: 'key-round',
  ticket: 'ticket',
  shield: 'shield-check',
  megaphone: 'megaphone',
  activity: 'scroll-text',
  sliders: 'sliders-horizontal',
  settings: 'settings-2',
  download: 'download',
  trash: 'trash-2',
  play: 'play',
  stop: 'square',
  refresh: 'refresh-cw',
  folder: 'folder-open',
  more: 'ellipsis',
  x: 'x',
  check: 'check',
  circleCheck: 'circle-check',
  info: 'info',
  help: 'circle-help',
  warning: 'triangle-alert',
  alert: 'circle-alert',
  logout: 'log-out',
  monitor: 'monitor',
  laptop: 'laptop',
  box: 'package',
  lock: 'lock',
  unlock: 'lock-open',
  plus: 'plus',
  edit: 'pencil',
  copy: 'copy',
  eye: 'eye',
  eyeOff: 'eye-off',
  server: 'server',
  bell: 'bell',
  building: 'building-2',
  right: 'chevron-right',
  down: 'chevron-down',
  back: 'arrow-left',
  power: 'power',
  search: 'search',
  history: 'history',
  rotate: 'rotate-ccw',
  sparkles: 'sparkles',
  drive: 'hard-drive',
  ban: 'ban',
  list: 'list-checks',
  menu: 'menu',
  globe: 'globe',
  phone: 'smartphone',
  graduationCap: 'graduation-cap',
  bot: 'bot',
  external: 'external-link',
  undo: 'undo-2',
};

const out = {};
for (const [key, name] of Object.entries(MAP)) {
  const svg = readFileSync(join(root, 'node_modules', 'lucide-static', 'icons', `${name}.svg`), 'utf8');
  const inner = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/\s*\n\s*/g, '')
    .trim();
  out[key] = inner;
}

// 동기화 표시용 구름 (24 좌표). 표시(체크·화살표·사선)는 마스크로 구름을 뚫어서 그린다.
// {id} 는 아이콘마다 다른 마스크 ID 로 바뀐다.
const CLOUD = '<circle cx="7.72" cy="12.55" r="5.26"/><circle cx="14.69" cy="9.86" r="7.09"/><rect x="1" y="11.69" width="22" height="9.53" rx="4.77"/>';
// 앱 아이콘의 손글씨 ‘클라우드’ (흰 글씨, 작은 크기에서도 보이게 선을 굵게 그린 그림). 마스크로 써서 글자색으로 칠한다.
const CLOUD_GLYPH = `data:image/png;base64,${readFileSync(join(root, 'build', 'cloud-glyph.png')).toString('base64')}`;
const cut = (mark, width = 2.2) =>
  `<mask id="{id}"><rect width="24" height="24" fill="#fff" stroke="none"/><path d="${mark}" fill="none" stroke="#000" stroke-width="${width}"/></mask>` +
  `<g mask="url(#{id})" fill="currentColor" stroke="none">${CLOUD}</g>`;
const CUSTOM = {
  cloud:
    `<mask id="{id}"><image href="${CLOUD_GLYPH}" width="24" height="24"/></mask>` +
    `<rect width="24" height="24" fill="currentColor" stroke="none" mask="url(#{id})"/>`,
  // 맞추기 전: 구름에 점 세 개를 뚫음 (중심 (7.5,15.8)·(12,15.8)·(16.5,15.8), 반지름 1.4)
  cloudPending: cut('M7.5 15.1a0.7 0.7 0 1 0 0 1.4a0.7 0.7 0 1 0 0-1.4 M12 15.1a0.7 0.7 0 1 0 0 1.4a0.7 0.7 0 1 0 0-1.4 M16.5 15.1a0.7 0.7 0 1 0 0 1.4a0.7 0.7 0 1 0 0-1.4', 1.4),
  cloudCheck: cut('m8.5 15.4 2.4 2.4 4.6-4.7'),
  cloudUpload: cut('M12 18.6v-5.4m-2.7 2.5 2.7-2.7 2.7 2.7'),
  cloudOff: `${cut('M2.5 2.5l19 19', 4.6)}<path d="M2.5 2.5l19 19"/>`,
};
Object.assign(out, CUSTOM);

const body = `// 자동 생성 파일 (scripts/build-icons.mjs) - Lucide 아이콘 (ISC 라이선스), 구름은 앱 아이콘 손글씨·직접 그린 모양
export const ICONS = ${JSON.stringify(out, null, 1)};

let maskSeq = 0;

export function icon(name, size = 20, stroke = 2) {
  const inner = (ICONS[name] || '').replaceAll('{id}', \`icm\${++maskSeq}\`);
  return \`<svg class="ic" width="\${size}" height="\${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="\${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\${inner}</svg>\`;
}
`;
writeFileSync(join(root, 'src', 'renderer', 'js', 'icons.js'), body);
console.log(`[icons] ${Object.keys(out).length}개 → src/renderer/js/icons.js`);
