'use strict';

// 실제 로컬 서버 + 웹 렌더러. 외부 접속 차단, 모든 데이터는 이 worktree의 시험 폴더에만.
// 실행 전 메모리·공용 e2e.lock 확보 필요. PNG는 MAGOEDU_REVIEW_DIR 지정 시에만 저장.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

if (process.versions.electron) {
  const { app, BrowserWindow, session } = require('electron');
  app.setPath('userData', process.env.MAGOEDU_CLOUD_USER_DATA);
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1' });
    });
    const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadURL(process.env.MAGOEDU_REVIEW_URL);
  }).catch((e) => { console.error(e); app.exit(1); });
} else {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

async function main() {
  const { _electron } = require('playwright');
  const { createCloudServer, loadConfig } = require('../../../server/src/app');
  const crypto = require('node:crypto');
  const temp = fs.mkdtempSync(path.join(__dirname, '.easy-review-'));
  const base = 'http://127.0.0.1:8491';
  const password = 'review-password-123';
  const server = createCloudServer(loadConfig({}, { dataDir: path.join(temp, 'server'), adminPassword: password, launcherRepo: '', background: false, quiet: true }));
  let app;
  const results = [];
  try {
    await server.listen(8491, '127.0.0.1');
    // 로컬 카탈로그만 사용. 웹 카드도 외부 사이트를 열지 않음.
    for (const a of server.deps.catalog.list()) server.deps.catalog.upsert({ ...a, iconUrl: '', enabled: true, source: { type: 'local' } });
    const { makeZip } = require('../lib/zipwriter');
    for (const id of ['tajong', 'ohdapnote']) {
      const packages = path.join(temp, 'server', 'packages', id);
      fs.mkdirSync(packages, { recursive: true });
      fs.writeFileSync(path.join(packages, `${id}-1.0.0-win-x64.zip`), makeZip({ 'magoedu-app.json': JSON.stringify({ format: 1, id, exe: 'fixture.exe' }), 'fixture.exe': '화면 시험용, 실행하지 않음' }));
      await server.deps.catalog.refreshApp(id);
    }
    async function api(method, route, body, token) {
      const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json();
      assert.equal(response.status, 200, `${method} ${route}: ${JSON.stringify(data)}`);
      return data;
    }
    const login = async (username) => (await api('POST', '/api/auth/login', { username, password, device: { id: `review-${username}`, platform: 'web', name: '화면 시험' } })).token;
    const admin = await login('admin');
    const director = (await api('POST', '/api/users', { role: 'director', username: 'review-director', name: '김원장', academyName: '마고수학학원', password, mustChangePassword: false, allowedApps: null }, admin)).user;
    const dir = await login('review-director');
    const teacher = (await api('POST', '/api/users', { username: 'review-teacher', name: '이선생', password, mustChangePassword: true, allowedApps: null }, dir)).user;
    await api('PATCH', '/api/academy', { code: 'review' }, dir);
    const student = (await api('POST', '/api/students', { name: '김민준', school: '마고중학교', grade: '중2', teacherId: teacher.id, memo: '화·목 수업, 서술형 풀이 확인' }, dir)).student;
    await api('POST', `/api/students/${student.id}/account`, { username: 'review-student', password }, dir);
    await api('POST', '/api/students', { name: '이서연', school: '마고고등학교', grade: '고1', teacherId: teacher.id }, dir);
    await api('POST', '/api/notices', { title: '11월 수업 및 상담 일정 안내', body: '수업 시간과 상담 일정을 확인해 주세요.\n변경이 필요한 경우 담당 선생님께 연락해 주세요.', pinned: true }, dir);
    await api('PUT', '/api/academy/ai', { app: '', config: { provider: 'gemini', apiKey: 'review-only-placeholder-key', model: 'preserved-model', model2: 'preserved-fallback', rpm: 17 } }, dir);
    // 기존 시험과 같은 형식의 합성 오답노트. 실제 사용자 자료는 읽지 않음.
    const note = Buffer.from(JSON.stringify({ id: 'review-note', kind: 'note', version: 2, title: '중2 수학 · 일차함수 복습', studentId: student.id, bookIds: ['review-book'], selected: { 'review-book': ['p1', 'p2', 'p3'] }, updatedAt: Date.now(), answersForStudent: true }));
    const sha = crypto.createHash('sha256').update(note).digest('hex');
    const blob = server.deps.blobs.pathFor(sha); fs.mkdirSync(path.dirname(blob), { recursive: true }); fs.writeFileSync(blob, note);
    const aca = director.academy.id;
    server.deps.db.run('INSERT INTO shared_files(academy_id, app_id, path, rev, seq, sha256, size, mtime, deleted, updated_by, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 0, ?, ?)', aca, 'ohdapnote', `students/${student.id}/notes/review-note.json`, server.deps.nextSeq(), sha, note.length, Date.now(), director.id, Date.now());
    app = await _electron.launch({ executablePath: require('electron'), args: [__filename], env: { ...process.env, MAGOEDU_REVIEW_URL: base, MAGOEDU_CLOUD_USER_DATA: path.join(temp, 'profile'), MAGOEDU_CLOUD_LOCAL_DATA: path.join(temp, 'local'), APPDATA: path.join(temp, 'appdata'), LOCALAPPDATA: path.join(temp, 'localappdata') } });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    const sizes = [{ width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 390, height: 844 }];
    const btn = (name, scope = page) => scope.getByRole('button', { name, exact: true });
    await btn('로그인').waitFor();
    // 프로그램-1280.png는 ui-e2e.js가 실제 PC 앱의 설치 완료 화면으로 저장.
    const captures = new Set(['로그인-390', '프로그램-390', '학생명단-1280', '학생명단-390', '학원AI-1280', '학원AI-390', '내계정-1024', '학생오답노트-1280', '학생오답노트-390'].filter((name) => !process.env.MAGOEDU_REVIEW_SCREEN || name === process.env.MAGOEDU_REVIEW_SCREEN));
    async function check(name, size) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), size);
      await page.setViewportSize(size);
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('.page, .sidebar, .auth, .dialog')) el.scrollTop = 0;
      });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(350);
      const issues = await page.evaluate(() => {
        const issues = [];
        const root = document.querySelector('.dim:not(.out) .dialog') || document.querySelector('.page') || document.querySelector('.auth');
        if (root.scrollWidth > root.clientWidth + 2) issues.push(`page overflow ${root.scrollWidth}/${root.clientWidth}`);
        for (const el of root.querySelectorAll('.btn, .input, .card, .app-card, .table, .seg, .row, .notice')) {
          if (!el.checkVisibility()) continue;
          const r = el.getBoundingClientRect();
          if (r.width && (r.left < -1 || r.right > innerWidth + 1)) issues.push(`${el.className}: ${Math.round(r.left)}..${Math.round(r.right)} ${el.textContent.slice(0, 35)}`);
          if (el.matches('.btn') && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2)) issues.push(`button clipped: ${el.textContent}`);
        }
        return issues;
      });
      const key = `${name}-${size.width}`;
      results.push({ screen: key, issues }); console.log(JSON.stringify(results.at(-1)));
      if (captures.has(key) && process.env.MAGOEDU_REVIEW_DIR) {
        await page.waitForFunction(() => !document.querySelector('.toast'));
        await page.evaluate(() => {
          for (const a of document.getAnimations()) if (a.effect.getTiming().iterations !== Infinity) a.finish();
          for (const el of document.querySelectorAll('.page, .sidebar, .auth, .dialog')) el.scrollTop = 0;
        });
        await page.waitForTimeout(150); // 숨긴 창의 다음 합성 프레임까지 기다림
        const png = Buffer.from(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')), 'base64');
        assert.ok(png.length < 400 * 1024, `${key}: PNG exceeds 400KB`);
        fs.mkdirSync(process.env.MAGOEDU_REVIEW_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.MAGOEDU_REVIEW_DIR, `${key}.png`), png);
      }
    }
    async function nav(id, title) {
      await page.evaluate((id) => { location.hash = `/${id}`; }, id);
      await page.locator('.page h1').filter({ hasText: title }).waitFor();
      await page.waitForTimeout(250);
    }
    async function signIn(username) {
      await page.goto(base);
      await page.getByPlaceholder('아이디', { exact: true }).fill(username);
      await page.getByPlaceholder('비밀번호', { exact: true }).fill(password);
      await btn('로그인').click();
      await page.locator('.nav').waitFor({ state: 'attached' });
    }
    async function signOut() {
      await page.evaluate(() => document.querySelector('button[title="로그아웃"]').click());
      await btn('로그아웃', page.getByRole('dialog')).click();
      await btn('로그인').waitFor();
    }
    for (const size of sizes) await check('로그인', size);
    await signIn('review-director');
    await btn('메뉴 열기').click(); await page.locator('.nav').waitFor();
    await btn('메뉴 닫기').click(); await page.locator('.nav').waitFor({ state: 'hidden' });
    for (const [id, title, name] of [['home', '프로그램', '프로그램'], ['students', '학생 명단', '학생명단'], ['academy-ai', '학원 AI', '학원AI'], ['account', '내 계정', '내계정'], ['teachers', '선생님 관리', '선생님'], ['notices', '공지사항', '공지'], ['settings', '설정', '설정']]) {
      await nav(id, title);
      for (const size of sizes) await check(name, size);
      if (id === 'academy-ai') {
        assert.equal(await page.locator('details[open]').count(), 0);
        await page.locator('summary').first().click();
        for (const size of sizes) await check('학원AI고급', size);
        await btn('저장').click(); await page.getByText('기본 설정을 저장했습니다', { exact: true }).waitFor();
        const saved = (await api('GET', '/api/academy/ai/all', null, dir)).default;
        assert.equal(saved.model, 'preserved-model'); assert.equal(saved.model2, 'preserved-fallback'); assert.equal(saved.rpm, 17); assert.ok(saved.keyHint);
        await page.locator('summary').filter({ hasText: '고급: 프로그램별 설정' }).click();
        for (const size of sizes) await check('프로그램별설정', size);
      }
      const action = { students: '학생 추가', teachers: '선생님 추가', notices: '공지 쓰기' }[id];
      if (action) {
        await btn(action).click(); await page.getByRole('dialog').waitFor();
        for (const size of sizes) await check(`${name}입력창`, size);
        await btn('취소', page.getByRole('dialog')).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
      }
    }
    await signOut(); await signIn('review-teacher');
    const first = page.getByRole('dialog', { name: '새 비밀번호를 정해 주세요' }); await first.waitFor();
    await page.setViewportSize(sizes[0]);
    await first.getByPlaceholder('지금 비밀번호 (받은 비밀번호)').fill(password);
    await page.mouse.click(4, 4); await page.keyboard.press('Escape'); assert.ok(await first.isVisible());
    await first.getByPlaceholder('6자 이상').fill(password + '-new'); await first.getByPlaceholder('한 번 더').fill(password + '-new');
    await btn('바꾸기', first).click(); await first.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('[data-id="academy-ai"]').count(), 0);
    await nav('students', '학생 명단'); await check('선생님학생명단', sizes[2]);
    await signOut(); await signIn('review-student');
    if (await page.getByPlaceholder('지금 비밀번호', { exact: true }).count()) {
      await page.getByPlaceholder('지금 비밀번호', { exact: true }).fill(password);
      await page.getByPlaceholder('6자 이상').fill(password + '-new'); await page.getByPlaceholder('한 번 더').fill(password + '-new');
      await btn('비밀번호 바꾸기').click(); await page.getByText('비밀번호를 바꿨어요', { exact: true }).waitFor();
    }
    await nav('my-notes', '내 오답노트'); await btn('PDF 보기').waitFor();
    for (const size of sizes) await check('학생오답노트', size);
    await nav('student-navi', '마고 과목내비'); await check('학생과목내비', sizes[2]);
    await nav('account', '내 계정'); await check('학생계정', sizes[2]);
    await signOut(); await signIn('admin');
    for (const [id, title] of [['people', '계정 관리'], ['codes', '원장 가입 코드'], ['apps-admin', '프로그램 관리'], ['audit', '활동 기록'], ['server', '서버 설정']]) {
      await nav(id, title); await check(`운영자${id}`, sizes[0]);
      if (id === 'people') {
        await btn('학원 관리').click(); await page.getByRole('dialog').waitFor();
        for (const size of sizes) await check('학원관리입력창', size);
        await btn('닫기', page.getByRole('dialog').locator('.dialog-foot')).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
      }
    }
    assert.deepEqual(errors, [], '브라우저 오류');
    assert.deepEqual(results.filter((r) => r.issues.length), [], '화면 넘침·버튼 잘림');
    console.log(`REVIEW_PASS=${results.length}; FAIL=0; roles=4; screenshots=${captures.size}`);
  } finally {
    await app?.close().catch(() => {});
    await server.close();
    const resolved = path.resolve(temp);
    assert.equal(path.dirname(resolved), __dirname);
    assert.ok(path.basename(resolved).startsWith('.easy-review-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}
