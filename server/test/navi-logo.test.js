'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDb, MIGRATIONS } = require('../src/db');
const { startServer, ADMIN_PASSWORD } = require('./helpers');

const OLD_ICON = 'https://raw.githubusercontent.com/hminkoo10/mago-navi/main/public/icon-512.png';
const PC_ICON = 'https://raw.githubusercontent.com/hminkoo10/mago-navi/main/desktop/build/icon.png';
const NAVI_IDS = ['mago-navi', 'mago-navi-pc'];

test('과목내비 로고: 새 서버의 웹·PC 항목은 실제 PC 앱 원본을 참조', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  for (const id of NAVI_IDS) assert.equal(s.app.deps.catalog.get(id).iconUrl, PC_ICON);
});

test('고침 10: 9번 DB의 옛 로고만 교체하고 설정·다른 앱·재시작 보존', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-mig10-'));
  let db;
  t.after(() => { db?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const value of [OLD_ICON, 'https://example.test/custom.png', PC_ICON, '', null]) {
    const file = path.join(dir, `${String(value).length}.db`);
    const raw = new DatabaseSync(file);
    try {
      for (const sql of MIGRATIONS.slice(0, 9)) raw.exec(sql);
      raw.exec('PRAGMA user_version = 9');
      const add = raw.prepare(`INSERT INTO apps(id, name, source, icon_url, enabled, sort, color, created_at, updated_at)
        VALUES (?, '운영자 이름', '{"type":"local"}', ?, 0, 17, '#123456', 123, 456)`);
      for (const id of [...NAVI_IDS, 'other']) add.run(id, value);
    } finally { raw.close(); }
    db = openDb(file);
    assert.equal(db.get('PRAGMA user_version').user_version, MIGRATIONS.length);
    for (const id of NAVI_IDS) {
      const row = db.get('SELECT * FROM apps WHERE id = ?', id);
      assert.equal(row.icon_url, value === OLD_ICON ? PC_ICON : value);
      assert.deepEqual([row.name, row.enabled, row.sort, row.color, row.created_at, row.updated_at], ['운영자 이름', 0, 17, '#123456', 123, 456]);
    }
    assert.equal(db.get("SELECT icon_url FROM apps WHERE id = 'other'").icon_url, value);
    const before = db.all('SELECT * FROM apps ORDER BY id');
    db.close(); db = openDb(file);
    assert.deepEqual(db.all('SELECT * FROM apps ORDER BY id'), before);
    db.close(); db = null;
  }
});

test('과목내비 로고: 5번 DB에서 웹·PC 항목을 추가할 때도 같은 원본', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-navi-old-'));
  const file = path.join(dir, 'cloud.db');
  let db;
  t.after(() => { db?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const raw = new DatabaseSync(file);
  try {
    for (const sql of MIGRATIONS.slice(0, 5)) raw.exec(sql);
    raw.exec(`PRAGMA user_version = 5;
      INSERT INTO apps(id, name, source, created_at, updated_at) VALUES ('other', '기존 앱', '{"type":"local"}', 1, 1)`);
  } finally { raw.close(); }
  db = openDb(file);
  for (const id of NAVI_IDS) assert.equal(db.get('SELECT icon_url FROM apps WHERE id = ?', id).icon_url, PC_ICON);
});

test('과목내비 로고: 원본 변경 시 서버·브라우저 캐시 교체, 오프라인·수동 그림 보존', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const token = await s.login('admin', ADMIN_PASSWORD);
  s.app.deps.db.run("UPDATE sessions SET platform = 'web'");
  const { catalog } = s.app.deps;
  const originalFetch = global.fetch;
  const requests = [];
  let offline = false;
  const oldImage = Buffer.from([0x89, 0x50, 1]);
  const pcImage = Buffer.from([0x89, 0x50, 2]);
  t.mock.method(global, 'fetch', async (url, options) => {
    if (url === OLD_ICON || url === PC_ICON) {
      requests.push(url);
      if (offline) throw new Error('offline');
      return new Response(url === OLD_ICON ? oldImage : pcImage);
    }
    return originalFetch(url, options);
  });
  const listIcon = async () => (await s.request('GET', '/api/apps', { token })).data.apps.find((a) => a.id === 'mago-navi').iconUrl;
  s.app.deps.db.run("UPDATE apps SET enabled = 1, icon_url = ? WHERE id = 'mago-navi'", OLD_ICON);
  fs.writeFileSync(path.join(catalog.iconsDir, 'mago-navi'), oldImage); // 이전 배포의 24시간 캐시
  const oldUrl = await listIcon();
  assert.deepEqual((await s.request('GET', oldUrl)).data, oldImage);
  s.app.deps.db.run("UPDATE apps SET icon_url = ? WHERE id = 'mago-navi'", PC_ICON);
  const newUrl = await listIcon();
  assert.notEqual(newUrl, oldUrl, '브라우저도 옛 응답을 재사용하지 않음');
  assert.deepEqual((await s.request('GET', newUrl)).data, pcImage);
  assert.ok(requests.includes(PC_ICON), '옛 캐시가 신선해도 새 원본을 받음');
  const icon = await catalog.icon(catalog.get('mago-navi'));
  offline = true;
  fs.utimesSync(icon.file, new Date(0), new Date(0));
  assert.deepEqual((await s.request('GET', newUrl)).data, pcImage, '오프라인에는 같은 원본의 캐시 사용');
  fs.writeFileSync(path.join(catalog.iconsDir, 'mago-navi.png'), oldImage);
  assert.deepEqual((await s.request('GET', newUrl)).data, oldImage, '운영자가 직접 넣은 그림 우선');
});
