'use strict';

const path = require('node:path');

if (!process.versions.electron) {
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const { spawn } = require('node:child_process');
  test('학생 웹 화면: 실제 렌더러와 API 약속', async (t) => {
    const tempDir = require('node:os').tmpdir();
    const profile = fs.mkdtempSync(path.join(tempDir, '.student-ui-'));
    t.after(() => {
      const target = path.resolve(profile);
      assert.equal(path.dirname(target), path.resolve(tempDir));
      assert.ok(path.basename(target).startsWith('.student-ui-'));
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [__filename, `--user-data-dir=${profile}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let errors = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('화면 시험이 90초 안에 끝나지 않았어요.\n' + output + errors)); }, 90000);
      child.stdout.on('data', (b) => { output += b; });
      child.stderr.on('data', (b) => { errors += b; });
      child.on('error', reject);
      child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output, errors }); });
    });
    const line = result.output.split(/\r?\n/).find((s) => s.startsWith('STUDENT_TESTS='));
    assert.ok(line, result.output + result.errors);
    const cases = JSON.parse(line.slice('STUDENT_TESTS='.length));
    for (const c of cases) await t.test(c.name, () => assert.equal(c.error, null, c.error || c.name));
    assert.equal(result.code, 0, result.errors);
  });
} else {
  const { app, BrowserWindow, session } = require('electron');
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
    const win = new BrowserWindow({ show: false, width: 1360, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const results = [];
    const run = async (name, fn, role) => {
      try {
        await win.loadFile(path.join(__dirname, 'renderer.html'));
        await win.webContents.executeJavaScript(`(${setup.toString()})()`);
        if (role) await win.webContents.executeJavaScript(`state.user.role = ${JSON.stringify(role)}`);
        await win.webContents.executeJavaScript(`(${fn.toString()})()`);
        results.push({ name, error: null });
      } catch (e) { results.push({ name, error: e.stack || e.message }); }
    };
    await run('PC 맞추기 전 상태는 15px 구름과 세 점, 나머지 상태 유지', async () => {
      const { HomeView } = await import('./js/views/home.js');
      const { icon } = await import('./js/icons.js');
      state.web = false;
      state.apps = [{ id: 'pending', name: '시험 프로그램', installed: { version: '1' }, sync: null }];
      const view = new HomeView({ cloud, store: { state }, go() {} });
      mount(view);
      const row = view.cards.get('pending').sync;
      const normalize = (s) => { const t = document.createElement('template'); t.innerHTML = s; return t.innerHTML.replace(/icm\d+/g, 'mask'); };
      equal(row.textContent, '아직 서버와 맞추기 전');
      equal(normalize(row.querySelector('svg').outerHTML), normalize(icon('cloudPending', 15)));
      equal(row.querySelectorAll('image').length, 0);
      ok(row.querySelector('mask path'), '대기 표시를 구름에 뚫어요');
      state.apps[0].sync = { at: Date.now() };
      view.update(state);
      equal(normalize(row.querySelector('svg').outerHTML), normalize(icon('cloudCheck', 15)));
      state.apps[0].sync = { status: 'offline' };
      view.update(state);
      equal(normalize(row.querySelector('svg').outerHTML), normalize(icon('cloudOff', 15)));
    });
    await run('학생 메뉴 다섯 개·막힌 해시·임시 비밀번호 강제·변경 뒤 복귀', async () => {
      state.user.mustChangePassword = true;
      history.replaceState(null, '', '#/students');
      await import('./js/app.js');
      await until(() => document.querySelector('.nav'));
      equal([...document.querySelectorAll('.nav-item span')].map((n) => n.textContent), ['내 오답노트', '마고 과목내비', '내 계정', '문의하기', '도움말']);
      ok(document.querySelector('.page').textContent.includes('새 비밀번호 설정'));
      ok(!calls.length, '비밀번호 변경 전에는 목록을 요청하지 않아요');
      document.querySelector('[data-id="my-notes"]').click();
      ok(document.querySelector('.page').textContent.includes('새 비밀번호 설정'));
      const inputs = document.querySelectorAll('.page input[type=password]');
      inputs[0].value = 'temporary'; inputs[1].value = inputs[2].value = 'new-pass';
      button('비밀번호 바꾸기', document.querySelector('.page')).click();
      await until(() => calls.some((c) => c[0] === 'password'));
      state.user.mustChangePassword = false; onState(state);
      document.querySelector('[data-id="my-notes"]').click();
      await until(() => calls.some((c) => c[1] === '/api/me/notes'));
      history.replaceState(null, '', '#/people'); window.dispatchEvent(new PopStateEvent('popstate'));
      equal(document.querySelector('.title').textContent, '내 오답노트');
      ok(!calls.some((c) => /students|users|sync|devices|apps/.test(c[1] || '')));
    });
    await run('학생 SSO도 임시 비밀번호를 바꾼 뒤 진행', async () => {
      state.user.mustChangePassword = true;
      history.replaceState(null, '', '#/sso?app=mago-navi&state=local-state');
      await import('./js/app.js');
      await until(() => document.querySelector('.page'));
      ok(document.querySelector('.page').textContent.includes('새 비밀번호 설정'));
      equal(calls, []);
      state.user.mustChangePassword = false; onState(state);
      await until(() => button('계속'));
      ok(document.body.textContent.includes('mago-navi'));
      equal(calls, []);
    });
    await run('초대 해시: 이름 확인·비밀번호 확인·가입 세션', async () => {
      state.phase = 'login'; state.user = null;
      cloud.checkStudentInvite = async (code) => { calls.push(['invite', code]); return { academyName: '마고학원', studentName: '김학생' }; };
      cloud.joinStudent = async (body) => { calls.push(['join', body]); };
      history.replaceState(null, '', '#/join?code=invite%2Fone');
      await import('./js/app.js');
      await until(() => document.body.textContent.includes('마고학원 · 김학생'));
      equal(calls[0], ['invite', 'invite/one']);
      const inputs = document.querySelectorAll('.auth-card input');
      inputs[1].value = 'student01'; inputs[2].value = 'secret12'; inputs[3].value = 'different';
      button('가입하기').click();
      await tick();
      ok(document.body.textContent.includes('비밀번호가 서로 달라요'));
      ok(!calls.some((c) => c[0] === 'join'));
      inputs[3].value = 'secret12'; button('가입하기').click();
      await until(() => calls.some((c) => c[0] === 'join'));
      equal(calls.find((c) => c[0] === 'join')[1], { code: 'invite/one', username: 'student01', password: 'secret12' });
    });
    await run('PC 로그인: student_web_only 안내', async () => {
      state.phase = 'login'; state.user = null; state.web = false;
      cloud.login = async () => { throw Object.assign(new Error('student_web_only'), { code: 'student_web_only' }); };
      await import('./js/app.js');
      await until(() => button('로그인'));
      button('로그인').click(); await tick();
      ok(document.body.textContent.includes('학생 계정은 인터넷 브라우저에서 https://local.test 에 접속해 사용하세요.'));
    });
    await run('로그인 링크: 웹은 세 줄·도움말 한 줄·PC에는 내려받기 없음', async () => {
      state.phase = 'login'; state.user = null; state.launcher = { version: '1.0.0' };
      const { store } = await import('./js/app.js');
      await until(() => button('가입 코드가 있어요'));
      equal(document.querySelectorAll('.auth-card > .auth-links').length, 3);
      equal([...document.querySelector('.auth-support').children].map((el) => el.textContent), ['비밀번호를 잊었어요', '사용 설명서']);
      ok(!button('원장 가입 코드가 있어요') && !button('학생 초대 코드가 있어요'));
      state.web = false; store.state = state;
      state.phase = 'setup'; onState(state); state.phase = 'login'; onState(state);
      equal(document.querySelectorAll('.auth-card > .auth-links').length, 2);
      ok(!document.querySelector('a[href="/download/launcher"]'));
    });
    await run('통합 코드: 원장 다음 단계·코드 변경 중 응답 무시·오류 문구', async () => {
      state.phase = 'login'; state.user = null;
      let resolve;
      cloud.checkCode = (code) => { calls.push(['code', code]); return new Promise((r) => { resolve = r; }); };
      await import('./js/app.js'); await until(() => button('가입 코드가 있어요'));
      button('가입 코드가 있어요').click();
      const code = document.querySelector('.auth-card input'); code.value = 'old'; button('다음').click();
      code.value = 'new'; resolve({ role: 'director', academyName: '이전 학원' }); await tick();
      equal(document.querySelector('.auth-head h1').textContent, '가입 코드 확인');
      button('다음').click(); resolve({ role: 'director', academyName: '새 학원' }); await tick();
      equal(document.querySelector('.auth-head h1').textContent, '원장 가입');
      equal(document.querySelector('.auth-card input').value, '새 학원');
      ok(button('가입하기'));
      button('로그인으로 돌아가기').click();
      cloud.checkCode = async () => { throw new Error('코드를 다시 확인해 주세요'); };
      button('다음').click(); await tick();
      equal(document.querySelector('.error-text').textContent, '코드를 다시 확인해 주세요');
    });
    await run('통합 코드: 학생은 확인 중복 없이 계정 입력·PC는 웹 초대 주소', async () => {
      state.phase = 'login'; state.user = null;
      cloud.checkCode = async () => ({ role: 'student', academyName: '마고학원', studentName: '김학생' });
      cloud.checkStudentInvite = async () => { throw new Error('이미 확인한 코드를 다시 조회함'); };
      cloud.joinStudent = async (body) => calls.push(['join', body]);
      await import('./js/app.js'); await until(() => button('가입 코드가 있어요'));
      button('가입 코드가 있어요').click(); document.querySelector('.auth-card input').value = 'invite/one'; button('다음').click();
      await until(() => button('가입하기'));
      equal(document.querySelector('.auth-head h1').textContent, '학생 계정 만들기');
      ok(document.body.textContent.includes('마고학원 · 김학생'));
      ok(!button('초대 확인'));
      const inputs = document.querySelectorAll('.auth-card input');
      inputs[0].value = 'student01'; inputs[1].value = inputs[2].value = 'secret12'; button('가입하기').click();
      await until(() => calls.some((c) => c[0] === 'join'));
      equal(calls.find((c) => c[0] === 'join')[1], { code: 'invite/one', username: 'student01', password: 'secret12' });
      state.web = false; button('로그인으로 돌아가기').click();
      button('가입 코드가 있어요').click(); document.querySelector('.auth-card input').value = 'invite/one'; button('다음').click();
      await until(() => calls.some((c) => c[0] === 'external'));
      equal(calls.at(-1), ['external', 'https://local.test/#/join?code=invite%2Fone']);
    });
    await run('도움말: 역할별 메뉴 위치·외부 주소·현재 화면 유지', async () => {
      history.replaceState(null, '', '#/account');
      await import('./js/app.js');
      await until(() => document.querySelector('.nav'));
      for (const web of [true, false]) {
        state.web = web;
        for (const [role, page] of [['student', 'student.html'], ['director', 'director.html'], ['teacher', 'teacher.html'], ['admin', 'index.html']]) {
          state.user.role = role;
          onState(state);
          const help = document.querySelector('[data-id="help"]');
          equal(help.title, '브라우저에서 열기');
          equal(help.querySelectorAll('svg').length, 2);
          ok(help.querySelector('circle'));
          if (role === 'student') equal(help.previousElementSibling.dataset.id, 'inquiries');
          else equal(help.nextElementSibling.dataset.id, 'settings');
          const current = document.querySelector('.page').firstElementChild;
          const hash = location.hash;
          help.click();
          equal(calls.at(-1), ['external', `https://local.test/help/${page}`]);
          ok(document.querySelector('.page').firstElementChild === current);
          equal(location.hash, hash);
          ok(!help.classList.contains('active'));
        }
      }
    });
    await run('로그인 도움말: 앱·웹 주소 우선순위와 서버 설정 전 기본 주소', async () => {
      state.phase = 'login'; state.user = null;
      await import('./js/app.js');
      await until(() => button('사용 설명서'));
      for (const web of [true, false]) {
        state.web = web;
        for (const [config, base] of [
          [{ serverUrl: 'https://school.test/', defaultServerUrl: 'https://default.test' }, 'https://school.test'],
          [{ serverUrl: '', defaultServerUrl: 'https://default.test/' }, 'https://default.test'],
          [{ serverUrl: '', defaultServerUrl: '' }, 'https://mago.milky.kr'],
        ]) {
          state.config = config;
          button('사용 설명서').click();
          equal(calls.at(-1), ['external', `${base}/help/`]);
        }
      }
      state.phase = 'setup'; onState(state);
      ok(document.body.textContent.includes('서버 연결'));
      button('처음이세요? 사용 설명서 보기').click();
      equal(calls.at(-1), ['external', 'https://mago.milky.kr/help/']);
    });
    await run('비밀번호 안내: 역할별 세 줄·확인으로 닫기', async () => {
      state.phase = 'login'; state.user = null;
      await import('./js/app.js');
      await until(() => button('비밀번호를 잊었어요'));
      button('비밀번호를 잊었어요').click();
      equal(topDialog().querySelector('.dialog-title').textContent, '비밀번호를 잊었어요');
      equal([...topDialog().querySelector('.dialog-sub').children].map((el) => el.textContent), [
        '선생님: 원장님께 비밀번호 초기화를 요청하세요.',
        '원장님: 운영자에게 문의하세요.',
        '학생: 담당 선생님께 비밀번호 초기화를 요청하세요.',
      ]);
      ok(!button('취소', topDialog()));
      button('확인', topDialog()).click();
      await until(() => !topDialog());
    });
    await run('웹 API: 학생 로그인·금지 요청 없음·아이디 변경·인증된 PDF·403', async () => {
      localStorage.clear();
      let user = { ...state.user, mustChangePassword: true };
      let deny = false;
      window.fetch = async (url, options) => {
        const body = options.body ? JSON.parse(options.body) : undefined;
        calls.push([options.method, url, body, options.headers]);
        let data = {};
        if (url === '/api/auth/login' || url === '/api/join') data = { token: 'local-session', user };
        else if (url === '/api/me' && options.method === 'PATCH') user = { ...user, username: body.username };
        else if (url === '/api/me') data = { user };
        else if (url === '/api/me/password') user = { ...user, mustChangePassword: false };
        else if (String(url).endsWith('/pdf')) return new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } });
        else if (url === '/api/me/notes') {
          if (deny) return new Response(JSON.stringify({ error: { code: 'password_change_required' } }), { status: 403, headers: { 'content-type': 'application/json' } });
          data = [];
        }
        return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
      };
      const { createWebCloud } = await import('./js/web-cloud.js');
      const web = createWebCloud(); await web.getState(); await web.login('student', 'temporary');
      await web.refreshApps(); await web.refreshNotices();
      ok(!calls.some((c) => ['/api/apps', '/api/notices', '/api/sync', '/api/me/devices'].includes(c[1])));
      await web.changePassword('temporary', 'new-pass', false);
      equal((await web.getState()).user.mustChangePassword, false);
      await web.changeUsername('newstudent');
      equal(calls.find((c) => c[0] === 'PATCH' && c[1] === '/api/me')[2], { username: 'newstudent' });
      const pdf = await web.studentNotePdf('note/a');
      equal(await pdf.text(), '%PDF-1.7');
      equal(calls.find((c) => c[1].endsWith('/pdf')).slice(1), ['/api/me/notes/note%2Fa/pdf', undefined, { authorization: 'Bearer local-session' }]);
      deny = true;
      try { await web.api('GET', '/api/me/notes'); throw new Error('403이 필요해요'); } catch (e) { equal(e.code, 'password_change_required'); }
      equal((await web.getState()).user.mustChangePassword, true);
      await web.joinStudent({ code: 'one', username: 'newstudent', password: 'new-pass' });
      equal(calls.find((c) => c[1] === '/api/join')[2], { code: 'one', username: 'newstudent', password: 'new-pass' });
      await web.logout();
    });
    await run('학생 내 계정: 이름 편집·저장 공간·기기 목록 없음', async () => {
      const { AccountView } = await import('./js/views/account.js');
      const view = new AccountView({ cloud, store: { state } }); mount(view);
      ok(!view.el.textContent.includes('서버 저장 공간'));
      ok(!view.el.textContent.includes('로그인한 기기'));
      equal(calls, []);
      ok(view.el.textContent.includes('담당 선생님: 이선생'));
      view.el.querySelector('input:not([type=password])').value = 'renamed';
      button('아이디 바꾸기').click(); await tick();
      equal(calls[0], ['username', 'renamed', '']);
    });
    await run('오답노트: 빈 목록·답지 표시·PDF 새 탭/받기·팝업 실패', async () => {
      const { StudentNotesView } = await import('./js/views/student.js');
      const view = new StudentNotesView({ cloud }); mount(view); await tick();
      ok(view.el.textContent.includes('아직 내 오답노트가 없어요'));
      cloud.api = async () => [{ id: 'n1', title: '한글 <노트>', updatedAt: 1, problemCount: 3, answersAllowed: true }, { id: 'n2', title: '두번째', problemCount: 1, answersAllowed: false }];
      await view.load();
      ok(view.el.textContent.includes('답지 포함') && view.el.textContent.includes('문제만'));
      const tab = { document: { body: {} }, location: { replace: (url) => calls.push(['open-pdf', url]) }, close() {}, closed: false };
      window.open = () => tab;
      cloud.studentNotePdf = async (id) => { calls.push(['pdf', id]); return new Blob(['%PDF-1.7'], { type: 'application/pdf' }); };
      await view.pdf({ id: 'n1', title: '한글' }, false);
      equal(tab.opener, null); ok(calls.some((c) => c[0] === 'open-pdf' && c[1].startsWith('blob:')));
      HTMLAnchorElement.prototype.click = function () { calls.push(['download', this.download, this.href]); };
      await view.pdf({ id: 'n2', title: '한글/노트' }, true);
      equal(calls.find((c) => c[0] === 'download')[1], '한글_노트.pdf');
      const before = calls.length; window.open = () => null;
      await view.pdf({ id: 'n1' }, false); equal(calls.length, before);
      cloud.api = async () => { throw new Error('노트를 불러오지 못했어요'); };
      await view.load(); ok(view.el.textContent.includes('노트를 불러오지 못했어요'));
    });
    await run('마고 과목내비: 웹 카드만, 프로그램 목록 요청 없음', async () => {
      const { StudentNaviView } = await import('./js/views/student.js');
      mount(new StudentNaviView({ cloud, store: { state } }));
      const logo = document.querySelector('.app-icon img');
      ok(logo, '학생 카드도 카탈로그의 앱 로고');
      equal(logo.getAttribute('src'), '/api/apps/mago-navi/icon?logo=pc');
      equal(getComputedStyle(document.querySelector('.app-icon')).width, '56px');
      equal(getComputedStyle(document.querySelector('.app-name')).fontSize, '17px');
      button('열기').click(); await tick();
      equal(calls, [['external', 'https://magonavi.milky.kr']]);
      ok(!document.getElementById('root').textContent.includes('PC에 설치'));
    });
    await run('학생 명단: 계정 상태·직접 만들기·아이디/상태/AI 저장', async () => {
      const { StudentsView } = await import('./js/views/students.js');
      state.user.role = 'director';
      const students = [{ id: 's/1', name: '김학생', account: null }, { id: 's2', name: '이학생', account: { username: 'old', status: 'disabled', mustChangePassword: true, aiMode: 'academy' } }];
      cloud.api = async (m, p, b) => { calls.push([m, p, b]); return p === '/api/students' ? { students, purgeDays: 30 } : { members: [] }; };
      const view = new StudentsView({ cloud, store: { state } }); mount(view); await until(() => view.loaded);
      ok(view.el.textContent.includes('꺼짐') && view.el.textContent.includes('비밀번호 변경 전'));
      let promise = view.account(students[0]);
      topDialog().querySelector('input').value = 'newstudent'; topDialog().querySelector('input[type=password]').value = 'pass1234';
      button('직접 만들기', topDialog()).click(); await promise;
      equal(calls.find((c) => c[0] === 'POST'), ['POST', '/api/students/s%2F1/account', { username: 'newstudent', password: 'pass1234' }]);
      promise = view.account(students[1]);
      topDialog().querySelector('input').value = 'changed'; topDialog().querySelector('input[type=checkbox]').click(); topDialog().querySelector('select').value = 'teacher';
      button('저장', topDialog()).click(); await promise;
      equal(calls.find((c) => c[0] === 'PATCH'), ['PATCH', '/api/students/s2/account', { username: 'changed', status: 'active', aiMode: 'teacher' }]);
    });
    await run('일괄 생성: 선택·학원 범위·한 번만 결과·건너뛴 사유', async () => {
      const { StudentsView } = await import('./js/views/students.js');
      state.user.role = 'admin';
      cloud.api = async (m, p, b) => {
        calls.push([m, p, b]);
        if (p === '/api/academies') return { academies: [{ id: 7, name: '마고' }] };
        if (p.startsWith('/api/academy/members')) return { members: [] };
        if (p === '/api/academy?academy=7') return { code: 'mago' };
        if (m === 'GET') return { students: [{ id: 's1', name: '김학생' }, { id: 's2', name: '이학생' }], purgeDays: 30 };
        return { created: [{ studentId: 's1', name: '김학생', username: 'mago2611001', password: 'one-time' }], skipped: [{ studentId: 's2', name: '이학생', reason: 'account_exists' }] };
      };
      const view = new StudentsView({ cloud, store: { state } }); mount(view); await until(() => view.loaded);
      view.table.querySelector('thead input').click(); equal(view.selected.size, 2);
      view.bulk.click(); await until(() => topDialog()); button('일괄 생성', topDialog()).click();
      await until(() => topDialog()?.textContent.includes('한 번만 보여요') && topDialog()?.textContent.includes('one-time'));
      equal(calls.find((c) => c[0] === 'POST'), ['POST', '/api/students/accounts/bulk?academy=7', { studentIds: ['s1', 's2'] }]);
      ok(topDialog().textContent.includes('이미 계정이 있어요'));
      ok(button('인쇄', topDialog()) && button('CSV 받기', topDialog()));
      button('닫기', topDialog()).click(); await tick();
      ok(!view.bulk.disabled); equal(view.bulk.textContent, '계정 만들기'); equal(view.selected.size, 0);
    });
    await run('일괄 생성: 선택 없으면 요청 없음·고른 학생만 전송·취소', async () => {
      const { StudentsView } = await import('./js/views/students.js'); state.user.role = 'director';
      cloud.api = async (m, p, b) => { calls.push([m,p,b]);
        if (p === '/api/academy') return { code: 'mago' };
        if (p === '/api/academy/members') return { members: [] };
        if (m === 'GET') return { students: [{ id: 's1', name: '하나' }, { id: 's2', name: '둘' }], purgeDays: 30 };
        return { created: [], skipped: [] }; };
      const view = new StudentsView({ cloud, store: { state } }); mount(view); await until(() => view.loaded);
      calls.length = 0; await view.bulkAccounts(); equal(calls, []); equal(view.bulkHint.style.display, 'none');
      view.table.querySelector('tbody input').click(); equal(view.selected.size, 1); ok(view.bulkHint.textContent.includes('1명 골랐어요'));
      const pending = view.bulkAccounts(); await until(() => topDialog()); button('일괄 생성', topDialog()).click();
      await until(() => calls.some((c) => c[0] === 'POST'));
      equal(calls.find((c) => c[0] === 'POST'), ['POST', '/api/students/accounts/bulk', { studentIds: ['s1'] }]);
      await until(() => button('닫기', topDialog())); button('닫기', topDialog()).click(); await pending;
      view.table.querySelector('thead input').click(); equal(view.selected.size, 2);
      button('고르기 취소', view.el).click(); equal(view.selected.size, 0);
    });
    await run('학원 코드 없음: 원장은 현장에서 설정, 선생님은 안내', async () => {
      const { StudentsView } = await import('./js/views/students.js');
      state.user.role = 'director';
      let code = null;
      cloud.api = async (m, p, b) => {
        calls.push([m, p, b]);
        if (p === '/api/academy') { if (m === 'PATCH') code = b.code; return { code }; }
        if (p === '/api/academy/members') return { members: [] };
        if (p === '/api/students') return { students: [{ id: 's1', name: '학생' }], purgeDays: 30 };
        return { created: [], skipped: [] };
      };
      const view = new StudentsView({ cloud, store: { state } }); mount(view); await until(() => view.loaded);
      view.selected.add('s1'); const pending = view.bulkAccounts();
      await until(() => topDialog()?.textContent.includes('학원 코드 정하기'));
      topDialog().querySelector('input').value = 'M'; button('저장', topDialog()).click(); await tick();
      ok(!calls.some((c) => c[0] === 'PATCH'));
      topDialog().querySelector('input').value = 'mago'; button('저장', topDialog()).click();
      await until(() => topDialog()?.textContent.includes('1명의 계정을'));
      button('취소', topDialog()).click(); await pending;
      equal(code, 'mago');
      ok(!view.el.querySelector('.page-head').textContent.includes('학원 코드'));
      code = null; view.role = 'teacher'; await view.bulkAccounts();
      ok(document.body.textContent.includes('학원 코드 설정은 원장님께 요청하세요'));
      ok(!calls.some((c) => c[0] === 'POST'));
    });
    await run('일괄 생성 400 academy_code_required도 현장에서 설정 후 재시도', async () => {
      const { StudentsView } = await import('./js/views/students.js');
      state.user.role = 'director';
      let tries = 0;
      cloud.api = async (m, p, b) => {
        calls.push([m, p, b]);
        if (p === '/api/academy') return { code: 'mago' };
        if (p === '/api/academy/members') return { members: [] };
        if (p === '/api/students') return { students: [{ id: 's1', name: '학생' }], purgeDays: 30 };
        if (++tries === 1) throw Object.assign(new Error('학원 코드를 정해 주세요.'), { code: 'academy_code_required', status: 400 });
        return { created: [], skipped: [{ studentId: 's1', name: '학생', reason: 'account_exists' }] };
      };
      const view = new StudentsView({ cloud, store: { state } }); mount(view); await until(() => view.loaded);
      view.selected.add('s1'); const pending = view.bulkAccounts();
      await until(() => button('일괄 생성', topDialog() || document)); button('일괄 생성', topDialog()).click();
      await until(() => topDialog()?.textContent.includes('학원 코드 정하기'));
      topDialog().querySelector('input').value = 'newmago'; button('저장', topDialog()).click();
      await until(() => topDialog()?.textContent.includes('건너뛴 학생'));
      equal(tries, 2); ok(calls.some((c) => c[0] === 'PATCH' && c[1] === '/api/academy' && c[2].code === 'newmago'));
      button('닫기', topDialog()).click(); await pending;
    });
    await run('초대 발급·만료·주소/코드 복사·취소', async () => {
      const { StudentsView } = await import('./js/views/students.js');
      state.user.role = 'director';
      cloud.api = async (m, p, b) => { calls.push([m, p, b]); return m === 'POST' ? { code: 'invite/one', expiresAt: 1794000000000 } : p === '/api/students' ? { students: [], purgeDays: 30 } : { members: [] }; };
      const view = new StudentsView({ cloud, store: { state } }); mount(view); await until(() => view.loaded);
      const pending = view.account({ id: 's1', name: '김학생' });
      button('초대 코드 만들기', topDialog()).click(); button('만들기', topDialog()).click();
      await until(() => topDialog()?.textContent.includes('코드는 이 창에서만 보여요.'));
      button('가입 주소 복사', topDialog()).click(); button('코드 복사', topDialog()).click(); await tick();
      ok(calls.some((c) => c[0] === 'copy' && c[1] === 'https://local.test/#/join?code=invite%2Fone'));
      ok(topDialog().textContent.includes('까지 1회 사용'));
      button('닫기', topDialog()).click(); await tick();
      button('초대 코드 취소', topDialog()).click(); button('초대 취소', topDialog()).click(); await tick();
      ok(calls.some((c) => c[0] === 'DELETE' && c[1] === '/api/students/s1/invite'));
      button('닫기', topDialog()).click(); await pending;
    });
    await run('계정 초기화·한 번만 비밀번호·계정만 삭제', async () => {
      const { StudentsView } = await import('./js/views/students.js');
      state.user.role = 'director';
      cloud.api = async (m, p, b) => { calls.push([m, p, b]); return m === 'PATCH' ? { password: 'reset-once' } : p === '/api/students' ? { students: [], purgeDays: 30 } : { members: [] }; };
      const view = new StudentsView({ cloud, store: { state } }); mount(view); await until(() => view.loaded);
      const student = { id: 's1', name: '학생', account: { username: 'student1', status: 'active' } };
      let pending = view.account(student);
      button('비밀번호 초기화', topDialog()).click(); button('초기화', topDialog()).click();
      await until(() => topDialog()?.textContent.includes('reset-once'));
      equal(calls.find((c) => c[0] === 'PATCH'), ['PATCH', '/api/students/s1/account', { resetPassword: true }]);
      button('확인', topDialog()).click(); await pending;
      pending = view.account(student); button('계정 지우기', topDialog()).click(); button('계정 지우기', topDialog()).click();
      await pending;
      ok(calls.some((c) => c[0] === 'DELETE' && c[1] === '/api/students/s1/account'));
      ok(!calls.some((c) => c[0] === 'DELETE' && c[1] === '/api/students/s1'));
    });
    await run('입력 뒤 간격: 계정 만들기 툴바', async () => {
      const view = await studentsPage();
      const pending = view.account({ id: 's1', name: '학생' });
      const toolbar = topDialog().querySelector('.field + .toolbar');
      ok(toolbar, '비밀번호 바로 뒤 툴바가 있어요');
      ok(parseFloat(getComputedStyle(toolbar).marginTop) > 0, '입력과 툴바 사이에 여백이 있어야 해요');
      equal(getComputedStyle(toolbar).marginTop, '14px');
      button('닫기', topDialog()).click(); await pending;
    });
    await run('입력 뒤 간격: 학생 초대 확인 버튼', async () => {
      const { StudentJoinView } = await import('./js/views/student.js');
      const view = new StudentJoinView({ cloud, back() {} }); mount(view);
      const check = view.el.querySelector('.field + .btn');
      ok(check, '초대 코드 바로 뒤 버튼이 있어요');
      ok(parseFloat(getComputedStyle(check).marginTop) > 0, '입력과 버튼 사이에 여백이 있어야 해요');
      equal(getComputedStyle(check).marginTop, '14px');
    });
    await run('학생 명단·선생님 관리: 학원 설정 단추 제거', async () => {
      const view = await studentsPage(); ok(!view.el.querySelector('.page-head').textContent.includes('학원 코드'));
      const { PeopleView } = await import('./js/views/people.js');
      cloud.api = async (m,p) => p === '/api/academies' ? { academies: [] } : { users: [], invites: [] };
      const people = new PeopleView({ cloud, store: { state } }); mount(people);
      ok(!people.el.textContent.includes('학원 이름 바꾸기')); ok(!people.el.textContent.includes('학원 관리'));
    });
    await run('학생 추가: 나중에 기본값·추가 POST만·고치기에는 계정 선택 없음', async () => {
      const view = await studentsPage();
      const { pending } = addStudent(view);
      equal(topDialog().querySelector('.seg .on').textContent, '나중에');
      ok(topDialog().textContent.includes('명단에서 나중에 만들어요.'));
      button('추가', topDialog()).click(); await pending;
      equal(calls.filter((c) => c[0] === 'POST').map((c) => c[1]), ['/api/students']);
      await until(() => view.students.length === 1);
      const editing = view.edit(view.students[0]);
      await until(() => topDialog()); ok(!topDialog().querySelector('.seg')); button('닫기', topDialog()).click(); await editing;
    });
    await run('학생 추가: 초대 코드·새 ID로 발급·공유 결과창·복사', async () => {
      const view = await studentsPage({ role: 'admin' });
      const { pending } = addStudent(view, '초대 코드');
      ok(topDialog().textContent.includes('7일 안에 직접 아이디·비밀번호를 정해요'));
      button('추가', topDialog()).click();
      await until(() => topDialog()?.textContent.includes('학생 초대 코드를 만들었어요'));
      equal(calls.filter((c) => c[0] === 'POST').map((c) => c[1]), ['/api/students?academy=7', '/api/students/new%2Fstudent/invite?academy=7']);
      equal(document.querySelectorAll('.dim:not(.out) .dialog').length, 1);
      ok(topDialog().textContent.includes('invite/new') && topDialog().textContent.includes('까지 1회 사용'));
      button('가입 주소 복사', topDialog()).click(); button('코드 복사', topDialog()).click(); await tick();
      ok(calls.some((c) => c[0] === 'copy' && c[1] === 'https://local.test/#/join?code=invite%2Fnew'));
      ok(calls.some((c) => c[0] === 'copy' && c[1] === 'invite/new'));
      ok(!document.querySelector('.toasts')?.textContent.includes('학생을 추가했어요'));
      button('닫기', topDialog()).click(); await pending;
      await until(() => view.students.length === 1);
    });
    await run('학생 추가: 임시 계정·새 ID 한 명만·한 번만 결과창', async () => {
      const view = await studentsPage({ role: 'admin' });
      const { pending } = addStudent(view, '아이디·임시 비밀번호');
      ok(topDialog().textContent.includes('학원 코드로 자동 발급해요.'));
      button('추가', topDialog()).click();
      await until(() => topDialog()?.textContent.includes('temporary-once'));
      equal(calls.filter((c) => c[0] === 'POST').map((c) => c[1]), ['/api/students?academy=7', '/api/students/accounts/bulk?academy=7']);
      equal(calls.find((c) => c[0] === 'POST' && c[1].includes('/bulk'))[2], { studentIds: ['new/student'] });
      ok(topDialog().textContent.includes('한 번만 보여요'));
      button('닫기', topDialog()).click(); await pending;
      await until(() => view.students.length === 1);
    });
    await run('학생 추가 임시 계정: 코드 없는 원장은 설정 후 생성·라벨 갱신', async () => {
      const view = await studentsPage({ code: null });
      const { pending } = addStudent(view, '아이디·임시 비밀번호'); button('추가', topDialog()).click();
      await until(() => topDialog()?.textContent.includes('학원 코드 정하기'));
      equal(document.querySelectorAll('.dim:not(.out) .dialog').length, 1);
      ok(!calls.some((c) => c[1].includes('/bulk')));
      topDialog().querySelector('input').value = 'newmago'; button('저장', topDialog()).click();
      await until(() => topDialog()?.textContent.includes('temporary-once'));
      ok(!view.el.querySelector('.page-head').textContent.includes('학원 코드'));
      equal(calls.find((c) => c[0] === 'POST' && c[1].includes('/bulk'))[2], { studentIds: ['new/student'] });
      button('닫기', topDialog()).click(); await pending;
    });
    await run('학생 추가 임시 계정: 코드 없는 선생님은 안내·학생 유지·계정 POST 없음', async () => {
      const view = await studentsPage({ role: 'teacher', code: null });
      const { pending } = addStudent(view, '아이디·임시 비밀번호'); button('추가', topDialog()).click(); await pending;
      ok(document.body.textContent.includes('학생은 추가했어요. 계정은 만들지 못했어요:'));
      ok(document.body.textContent.includes('학원 코드 설정은 원장님께 요청하세요'));
      ok(!document.body.textContent.includes('명단에서 ‘계정 만들기’로 나중에 만들 수 있어요.'));
      ok(!calls.some((c) => c[1].includes('/bulk')));
      equal(calls.filter((c) => c[0] === 'POST').length, 1); ok(!topDialog());
      await until(() => view.students.length === 1);
    });
    await run('학생 추가 임시 계정: 코드 설정 취소해도 학생 유지', async () => {
      const view = await studentsPage({ code: null });
      const { pending } = addStudent(view, '아이디·임시 비밀번호'); button('추가', topDialog()).click();
      await until(() => topDialog()?.textContent.includes('학원 코드 정하기'));
      button('취소', topDialog()).click(); await pending;
      ok(document.body.textContent.includes('학생은 추가했어요. 계정은 만들지 못했어요:'));
      ok(document.body.textContent.includes('‘계정 만들기’'));
      ok(!calls.some((c) => c[1].includes('/bulk')));
      await until(() => view.students.length === 1);
    });
    await run('학생 추가 임시 계정: 400이면 코드 설정 후 같은 ID로 재시도', async () => {
      const view = await studentsPage({ bulkCodeRequired: true });
      const { pending } = addStudent(view, '아이디·임시 비밀번호'); button('추가', topDialog()).click();
      await until(() => topDialog()?.textContent.includes('학원 코드 정하기'));
      topDialog().querySelector('input').value = 'retry'; button('저장', topDialog()).click();
      await until(() => topDialog()?.textContent.includes('temporary-once'));
      equal(calls.filter((c) => c[0] === 'POST' && c[1].includes('/bulk')).map((c) => c[2]), [{ studentIds: ['new/student'] }, { studentIds: ['new/student'] }]);
      equal(calls.filter((c) => c[0] === 'POST' && c[1] === '/api/students').length, 1);
      button('닫기', topDialog()).click(); await pending;
    });
    await run('학생 추가 후 계정 실패: 오류 토스트·추가창 닫힘·명단 새로고침·중복 학생 없음', async () => {
      for (const mode of ['초대 코드', '아이디·임시 비밀번호']) {
        const view = await studentsPage({ accountError: '시험 오류' }); calls.length = 0;
        const { pending } = addStudent(view, mode); button('추가', topDialog()).click(); await pending;
        ok(document.body.textContent.includes('학생은 추가했어요. 계정은 만들지 못했어요: 시험 오류'));
        ok(document.querySelector('.toast.error'));
        ok(!topDialog());
        equal(calls.filter((c) => c[0] === 'POST' && c[1] === '/api/students').length, 1);
        await until(() => view.students.length === 1);
      }
    });
    await run('학생 추가 임시 계정: 학원 코드 조회 실패해도 추가한 명단은 표시', async () => {
      const view = await studentsPage();
      const api = cloud.api;
      cloud.api = async (m, p, b) => {
        if (m === 'GET' && p === '/api/academy') throw new Error('코드 조회 오류');
        return api(m, p, b);
      };
      const { pending } = addStudent(view, '아이디·임시 비밀번호'); button('추가', topDialog()).click(); await pending;
      ok(document.body.textContent.includes('학생은 추가했어요. 계정은 만들지 못했어요: 코드 조회 오류'));
      ok(!calls.some((c) => c[1].includes('/bulk')));
      equal(view.students.length, 1); ok(view.table.textContent.includes('새학생'));
    });
    await run('CSV BOM·인용·수식 보호, iframe 인쇄는 글자 그대로', async () => {
      const { credentialsCsv, printCredentials, downloadBlob } = await import('./js/student-accounts.js');
      const rows = [{ name: '김,"학생"\n<태그>', username: '=SUM(1)', password: 'secret' }];
      const csv = credentialsCsv(rows);
      equal(csv.charCodeAt(0), 0xfeff); ok(csv.includes('"김,""학생""\n<태그>"')); ok(csv.includes("\"'=SUM(1)\""));
      const append = document.body.append.bind(document.body);
      let printed = false;
      document.body.append = (...nodes) => {
        append(...nodes);
        for (const node of nodes) if (node.tagName === 'IFRAME') node.contentWindow.print = () => {
          printed = true;
          equal([...node.contentDocument.querySelectorAll('td')].map((td) => td.textContent), Object.values(rows[0]));
          equal(node.contentDocument.querySelectorAll('script').length, 0);
          node.contentWindow.dispatchEvent(new Event('afterprint'));
        };
      };
      printCredentials(rows); ok(printed); equal(document.querySelectorAll('iframe').length, 0);
      HTMLAnchorElement.prototype.click = function () { calls.push([this.download, this.href]); };
      downloadBlob(new Blob([csv]), '학생.csv'); equal(calls[0][0], '학생.csv'); ok(calls[0][1].startsWith('blob:'));
    });
    await run('중첩 대화상자: Enter는 맨 위만, 저장 중 닫기 방지', async () => {
      const { dialog, input } = await import('./js/ui.js');
      let outer = 0; let inner = 0;
      dialog({ title: '바깥', onOk: () => { outer++; } });
      const field = input(); dialog({ title: '안쪽', body: field, onOk: () => { inner++; } });
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick();
      equal([outer, inner], [0, 1]);
      button('취소', topDialog()).click();
      let finish;
      const pending = dialog({ title: '저장', onOk: () => new Promise((resolve) => { finish = resolve; }) });
      button('확인', topDialog()).click(); button('취소', topDialog()).click();
      ok(topDialog()?.textContent.includes('저장'));
      finish(); await pending;
    });
    await run('내 계정: 계약 과목·학원 공간 제외', async () => {
      const { AccountView } = await import('./js/views/account.js');
      cloud.refreshStorage = async () => ({ apps: [], usageBytes: 0, quotaBytes: 0, academy: { name: '학원공간', apps: [] } });
      cloud.api = async () => ({ devices: [] });
      for (const role of ['director', 'teacher', 'admin', 'student']) {
        state.user = { ...state.user, role, academy: { id: 7, name: '마고', subjects: ['math'] } };
        const view = new AccountView({ cloud, store: { state } }); mount(view); await tick();
        ok(!view.profile.textContent.includes('계약 과목')); ok(!view.storage.textContent.includes('학원 공간'));
      }
    });
    await run('학원 관리: 과목 저장·빈 과목 재확인·취소·새 학원 과목', async () => {
      const { AcademiesView } = await import('./js/views/academies.js');
      state.user.role = 'admin';
      let academy = { id: 7, name: '마고', subjects: ['math'], directors: 1, teachers: 0, usageBytes: 0, quotaBytes: 0 };
      cloud.api = async (m, p, b) => {
        calls.push([m, p, b]);
        if (m === 'GET' && p === '/api/academies') return { academies: [academy] };
        if (m === 'PATCH') { academy = { ...academy, ...b }; return { academy }; }
        if (m === 'POST') return { academy: { id: 8, ...b } };
        return { users: [] };
      };
      const view = new AcademiesView({ cloud, store: { state }, go() {} }); mount(view); await until(() => view.academies?.length);
      const { dialog, h } = await import('./js/ui.js');
      const controls = view.controls(academy);
      const list = h('div', {}, h('span', {}, '과목: 수학'), controls.subjects);
      view.load = async () => { await view.loadAcademies(); list.firstChild.textContent = '과목: ' + (academy.subjects.length ? academy.subjects.map((x) => ({math:'수학',english:'영어'}[x])).join(' · ') : '계약한 과목 없음'); };
      const pending = dialog({ title: '학원 관리', body: list, ok: '닫기', cancel: null });
      ok(topDialog().textContent.includes('과목: 수학'));
      button('과목', topDialog()).click();
      equal(topDialog().querySelector('.dialog-title').textContent, '마고 계약 과목');
      ok(topDialog().textContent.includes('기존 교재는 유지돼요.'));
      equal([...topDialog().querySelectorAll('.check')].map((c) => c.textContent), ['수학', '영어', '국어']);
      equal([...topDialog().querySelectorAll('input')].map((c) => c.checked), [true, false, false]);
      topDialog().querySelectorAll('input')[1].click(); button('저장', topDialog()).click();
      await until(() => topDialog()?.querySelector('.dialog-title').textContent === '학원 관리');
      await until(() => topDialog().textContent.includes('과목: 수학 · 영어'));
      equal(calls.find((c) => c[0] === 'PATCH'), ['PATCH', '/api/academies/7', { subjects: ['math', 'english'] }]);
      button('과목', topDialog()).click();
      for (const input of topDialog().querySelectorAll('input:checked')) input.click();
      button('저장', topDialog()).click(); await until(() => topDialog()?.textContent.includes('이 학원은 새 교재를 등록할 수 없어요.'));
      button('취소', topDialog()).click(); await tick();
      equal(calls.filter((c) => c[0] === 'PATCH').length, 1);
      equal(topDialog().querySelector('.dialog-title').textContent, '마고 계약 과목');
      button('저장', topDialog()).click(); await until(() => topDialog()?.textContent.includes('이 학원은 새 교재를 등록할 수 없어요.'));
      button('저장', topDialog()).click();
      await until(() => topDialog()?.querySelector('.dialog-title').textContent === '학원 관리');
      await until(() => topDialog().textContent.includes('계약한 과목 없음'));
      equal(calls.filter((c) => c[0] === 'PATCH').at(-1)[2], { subjects: [] });
      button('닫기', topDialog()).click(); await pending;
      const adding = view.createAcademy();
      const inputs = topDialog().querySelectorAll('input[type=checkbox]'); equal([...inputs].map((c) => c.checked), [true,false,false]); inputs[2].click();
      topDialog().querySelector('input[placeholder="새 학원 이름"]').value = '새 학원';
      button('추가', topDialog()).click(); await adding;
      equal(calls.find((c) => c[0] === 'POST'), ['POST', '/api/academies', { name: '새 학원', subjects: ['math', 'korean'] }]);
    });
    await run('계정 만들기: 새 학원일 때만 계약 과목과 요청 본문', async () => {
      const { PeopleView } = await import('./js/views/people.js');
      state.user = { ...state.user, role: 'admin', allowedApps: null };
      cloud.api = async (m, p, b) => {
        calls.push([m, p, b]);
        if (p === '/api/academies') return { academies: [{ id: 7, name: '마고', subjects: ['math'] }] };
        if (m === 'POST') return { user: { name: b.name, username: b.username } };
        return { users: [] };
      };
      const view = new PeopleView({ cloud, store: { state } }); mount(view); await until(() => view.academies.length);
      const pending = view.create();
      const dialog = topDialog();
      const [role, academy] = dialog.querySelectorAll('select');
      const newName = dialog.querySelector('input[placeholder="새 학원 이름"]');
      const wrap = newName.closest('.field').parentElement;
      equal(wrap.style.display, 'none');
      academy.value = '__new'; academy.dispatchEvent(new Event('change'));
      equal(wrap.style.display, '');
      equal([...wrap.querySelectorAll('input[type=checkbox]')].map((c) => c.checked), [true, false, false]);
      role.value = 'admin'; role.dispatchEvent(new Event('change')); equal(wrap.style.display, 'none');
      role.value = 'director'; role.dispatchEvent(new Event('change')); equal(wrap.style.display, '');
      newName.value = '새 영어 학원';
      wrap.querySelectorAll('input[type=checkbox]')[0].click(); wrap.querySelectorAll('input[type=checkbox]')[1].click();
      button('만들기', dialog).click(); await pending;
      const body = calls.find((c) => c[0] === 'POST')[2];
      equal([body.academyName, body.academySubjects], ['새 영어 학원', ['english']]);
      ok(!('academyId' in body));
      const existing = view.create(); button('만들기', topDialog()).click(); await existing;
      const existingBody = calls.filter((c) => c[0] === 'POST').at(-1)[2];
      equal(existingBody.academyId, 7); ok(!('academySubjects' in existingBody));
    });
    await run('가입 코드: 과목 선택·요청·목록 표시', async () => {
      const { CodesView } = await import('./js/views/codes.js');
      let codes = [];
      cloud.api = async (m, p, b) => {
        calls.push([m, p, b]);
        if (m === 'POST') {
          const code = { id: 1, code: 'MAGO-TEST-CODE', academyName: b.academyName, subjects: b.subjects, state: 'active', uses: 0, maxUses: 1 };
          codes = [code]; return { code };
        }
        return { codes };
      };
      const view = new CodesView({ cloud }); mount(view); await tick();
      const pending = view.create();
      const checks = topDialog().querySelectorAll('input[type=checkbox]');
      equal([...checks].map((c) => c.checked), [true, false, false]);
      checks[0].click(); checks[1].click();
      button('만들기', topDialog()).click();
      await until(() => topDialog()?.textContent.includes('가입 코드를 만들었어요'));
      equal(calls.find((c) => c[0] === 'POST')[2].subjects, ['english']);
      button('확인', topDialog()).click(); await pending;
      await until(() => view.table.querySelector('tbody'));
      equal([...view.table.querySelectorAll('th')].slice(0, 3).map((c) => c.textContent), ['코드', '학원', '과목']);
      equal(view.table.querySelector('tbody tr').children[2].textContent, '영어');
    });
    await run('활동 기록: 계약 과목과 이전 과목 표시', async () => {
      const { AuditView } = await import('./js/views/audit.js');
      cloud.api = async () => ({ entries: [{ id: 1, at: 1, action: 'academy.subjects', detail: { subjects: ['math', 'english'], before: ['math'] } }], more: false });
      const view = new AuditView({ cloud }); mount(view); await until(() => view.table.querySelector('tbody'));
      ok(view.table.textContent.includes('계약 과목 바꿈'));
      ok(view.table.textContent.includes('수학 · 영어 (전: 수학)'));
    });
    await run('입력 대화창: 바깥 클릭·Esc 보호, 취소·확인은 유지', async () => {
      const { dialog, input } = await import('./js/ui.js');
      const text = input({ value: '작성 중인 내용' });
      const pending = dialog({ title: '입력 보호', body: text });
      const dim = text.closest('.dim');
      dim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      ok(!dim.classList.contains('out'), '바깥 클릭으로 입력창이 닫히면 안 됨');
      text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      ok(!dim.classList.contains('out'), 'Esc로 입력창이 닫히면 안 됨');
      equal(text.value, '작성 중인 내용');
      button('취소', topDialog()).click(); equal(await pending, null);
      const plain = dialog({ title: '확인만' });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      equal(await plain, null);
    });
    await run('오류 알림: 짧은 시간 지정에도 10초 이상, 직접 닫기', async () => {
      const { toast } = await import('./js/ui.js');
      const timers = []; const original = window.setTimeout;
      window.setTimeout = (fn, ms) => { timers.push(ms); return 1; };
      try {
        toast('시험 오류', 'error', 1600);
        ok(timers.some((ms) => ms >= 10000), '오류를 읽을 시간 필요');
        const item = document.querySelector('.toast.error');
        ok(item.getAttribute('role') === 'alert');
        button('닫기', item).click();
        ok(item.classList.contains('out'));
      } finally { window.setTimeout = original; }
    });
    await run('프로그램 카드: 빈 더보기 숨김, 설치 후 지금 맞추기', async () => {
      const { HomeView } = await import('./js/views/home.js');
      state.web = false; state.user.role = 'director';
      state.apps = [{ id: 'notes', name: '오답노트', release: { version: '1', size: 0 } }];
      cloud.syncAll = async () => { calls.push(['sync']); return true; };
      const view = new HomeView({ cloud, store: { state }, go() {} }); mount(view);
      const card = view.cards.get('notes');
      equal(card.more.style.display, 'none');
      state.apps[0].installed = { version: '1' }; view.update(state);
      ok(card.more.style.display !== 'none');
      ok(!button('지금 맞추기', card.el)); const sync = button('지금 맞추기', view.el); ok(sync); sync.click();
      await until(() => calls.some((c) => c[0] === 'sync'));
      equal(calls[0], ['sync']);
      ok(button('열기', card.el));
    });
    await run('학원 삭제: 수를 보여 주고 두 번 확인, 어느 쪽이든 취소하면 요청 없음', async () => {
      const { AcademiesView } = await import('./js/views/academies.js');
      state.user.role = 'admin';
      cloud.api = async (m, p, b) => {
        calls.push([m, p, b]);
        if (p === '/api/academies/7/delete-preview') return { accounts: 2, students: 5, files: 30 };
        return p === '/api/academies' ? { academies: [{ id: 7, name: '시험 학원', subjects: ['math'], directors: 1, teachers: 1 }] } : { users: [] };
      };
      const view = new AcademiesView({ cloud, store: { state }, go() {} }); mount(view);
      await view.load();
      const list = view.el;
      const deletes = () => calls.filter((c) => c[0] === 'DELETE').length;
      const confirmOpen = () => topDialog();
      button('지우기', list).click(); await until(confirmOpen);
      ok(topDialog().textContent.includes('계정 2명, 학생 5명과 자료 30개를 지워요. 되돌릴 수 없어요.'));
      button('취소', topDialog()).click(); await until(() => !topDialog());
      equal(deletes(), 0);
      button('지우기', list).click(); await until(confirmOpen);
      button('삭제', topDialog()).click(); await until(() => confirmOpen() && topDialog().textContent.includes('학원을 삭제할까요?'));
      button('취소', topDialog()).click(); await until(() => !topDialog());
      equal(deletes(), 0);
      button('지우기', list).click(); await until(confirmOpen);
      button('삭제', topDialog()).click(); await until(() => confirmOpen() && topDialog().textContent.includes('학원을 삭제할까요?'));
      button('학원 삭제', topDialog()).click(); await until(() => deletes() > 0);
      equal(deletes(), 1);
    });
    await run('학원 설정: 고급은 접힘, 숨긴 값·빈 키 보존, 새 키 저장', async () => {
      const { AcademyAiView } = await import('./js/views/academy-ai.js');
      state.user.role = 'director';
      const config = { provider: 'openai', model: 'existing-model', model2: 'fallback-model', baseUrl: 'https://local.test/v1', rpm: 17, keyHint: '••••1234' };
      cloud.api = async (m, p, body) => { calls.push([m, p, body]); return { default: config, apps: {}, programs: [] }; };
      const view = new AcademyAiView({ cloud, store: { state } }); mount(view);
      await until(() => view.main.querySelector('details'));
      ok(!view.main.querySelector('details').open); ok(!view.apps.open);
      button('저장', view.main).click(); await until(() => calls.some((c) => c[0] === 'PUT'));
      equal(calls.find((c) => c[0] === 'PUT')[2], { app: '', config: { provider: 'openai', model: 'existing-model', model2: 'fallback-model', baseUrl: 'https://local.test/v1', rpm: 17 } });
      view.main.querySelector('input[type=password]').value = 'replacement-key';
      button('저장', view.main).click(); await until(() => calls.filter((c) => c[0] === 'PUT').length === 2);
      equal(calls.filter((c) => c[0] === 'PUT').at(-1)[2].config.apiKey, 'replacement-key');
    });
    await run('첫 로그인: 바깥·Esc로 로그아웃 안 함, 명시적 로그아웃만', async () => {
      state.user.role = 'teacher'; state.user.mustChangePassword = true;
      cloud.logout = async () => { calls.push(['logout']); };
      await import('./js/app.js'); await until(() => topDialog());
      const dim = topDialog().closest('.dim');
      const pw = topDialog().querySelector('input'); pw.value = '입력 중';
      dim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      pw.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick();
      equal(calls.filter((c) => c[0] === 'logout').length, 0); equal(pw.value, '입력 중');
      button('로그아웃', topDialog()).click(); await until(() => calls.some((c) => c[0] === 'logout'));
      equal(calls.filter((c) => c[0] === 'logout').length, 1);
    });
    await run('오류 코드: 다음 행동 표시, 한글 상세와 오류 코드 보존', async () => {
      const { errorText, dialog } = await import('./js/ui.js');
      ok(errorText(new Error('(account_exists)')).includes('계정 관리'));
      ok(errorText({ message: '이미 학생 계정이 있어요.', code: 'account_exists' }).includes('(account_exists)'));
      equal(errorText(new Error('학생 이름을 입력해 주세요.')), '학생 이름을 입력해 주세요.');
      ok(errorText(new Error('unknown_code')).includes('운영자'));
      dialog({ title: '오류', onOk: () => { throw new Error('(account_exists)'); } });
      button('확인', topDialog()).click(); await tick();
      ok(topDialog().querySelector('.error-text').textContent.includes('계정 관리'));
    });
    await run('학생 삭제 되돌리기: 확인·복구 요청, 학원을 바꿔도 원래 학원에 복구', async () => {
      const { StudentsView } = await import('./js/views/students.js');
      const view = Object.create(StudentsView.prototype);
      view.academy = '7'; view.purgeDays = 30; view.load = async () => {};
      view.cloud = { api: async (...args) => { calls.push(args); return true; } };
      const pending = view.remove({ id: 'student/1', name: '시험 학생' });
      equal(calls.length, 0); button('삭제', topDialog()).click(); await pending;
      equal(calls[0], ['DELETE', '/api/students/student%2F1?academy=7']);
      view.academy = '8'; button('되돌리기', document.querySelector('.toast')).click();
      await until(() => calls.length === 2);
      equal(calls[1], ['POST', '/api/students/student%2F1/restore?academy=7', {}]);
    });
    await run('PC 서버 다시 연결: 성공 후 로그인으로 복귀, 실패 시 입력 유지', async () => {
      state.web = false; state.phase = 'login'; state.user = null;
      cloud.setServer = async (url) => { state.config.serverUrl = url; onState(state); };
      await import('./js/app.js'); await until(() => document.querySelector('.server-chip'));
      document.querySelector('.server-chip').click();
      document.querySelector('input').value = 'http://127.0.0.1:8491';
      button('연결').click(); await until(() => document.querySelector('input[placeholder="아이디"]'));
      equal(document.querySelector('.server-chip').title, 'http://127.0.0.1:8491');
      document.querySelector('.server-chip').click();
      cloud.setServer = async () => { throw new Error('서버 주소를 확인해 주세요.'); };
      document.querySelector('input').value = 'http://127.0.0.1:8492';
      button('연결').click(); await until(() => document.querySelector('.error-text').textContent);
      equal(document.querySelector('input').value, 'http://127.0.0.1:8492');
      ok(document.querySelector('.error-text').textContent.includes('서버 주소'));
    });
    await run('선생님 추가: 기본 초대·본문·임시 계정 전환', async () => {
      const { PeopleView } = await import('./js/views/people.js');
      state.user.role = 'director'; state.user.allowedApps = null;
      const view = Object.create(PeopleView.prototype);
      Object.assign(view, { isAdmin: false, store: { state }, cloud, academies: [], load: async () => {} });
      cloud.api = async (...args) => { calls.push(args); return { code: 'teacher-secret', expiresAt: 1794000000000 }; };
      const pending = view.create();
      const d = topDialog();
      const username = d.querySelector('input[placeholder="영어 소문자·숫자 3자 이상"]');
      ok(username.closest('.field').style.display === 'none');
      button('아이디·임시 비밀번호', d).click(); ok(username.closest('.field').style.display !== 'none');
      button('초대 코드', d).click(); ok(username.closest('.field').style.display === 'none');
      d.querySelector('input').value = '새 선생님';
      button('만들기', d).click();
      await until(() => document.body.textContent.includes('선생님 초대 코드를 만들었어요'));
      equal(calls[0], ['POST', '/api/teacher-invites', { name: '새 선생님', allowedApps: null }]);
      ok(document.body.textContent.includes('로그인 화면의 ‘가입 코드가 있어요’에 넣으면 돼요.'));
      button('코드 복사', topDialog()).click(); await until(() => calls.some((c) => c[0] === 'copy'));
      equal(calls.find((c) => c[0] === 'copy'), ['copy', 'teacher-secret']);
      button('닫기', topDialog()).click(); await pending;
    });
    await run('선생님 목록: 초대 중·기간 지남·취소 확인·재발급', async () => {
      const { PeopleView } = await import('./js/views/people.js');
      const view = Object.create(PeopleView.prototype);
      Object.assign(view, { isAdmin: false, store: { state }, cloud, academies: [], table: document.createElement('div'), load: async () => {} });
      const i = { id: 9, name: '초대 선생님', allowedApps: [], expiresAt: 1, expired: true };
      view.invites = [i]; view.render([]); document.getElementById('root').replaceChildren(view.table);
      ok(view.table.textContent.includes('초대 중')); ok(view.table.textContent.includes('기간 지남'));
      cloud.api = async (...args) => { calls.push(args); return { code: 'renewed', expiresAt: 1794000000000 }; };
      button('관리', view.table).click(); [...document.querySelectorAll('.menu-item')].find((n) => n.textContent === '초대 취소').click(); equal(calls.length, 0);
      button('취소', topDialog()).click(); await tick(); equal(calls.length, 0);
      button('관리', view.table).click(); [...document.querySelectorAll('.menu-item')].find((n) => n.textContent === '초대 취소').click(); button('초대 취소', topDialog()).click();
      await until(() => calls.length === 1); equal(calls[0], ['DELETE', '/api/teacher-invites/9']);
      await until(() => !topDialog());
      button('관리', view.table).click(); [...document.querySelectorAll('.menu-item')].find((n) => n.textContent === '코드 다시 만들기').click(); await until(() => topDialog());
      ok(topDialog().textContent.includes('이전 코드는 더 쓸 수 없어요.')); equal(calls.length, 1);
      button('취소', topDialog()).click(); await until(() => !topDialog()); equal(calls.length, 1);
      button('관리', view.table).click(); [...document.querySelectorAll('.menu-item')].find((n) => n.textContent === '코드 다시 만들기').click(); await until(() => topDialog());
      button('다시 만들기', topDialog()).click(); await until(() => calls.length === 2);
      equal(calls[1], ['POST', '/api/teacher-invites/9/renew', {}]);
      await until(() => topDialog()?.textContent.includes('선생님 초대 코드를 만들었어요'));
      button('닫기', topDialog()).click();
    });
    await run('선생님 가입: 이름·학원 고정·signup 호출', async () => {
      state.phase = 'login'; state.user = null;
      cloud.checkCode = async () => ({ role: 'teacher', academyName: '마고학원', teacherName: '김선생' });
      cloud.signup = async (body) => { calls.push(['signup', body]); };
      await import('./js/app.js'); await until(() => button('가입 코드가 있어요'));
      button('가입 코드가 있어요').click(); document.querySelector('.auth-card input').value = 'teacher-code'; button('다음').click();
      await until(() => document.querySelector('h1').textContent === '선생님 가입');
      const inputs = document.querySelectorAll('.auth-card input');
      equal([inputs[0].value, inputs[1].value], ['마고학원', '김선생']); ok(inputs[0].disabled && inputs[1].disabled);
      ok(document.querySelector('.auth-card p').style.display === 'none');
      inputs[2].value = 'teacher1'; inputs[3].value = 'secret12'; inputs[4].value = 'wrong'; button('가입하기').click(); await tick();
      equal(calls.length, 0); inputs[4].value = 'secret12'; button('가입하기').click();
      await until(() => calls.length); equal(calls[0], ['signup', { code: 'teacher-code', username: 'teacher1', password: 'secret12' }]);
    });
    await run('역할별 메뉴 순서·학원 없는 계정·예전 주소·navigate·내 이름', async () => {
      state.user.role = 'director'; state.user.allowedApps = null;
      cloud.refreshStorage = async () => ({ apps: [], usageBytes: 0, quotaBytes: 0, academy: { usageBytes: 0, quotaBytes: 100 } });
      cloud.api = async (m,p) => {
        if (p === '/api/academies') return { academies: [{ id: 7, name: '마고', subjects: ['math'] }] };
        if (p.startsWith('/api/academy/ai/all')) return { configs: [], apps: [] };
        if (p.startsWith('/api/academy')) return { academy: { id: 7, name: '마고', code: 'mago' }, members: [] };
        return { devices: [], codes: [], students: [], users: [], invites: [], purgeDays: 30 };
      };
      history.replaceState(null, '', '#/account'); await import('./js/app.js'); await until(() => document.querySelector('#my-account'));
      equal(location.hash, '#/settings');
      const menus = () => [...document.querySelectorAll('.nav-item span')].map((n) => n.textContent);
      equal(menus(), ['프로그램','학생 명단','선생님 관리','공지사항','학원 설정','문의하기','도움말','설정']);
      onNavigate({ view: 'academy-ai' }); await until(() => document.querySelector('.title')?.textContent === '학원 설정');
      history.replaceState(null, '', '#/academy-ai'); window.dispatchEvent(new PopStateEvent('popstate')); equal(location.hash, '#/academy-settings');
      state.user.role = 'teacher'; onState(state); await tick();
      equal(menus(), ['프로그램','학생 명단','공지사항','문의하기','도움말','설정']);
      state.user.academy = null; onState(state); await tick(); equal(menus(), ['프로그램','공지사항','문의하기','도움말','설정']);
      state.user.role = 'director'; onState(state); await tick(); equal(menus(), ['프로그램','선생님 관리','공지사항','문의하기','도움말','설정']);
      state.user.role = 'admin'; onState(state); await tick();
      equal(menus(), ['프로그램','공지사항','학원','계정','학생 명단','프로그램 관리','활동 기록','서버 설정','문의','도움말','설정']);
      onNavigate({ view: 'codes' }); await until(() => document.querySelector('#signup-codes')); equal(location.hash, '#/academies');
      onNavigate({ view: 'academy-ai' }); equal(location.hash, '#/academies');
      document.querySelector('.me-chip').click(); await until(() => document.querySelector('#my-account')); equal(location.hash, '#/settings');
      history.replaceState(null, '', '#/account'); window.dispatchEvent(new PopStateEvent('popstate')); equal(location.hash, '#/settings');
      ok(button('아이디 바꾸기', document.querySelector('#my-account'))); button('아이디 바꾸기', document.querySelector('#my-account')).click();
      ok(topDialog().querySelector('input[type=password]')); button('닫기', topDialog()).click();
    });
    await run('학원 설정: 원장·운영자 칸과 학원 선택·가입 코드 통합', async () => {
      const { AcademySettingsView, AcademiesView } = await import('./js/views/academies.js');
      const academy = { id: 7, name: '시험학원', subjects: ['math'], directors: 1, teachers: 2, usageBytes: 2, quotaBytes: 100 };
      cloud.refreshStorage = async () => ({ academy });
      cloud.api = async (m,p,b) => { calls.push([m,p,b]);
        if (p === '/api/academies') return { academies: [academy] };
        if (p === '/api/codes') return { codes: [{ id: 1, code: 'JOIN-CODE', state: 'active', subjects: ['math'], uses: 0, maxUses: 1 }] };
        if (p.startsWith('/api/academy/ai/all')) return { defaults: null, apps: [] };
        return { academy };
      };
      for (const role of ['director','admin']) {
        state.user.role = role; state.user.academy = academy;
        const view = new AcademySettingsView({ cloud, store: { state }, go() {}, opts: { academy: 7 } }); mount(view);
        await until(() => view.el.textContent.includes('학원 정보'));
        ok(view.el.textContent.includes('학원 공간')); ok(view.el.textContent.includes('학원 AI'));
        await until(() => view.ai.main.querySelector('.academy-ai-sub'));
        ok(view.ai.el.matches('section.card'));
        equal(view.ai.el.querySelector('h2.card-title').textContent, '학원 AI');
        equal(view.ai.el.querySelectorAll('.card, .page-head, h1, .subtitle').length, 0);
        equal(view.ai.main.querySelector('h3').textContent, '기본 설정정하지 않음');
        ok(view.ai.apps.matches('details:not([open])'));
        equal(view.ai.apps.querySelector('summary').textContent, '고급: 프로그램별 설정');
        const { ic } = await import('./js/ui.js');
        const space = [...view.el.querySelectorAll('h2')].find((h) => h.textContent === '학원 공간');
        equal(space.querySelector('svg').innerHTML, ic('drive', 18).innerHTML);
        let scrolled = false;
        view.ai.el.scrollIntoView = () => { scrolled = true; };
        view.onNav({ section: 'academy-ai' }); ok(scrolled);
        equal(!!button('용량 바꾸기', view.el), role === 'admin'); equal(!!button('학원 지우기', view.el), role === 'admin');
        if (role === 'admin') ok(view.el.querySelector('.title').textContent.includes('시험학원'));
        else ok(view.el.textContent.includes('과목 변경은 운영자에게 문의하세요.'));
      }
      const { AcademyAiView } = await import('./js/views/academy-ai.js');
      const pickerView = new AcademyAiView({ cloud, store: { state } }); mount(pickerView);
      await until(() => pickerView.main.querySelector('h3'));
      equal(pickerView.picker.el.value, '7');
      ok(!pickerView.picker.el.disabled);
      pickerView.picker.el.dispatchEvent(new Event('change'));
      await tick();
      ok(calls.some((c) => c[1] === '/api/academy/ai/all?academy=7'));
      let target;
      const view = new AcademiesView({ cloud, store: { state }, go: (...args) => { target = args; } }); mount(view);
      await until(() => view.table.querySelector('tbody')); await until(() => view.codes.table.textContent.includes('JOIN-CODE'));
      button('학원 설정', view.el).click(); equal(target, ['academy-settings', { academy: 7, force: true }]);
      ok(button('가입 코드 만들기', view.el)); ok(button('학원 추가', view.el));
    });
    await run('정보 고치기: 바뀐 이름·아이디·프로그램만 기존 PATCH', async () => {
      const { PeopleView } = await import('./js/views/people.js'); state.user.allowedApps = null;
      const view = Object.create(PeopleView.prototype); Object.assign(view, { cloud, store: { state }, load() {} });
      const user = { id: 9, name: '선생님', username: 'teacher', allowedApps: null };
      cloud.api = async (...args) => { calls.push(args); };
      let pending = view.editInfo(user); topDialog().querySelector('input').value = '새이름'; button('저장', topDialog()).click(); await pending;
      equal(calls[0], ['PATCH','/api/users/9',{ name: '새이름' }]);
      pending = view.editInfo(user); topDialog().querySelectorAll('input')[1].value = 'newteacher'; button('저장', topDialog()).click(); await pending;
      equal(calls[1], ['PATCH','/api/users/9',{ username: 'newteacher' }]);
      pending = view.editInfo(user); topDialog().querySelector('.toggle').click(); button('저장', topDialog()).click(); await pending;
      equal(calls[2], ['PATCH','/api/users/9',{ allowedApps: [] }]);
      pending = view.editInfo(user); button('저장', topDialog()).click(); await tick(); equal(calls.length, 3); button('취소', topDialog()).click(); await pending;
    });
    await run('학생 정보: 초대·직접 계정·삭제 뒤 계정 칸 갱신·기본 입력 유지', async () => {
      const { StudentsView } = await import('./js/views/students.js'); state.user.role = 'director';
      let student = { id: 's1', name: '학생', rev: 1, updatedAt: 1, updatedBy: { name: '원장' }, account: null };
      cloud.api = async (m,p,b) => { calls.push([m,p,b]);
        if (p === '/api/students') return { students: [{ ...student }], purgeDays: 30 };
        if (p === '/api/academy/members') return { members: [] };
        if (p.endsWith('/invite')) { student = { ...student, name: '다른 사람이 수정', rev: 2 }; return { code: 'INVITE', expiresAt: Date.now()+10000 }; }
        if (m === 'PATCH' && p === '/api/students/s1') return { student: { ...student, ...b } };
        if (p.endsWith('/account')) { if (m === 'DELETE') student.account = null; else student.account = { username: b.username, status: 'active', aiMode: 'academy' }; return { account: student.account }; }
        return {};
      };
      const view = new StudentsView({ cloud, store: { state } }); mount(view); await until(() => view.loaded);
      const pending = view.edit(view.students[0]); await until(() => topDialog()); const outer = topDialog();
      outer.querySelector('input').value = '입력중';
      button('초대 코드 만들기', outer).click(); button('만들기', topDialog()).click(); await until(() => topDialog().textContent.includes('학생 초대 코드를 만들었어요'));
      button('닫기', topDialog()).click(); await until(() => button('초대 코드 취소', outer)); equal(outer.querySelector('input').value, '입력중');
      button('아이디·임시 비밀번호로 만들기', outer).click(); topDialog().querySelector('input').value = 'newstudent'; topDialog().querySelector('input[type=password]').value = 'secret12';
      button('직접 만들기', topDialog()).click(); await until(() => button('계정 지우기', outer)); equal(outer.querySelector('input').value, '입력중');
      button('계정 지우기', outer).click(); button('계정 지우기', topDialog()).click(); await until(() => button('초대 코드 만들기', outer));
      equal(outer.querySelector('input').value, '입력중'); ok(outer.textContent.includes('고친 사람: 원장'));
      button('저장', outer).click(); await pending;
      equal(calls.find((c) => c[0] === 'PATCH' && c[1] === '/api/students/s1')[2], { name: '입력중', baseRev: 1 });
      equal(calls.filter((c) => ['POST','DELETE'].includes(c[0])).map((c) => [c[0],c[1]]), [['POST','/api/students/s1/invite'],['POST','/api/students/s1/account'],['DELETE','/api/students/s1/account']]);
    });
    await run('예전 데이터 메뉴: 없음·있음·이미 가져옴·다시 묻지 않음', async () => {
      const { HomeView } = await import('./js/views/home.js'); state.web = false;
      const app = { id: 'notes', name: '오답노트', installed: { version: '1' }, platform: 'windows' }; state.apps = [app];
      let found = []; cloud.legacyDetect = async () => found;
      const view = new HomeView({ cloud, store: { state }, go() {} }); mount(view); const card = view.cards.get('notes');
      for (const entry of [null, { id: 'old' }, { id: 'old', importedHere: true, importedBy: '원장' }, { id: 'old', dismissed: true }]) {
        found = entry ? [entry] : []; await view.openMenu(card.more, app);
        equal([...document.querySelectorAll('.menu-item')].some((n) => n.textContent === '예전 데이터 가져오기'), !!entry);
        document.body.click();
      }
      equal([...view.el.querySelectorAll('button')].filter((b) => b.textContent === '지금 맞추기').length, 1);
    });
    win.setSize(700, 900);
    await run('모바일 메뉴: 예전 주소 이동·뒤로 가기·서랍 닫기', async () => {
      state.user.role = 'director';
      cloud.refreshStorage = async () => ({ apps: [], usageBytes: 0, quotaBytes: 0 });
      cloud.api = async () => ({ devices: [] });
      await import('./js/app.js'); await until(() => document.querySelector('.shell'));
      const open = document.querySelector('.topbar button'); open.click();
      equal(open.getAttribute('aria-expanded'), 'true'); ok(history.state.mobileNav);
      document.querySelector('.me-chip').click();
      await until(() => location.hash === '#/settings' && !document.querySelector('.shell').classList.contains('nav-open'));
      ok(document.querySelector('#my-account'));
      history.back(); await until(() => location.hash === '#/home');
      open.click(); await until(() => history.state?.mobileNav); history.back();
      await until(() => !document.querySelector('.shell').classList.contains('nav-open'));
      equal(location.hash, '#/home');
      history.replaceState(null, '', '#/account'); window.dispatchEvent(new HashChangeEvent('hashchange'));
      await until(() => location.hash === '#/settings'); ok(document.querySelector('#my-account'));
    });
    win.setSize(1360, 1000);
    await run('새로 고침 진입: 운영자 학원 설정의 선택 학원 보존', async () => {
      state.user.role = 'admin';
      cloud.api = async (m,p) => {
        if (p === '/api/academies') return { academies: [{ id: 8, name: '둘째학원', subjects: ['english'] }] };
        if (p.startsWith('/api/academy/ai/all')) return { defaults: null, apps: [] };
        return { academy: { id: 8, code: 'second' } };
      };
      history.replaceState(null, '', '#/academy-settings?academy=8');
      await import('./js/app.js'); await until(() => document.querySelector('.title')?.textContent.includes('둘째학원'));
      equal(location.hash, '#/academy-settings?academy=8');
    });
    win.setSize(375, 900);
    for (const role of ['student', 'director', 'admin']) {
      await run(`문의 화면: ${role} 메뉴·사진·대화·배지·375px`, async () => {
        const role = state.user.role;
        state.user.role = role;
        state.unreadInquiries = 2;
        let made = false;
        let closed = false;
        let liveReply = false;
        const inquiry = () => ({ id: 12, title: '시험 문의', status: closed ? 'closed' : 'open', lastMessageAt: Date.now(), unread: true, senderName: '학생', role: 'student', academyName: '시험학원', client: '웹' });
        cloud.inquiryPhotoUpload = async () => ({ photo: { id: 'a'.repeat(48) } });
        cloud.inquiryPhotoGet = async () => ({ bytes: new Uint8Array([137,80,78,71]), mime: 'image/png' });
        cloud.api = async (m, p, b) => {
          calls.push([m, p, b]);
          if (p === '/api/inquiries' && m === 'POST') { made = true; return { inquiry: inquiry() }; }
          if (p.startsWith('/api/inquiries') && p.endsWith('/close')) { closed = true; return {}; }
          if (p === '/api/inquiries/12') return { inquiry: inquiry(), messages: [{ id: 1, body: '시험 내용', fromAdmin: false, createdAt: Date.now(), photoIds: [] }, ...(liveReply ? [{ id: 2, body: '운영자 실시간 답변', fromAdmin: true, createdAt: Date.now(), photoIds: [] }] : [])] };
          if (p.startsWith('/api/inquiries')) return { inquiries: made || role === 'admin' ? [inquiry()] : [] };
          if (p === '/api/me/notes') return [];
          return { apps: [], notices: [], members: [] };
        };
        history.replaceState(null, '', '#/inquiries');
        await import('./js/app.js');
        await until(() => document.querySelector('.inquiries'));
        const menu = document.querySelector('[data-id="inquiries"]');
        ok(menu.textContent.includes(role === 'admin' ? '문의' : '문의하기'));
        ok(menu.nextElementSibling.textContent.includes('도움말'));
        equal(menu.querySelector('.badge-num')?.textContent, '2');
        ok([...document.querySelectorAll('.topbar button')].some((b) => b.style.display !== 'none' && b.querySelector('.badge-num')?.textContent === '2'), '휴대폰 위 막대에도 새 글 숫자');
        const page = document.querySelector('.inquiries');
        if (role === 'admin') {
          // 운영자는 받는 쪽: 새 문의 단추 없이 목록에서 연다
          await until(() => button('#12 · 시험 문의', page));
          ok(!button('새 문의'), '운영자 화면에는 새 문의 단추가 없음');
          button('#12 · 시험 문의', page).click(); await until(() => page.textContent.includes('시험 내용'));
        } else {
          button('새 문의').click();
          page.querySelector('input:not([type=file])').value = '시험 문의'; page.querySelector('textarea').value = '시험 내용';
          const picker = page.querySelector('input[type=file]');
          const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='), c => c.charCodeAt(0))], 'test.png', { type: 'image/png' })); picker.files = data.files; picker.dispatchEvent(new Event('change'));
          await until(() => page.querySelector('.inquiry-thumb'));
          button('보내기', page).click(); await until(() => page.textContent.includes('시험 내용') && !page.querySelector('input:not([type=file])'));
          ok(calls.some(c => c[0] === 'POST' && c[1] === '/api/inquiries' && c[2].photoIds.length === 1));
        }
        page.querySelector('textarea').value = '쓰던 답글';
        liveReply = true;
        state.inquiryStamp = 1; onState(state);
        await until(() => page.textContent.includes('운영자 실시간 답변'));
        equal(page.querySelector('textarea').value, '쓰던 답글');
        if (role === 'admin') {
          button('끝내기', page).click(); await until(() => button('다시 열기', page));
          button('목록', page).click(); await until(() => button('전체', page));
          button('접수됨', page).click(); await until(() => calls.some(c => c[1] === '/api/inquiries?status=open'));
        }
        ok(document.documentElement.scrollWidth <= innerWidth, '375px 가로 넘침 없음');
      }, role);
    }
    console.log('STUDENT_TESTS=' + JSON.stringify(results));
    win.destroy();
    app.exit(results.some((r) => r.error) ? 1 : 0);
  }).catch((e) => { console.error(e); app.exit(1); });
}

