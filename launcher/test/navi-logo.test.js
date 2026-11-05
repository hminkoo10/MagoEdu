'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Cloud } = require('../src/main/cloud');

test('앱 로고: 실행 중에도 카탈로그 주소가 바뀌면 그림을 다시 받고 실패하면 재시도', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-icon-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const item = { id: 'mago-navi-pc', iconUrl: '/api/apps/mago-navi-pc/icon' };
  const cloud = { paths: { userData: dir }, api: { serverUrl: 'https://local.test' }, apps: [item], icons: {} };
  const requests = [];
  let fail = false;
  t.mock.method(global, 'fetch', async (url) => {
    requests.push(url);
    return new Response(url, { status: fail ? 503 : 200, headers: { 'content-type': 'image/png' } });
  });
  await Cloud.prototype._loadIcons.call(cloud);
  const oldIcon = cloud.icons[item.id];
  await Cloud.prototype._loadIcons.call(cloud);
  assert.equal(requests.length, 1, '같은 주소는 한 번만 받음');
  item.iconUrl += '?v=pc';
  fail = true;
  await Cloud.prototype._loadIcons.call(cloud);
  assert.equal(requests.length, 2, '바뀐 주소는 실행 중에도 다시 받음');
  assert.equal(cloud.icons[item.id], oldIcon, '실패하면 현재 그림 보존');
  fail = false;
  await Cloud.prototype._loadIcons.call(cloud);
  assert.equal(requests.length, 3, '실패한 새 주소는 재시도');
  assert.notEqual(cloud.icons[item.id], oldIcon);
  await Cloud.prototype._loadIcons.call(cloud);
  assert.equal(requests.length, 3);
});
