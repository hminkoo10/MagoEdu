'use strict';

// 자동 배포 스크립트(deploy/deploy.sh)를 임시 폴더에서 실제로 돌려 본다.
//   진짜 systemctl 대신 서버를 켜고 끄는 가짜 systemctl 을 쓴다. (리눅스에서만)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..');
const has = (cmd) => spawnSync('bash', ['-c', `command -v ${cmd}`]).status === 0;
const skip = process.platform !== 'linux' || !['bash', 'tar', 'curl', 'flock', 'sha256sum'].every(has);

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** 지금 server 폴더로 배포본(tar.gz)을 만든다 */
function makeTarball(dir, { commit, version, breakStartup = false }) {
  const stage = path.join(dir, `stage-${commit}`, 'magoedu-cloud-server');
  fs.mkdirSync(stage, { recursive: true });
  for (const f of ['src', 'public', 'deploy']) fs.cpSync(path.join(SERVER, f), path.join(stage, f), { recursive: true });
  for (const f of ['catalog.default.json', '.env.example']) fs.copyFileSync(path.join(SERVER, f), path.join(stage, f));
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8'));
  pkg.version = version;
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(stage, 'build.json'), JSON.stringify({ commit, builtAt: Date.now() }));
  if (breakStartup) fs.writeFileSync(path.join(stage, 'src', 'index.js'), "'use strict';\nthrow new Error('일부러 켜지지 않게');\n");
  const out = path.join(dir, `magoedu-cloud-server-${commit}.tar.gz`);
  execFileSync('tar', ['-czf', out, '-C', path.dirname(stage), 'magoedu-cloud-server']);
  return { file: out, sha: crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex') };
}

test('자동 배포: 새 버전 적용, 실패하면 되돌리기', { skip }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-deploy-'));
  const port = await freePort();
  const appDir = path.join(root, 'opt', 'magoedu-cloud');
  const dataDir = path.join(root, 'data');
  const envFile = path.join(root, 'magoedu-cloud.env');
  const pidFile = path.join(root, 'server.pid');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    envFile,
    [`PORT=${port}`, 'HOST=127.0.0.1', `DATA_DIR=${dataDir}`, 'ADMIN_PASSWORD=admin-pass-1234', 'LAUNCHER_REPO=', 'GITHUB_API=http://127.0.0.1:9', ''].join('\n'),
  );

  // 가짜 systemctl: restart 하면 지금 APP_DIR 의 서버를 다시 켠다
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const fake = path.join(bin, 'systemctl');
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env bash
case "$1" in
  restart)
    if [ -f "${pidFile}" ]; then kill "$(cat "${pidFile}")" 2>/dev/null || true; sleep 0.5; fi
    ( set -a; . "${envFile}"; set +a; cd "${appDir}" && exec node --disable-warning=ExperimentalWarning src/index.js ) >> "${root}/server.log" 2>&1 &
    echo $! > "${pidFile}"
    ;;
  *) ;;
esac
`,
    { mode: 0o755 },
  );
  t.after(() => {
    try {
      process.kill(Number(fs.readFileSync(pidFile, 'utf8')));
    } catch {
      /* 이미 꺼짐 */
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    APP_DIR: appDir,
    DATA_DIR: dataDir,
    ENV_FILE: envFile,
    SYSTEMCTL: fake,
    SYSTEMD_DIR: path.join(root, 'systemd'),
    DEPLOY_BIN: path.join(root, 'sbin', 'magoedu-cloud-deploy'),
    LOCK_FILE: path.join(root, 'deploy.lock'),
    SERVICE_USER: 'nobody-magoedu-test',
    HEALTH_TIMEOUT: '25',
  };
  fs.mkdirSync(env.SYSTEMD_DIR);
  fs.mkdirSync(path.dirname(env.DEPLOY_BIN));
  const deploy = (tar, sha) => spawnSync('bash', [path.join(SERVER, 'deploy', 'deploy.sh'), tar, sha], { env, encoding: 'utf8' });
  // 서버가 다시 켜지므로 연결을 재사용하지 않게 매번 새로 연결
  const meta = () =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/api/meta', agent: false }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve(JSON.parse(body)));
        })
        .on('error', reject);
    });

  // 처음 설치된 상태 (버전 1.0.0, 커밋 aaa) 를 만들고 켠다
  const first = makeTarball(root, { commit: 'aaa1111', version: '1.0.0' });
  fs.mkdirSync(appDir, { recursive: true });
  execFileSync('tar', ['-xzf', first.file, '-C', appDir, '--strip-components=1']);
  execFileSync(fake, ['restart', 'magoedu-cloud']);
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await meta()).build) break;
    } catch {
      /* 켜지는 중 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal((await meta()).build.commit, 'aaa1111');

  await t.test('새 버전을 받아 교체하고 다시 켬', async () => {
    const next = makeTarball(root, { commit: 'bbb2222', version: '1.0.1' });
    const r = deploy(next.file, next.sha);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /완료: 1\.0\.1/);
    const m = await meta();
    assert.equal(m.version, '1.0.1');
    assert.equal(m.build.commit, 'bbb2222');
    assert.ok(fs.existsSync(`${appDir}.prev`), '예전 버전은 .prev 로 남김');
    const backups = fs.readdirSync(path.join(dataDir, 'backups'));
    assert.equal(backups.length, 1, 'DB 를 먼저 백업');
    assert.match(backups[0], /^magoedu-\d{8}-\d{6}-v1\.0\.0\.db$/);
    assert.ok(fs.existsSync(path.join(env.SYSTEMD_DIR, 'magoedu-cloud.service')), '서비스 파일도 맞춤');
    assert.ok(fs.existsSync(env.DEPLOY_BIN), '배포 스크립트도 새 버전으로');
    assert.ok(fs.existsSync(path.join(dataDir, 'magoedu.db')), '데이터는 그대로');
  });

  await t.test('새 버전이 켜지지 않으면 예전 버전으로 되돌림', async () => {
    const broken = makeTarball(root, { commit: 'ccc3333', version: '1.0.2', breakStartup: true });
    const r = deploy(broken.file, broken.sha);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /되돌렸어요/);
    const m = await meta();
    assert.equal(m.build.commit, 'bbb2222', '예전 버전이 다시 동작');
    assert.ok(fs.existsSync(`${appDir}.failed`));
  });

  await t.test('올리다 바뀐 파일·문법 오류는 아무것도 바꾸지 않음', async () => {
    const next = makeTarball(root, { commit: 'ddd4444', version: '1.0.3' });
    const r = deploy(next.file, '0'.repeat(64));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /SHA-256/);

    const stage = path.join(root, 'stage-bad', 'magoedu-cloud-server');
    fs.cpSync(path.join(root, 'stage-ddd4444', 'magoedu-cloud-server'), stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'src', 'jobs.js'), 'function (');
    const bad = path.join(root, 'bad.tar.gz');
    execFileSync('tar', ['-czf', bad, '-C', path.dirname(stage), 'magoedu-cloud-server']);
    const r2 = deploy(bad, '');
    assert.notEqual(r2.status, 0);
    assert.match(r2.stderr, /문법 오류/);
    assert.equal((await meta()).build.commit, 'bbb2222');
  });
});
