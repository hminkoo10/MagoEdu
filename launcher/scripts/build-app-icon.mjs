// build/icon.svg → build/icon.png (512), build/tray.png (32), build/icon.ico (16~256)
// 32px 이하(트레이·작은 아이콘)는 글자 없는 build/icon-small.svg 로 그린다
// 사용: node scripts/build-app-icon.mjs   (Playwright Chromium 필요)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const full = readFileSync(join(root, 'build', 'icon.svg'), 'utf8');
const small = readFileSync(join(root, 'build', 'icon-small.svg'), 'utf8');

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(size) {
  const svg = size <= 32 ? small : full;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg style="width:${size}px;height:${size}px;display:block" `)}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

writeFileSync(join(root, 'build', 'icon.png'), await render(512));
writeFileSync(join(root, 'build', 'tray.png'), await render(32));

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = [];
for (const s of sizes) pngs.push(await render(s));
await browser.close();

// PNG 를 그대로 담는 ICO
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
const dir = Buffer.alloc(16 * sizes.length);
let offset = 6 + dir.length;
sizes.forEach((s, i) => {
  const o = i * 16;
  dir.writeUInt8(s >= 256 ? 0 : s, o);
  dir.writeUInt8(s >= 256 ? 0 : s, o + 1);
  dir.writeUInt8(0, o + 2);
  dir.writeUInt8(0, o + 3);
  dir.writeUInt16LE(1, o + 4);
  dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(pngs[i].length, o + 8);
  dir.writeUInt32LE(offset, o + 12);
  offset += pngs[i].length;
});
writeFileSync(join(root, 'build', 'icon.ico'), Buffer.concat([header, dir, ...pngs]));
console.log('[app-icon] icon.png, tray.png, icon.ico 생성');