function setup() {
  window.calls = [];
  window.state = { phase: 'ready', web: true, online: true, version: '1', config: { serverUrl: 'https://local.test' }, apps: [], notices: [], unreadNotices: 0, inquiryStamp: 0, user: { id: 1, role: 'student', name: '김학생', username: 'student1', academy: { id: 7, name: '마고' }, student: { id: 's1', teacherName: '이선생' }, aiMode: 'academy' } };
  window.cloud = {
    getState: async () => state, onState: (fn) => { window.onState = fn; }, onToast() {}, onNavigate(fn) { window.onNavigate = fn; },
    inquiryViewing: async () => {}, inquiryRefresh: async () => {},
    api: async (m, p, b) => { calls.push([m, p, b]); if (p === '/api/me/notes') return []; throw new Error('허용하지 않은 요청: ' + p); },
    changeUsername: async (u, p) => { calls.push(['username', u, p]); return { username: u }; },
    changePassword: async (...args) => { calls.push(['password', ...args]); },
    copy: async (text) => { calls.push(['copy', text]); }, openExternal: async (url) => { calls.push(['external', url]); }, logout: async () => {},
  };
  window.tick = () => new Promise((r) => setTimeout(r, 30));
  window.until = async (fn) => { const end = Date.now() + 2500; while (!fn()) { if (Date.now() > end) throw new Error('조건을 기다리는 시간이 지났어요: ' + fn.toString()); await tick(); } };
  window.ok = (value, message = '조건이 맞지 않아요') => { if (!value) throw new Error(message); };
  window.equal = (actual, expected) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected })); };
  window.button = (label, root = document) => [...root.querySelectorAll('button')].find((b) => b.textContent === label);
  window.topDialog = () => [...document.querySelectorAll('.dim:not(.out) .dialog')].at(-1);
  window.mount = (view) => document.getElementById('root').replaceChildren(view.el);
  window.studentsPage = async ({ role = 'director', code = 'mago', bulkCodeRequired = false, accountError = '' } = {}) => {
    const { StudentsView } = await import('./js/views/students.js');
    state.user.role = role;
    const students = [];
    cloud.api = async (m, p, b) => {
      calls.push([m, p, b]);
      const route = p.split('?')[0];
      if (route === '/api/academies') return { academies: [{ id: 7, name: '마고' }] };
      if (route === '/api/academy') { if (m === 'PATCH') code = b.code; return { academy: { code } }; }
      if (route === '/api/academy/members') return { members: [] };
      if (route === '/api/students') {
        if (m === 'GET') return { students: [...students], purgeDays: 30 };
        const student = { ...b, id: 'new/student', rev: 1 }; students.push(student); return { student };
      }
      if (accountError) throw new Error(accountError);
      if (route === '/api/students/new%2Fstudent/invite') return { code: 'invite/new', expiresAt: 1794000000000 };
      if (route === '/api/students/accounts/bulk') {
        if (bulkCodeRequired) { bulkCodeRequired = false; throw Object.assign(new Error('학원 코드가 없어요'), { code: 'academy_code_required', status: 400 }); }
        return { created: [{ studentId: 'new/student', name: '새학생', username: `${code}2611001`, password: 'temporary-once' }], skipped: [] };
      }
      throw new Error('허용하지 않은 요청: ' + p);
    };
    const view = new StudentsView({ cloud, store: { state } }); mount(view); await until(() => view.loaded); return view;
  };
  window.addStudent = (view, mode = '나중에') => {
    const pending = view.edit(null);
    const choice = button(mode, topDialog()); ok(choice, '학생 추가에서 계정 방식을 고를 수 있어요'); choice.click();
    topDialog().querySelector('input').value = '새학생';
    return { pending };
  };
}
