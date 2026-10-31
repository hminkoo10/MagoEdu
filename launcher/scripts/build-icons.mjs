// lucide-static 에서 필요한 아이콘만 골라 src/renderer/js/icons.js 로 만듭니다.
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
  cloud: 'cloud',
  cloudOff: 'cloud-off',
  cloudCheck: 'cloud-check',
  cloudUpload: 'cloud-upload',
  folder: 'folder-open',
  more: 'ellipsis',
  x: 'x',
  check: 'check',
  circleCheck: 'circle-check',
  info: 'info',
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
const body = `// 자동 생성 파일 (scripts/build-icons.mjs) - Lucide 아이콘 (ISC 라이선스)
export const ICONS = ${JSON.stringify(out, null, 1)};

export function icon(name, size = 20, stroke = 2) {
  const inner = ICONS[name] || '';
  return \`<svg class="ic" width="\${size}" height="\${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="\${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\${inner}</svg>\`;
}
`;
writeFileSync(join(root, 'src', 'renderer', 'js', 'icons.js'), body);
console.log(`[icons] ${Object.keys(out).length}개 → src/renderer/js/icons.js`);
