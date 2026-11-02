'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCloudServer, loadConfig } = require('../src/app');

const ADMIN_PASSWORD = 'admin-pass-1234';

async function startServer(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-test-'));
  const config = loadConfig(
    {},
    {
      dataDir,
      adminPassword: ADMIN_PASSWORD,
      launcherRepo: '',
      background: false,
      quiet: true,
      ...overrides,
    },
  );
  const app = createCloudServer(config);
  const addr = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;

  async function request(method, url, { token, body, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }

  async function login(username, password, deviceId = 'dev-1', deviceName = '테스트 PC') {
    const r = await request('POST', '/api/auth/login', {
      body: { username, password, device: { id: deviceId, name: deviceName, platform: 'test', version: '0.0.0' } },
    });
    if (r.status !== 200) throw new Error(`login failed ${r.status} ${JSON.stringify(r.data)}`);
    return r.data.token;
  }

  async function close() {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { app, base, dataDir, request, login, close };
}

module.exports = { startServer, ADMIN_PASSWORD };
