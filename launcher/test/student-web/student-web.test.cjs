'use strict';

const path = require('node:path');

if (!process.versions.electron) {
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const { spawn } = require('node:child_process');
  test('학생 웹 화면: 실제 렌더러와 API 약속', async (t) => {
    const profile = fs.mkdtempSync(path.join(__dirname, '.student-ui-'));
    t.after(() => {
      const target = path.resolve(profile);
      assert.equal(path.dirname(target), __dirname);
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
    const run = async (name, fn) => {
      try {
        await win.loadFile(path.join(__dirname, 'renderer.html'));
        await win.webContents.executeJavaScript(`(${setup.toString()})()`);
        await win.webContents.executeJavaScript(`(${fn.toString()})()`);
        results.push({ name, error: null });
      } catch (e) { results.push({ name, error: e.stack || e.message }); }
    };
    await run('학생 메뉴 네 개·막힌 해시·임시 비밀번호 강제·변경 뒤 복귀', async () => {
      state.user.mustChangePassword = true;
      history.replaceState(null, '', '#/students');
      await import('./js/app.js');
      await until(() => document.querySelector('.nav'));
      equal([...document.querySelectorAll('.nav-item span')].map((n) => n.textContent), ['내 오답노트', '마고 과목내비', '내 계정', '도움말']);
      ok(document.querySelector('.page').textContent.includes('새 비밀번호를 정해 주세요'));
      ok(!calls.length, '비밀번호 변경 전에는 목록을 요청하지 않아요');
      document.querySelector('[data-id="my-notes"]').click();
      ok(document.querySelector('.page').textContent.includes('새 비밀번호를 정해 주세요'));
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
      ok(document.querySelector('.page').textContent.includes('새 비밀번호를 정해 주세요'));
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
      ok(document.body.textContent.includes('학생 계정은 인터넷 브라우저에서 https://local.test 에 들어가서 써요.'));
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
          equal(help.title, '사용 설명서를 브라우저에서 열어요');
          equal(help.querySelectorAll('svg').length, 2);
          ok(help.querySelector('circle'));
          if (role === 'student') equal(help.previousElementSibling.dataset.id, 'account');
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
      await until(() => button('처음이세요? 사용 설명서 보기'));
      for (const web of [true, false]) {
        state.web = web;
        for (const [config, base] of [
          [{ serverUrl: 'https://school.test/', defaultServerUrl: 'https://default.test' }, 'https://school.test'],
          [{ serverUrl: '', defaultServerUrl: 'https://default.test/' }, 'https://default.test'],
          [{ serverUrl: '', defaultServerUrl: '' }, 'https://mago.milky.kr'],
        ]) {
          state.config = config;
          button('처음이세요? 사용 설명서 보기').click();
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
        "선생님: 원장님께 '비밀번호 초기화'를 부탁해 주세요.",
        '원장님: 운영자에게 연락해 주세요.',
        '학생: 담당 선생님께 말해 주세요. 선생님이 학생 명단에서 새 비밀번호를 만들어 드려요.',
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
      ok(view.el.textContent.includes('꺼짐') && view.el.textContent.includes('비밀번호 바꿔야 해요'));
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
      ok(!view.bulk.disabled); equal(view.bulk.textContent, '계정 일괄 생성'); equal(view.selected.size, 0);
    });
    await run('일괄 생성: 고른 학생이 없으면 목록의 계정 없는 학생 모두, 만들 학생이 없으면 이유를 알림', async () => {
      const { StudentsView } = await import('./js/views/students.js');
      state.user.role = 'director';
      let list = [];
      cloud.api = async (m, p, b) => {
        calls.push([m, p, b]);
        if (p === '/api/academy') return { code: 'mago' };
        if (p === '/api/academy/members') return { members: [] };
        if (p === '/api/students') return { students: list, purgeDays: 30 };
        return { created: [], skipped: [] };
      };
      const view = new StudentsView({ cloud, store: { state } }); mount(view); await until(() => view.loaded);
      ok(!view.bulk.disabled, '학생이 없어도 버튼은 눌려요');
      calls.length = 0;
      view.bulk.click(); await until(() => document.body.textContent.includes('‘학생 추가’로 학생을 먼저 넣어 주세요'));
      ok(!calls.some((c) => c[1] === '/api/academy'), '만들 학생이 없으면 서버에 묻지 않아요');
      list = [{ id: 's1', name: '김학생', account: { username: 'mago2611001' } }, { id: 's2', name: '이학생', grade: '고1' }, { id: 's3', name: '박학생', grade: '고2' }, { id: 's4', name: '최학생', deletedAt: 1 }];
      await view.load(); await until(() => view.table.querySelector('tbody'));
      view.bulk.click(); await until(() => topDialog()?.textContent.includes('계정이 없는 학생 2명의 계정을 만들까요?'));
      button('일괄 생성', topDialog()).click(); await until(() => calls.some((c) => c[0] === 'POST'));
      equal(calls.find((c) => c[0] === 'POST'), ['POST', '/api/students/accounts/bulk', { studentIds: ['s2', 's3'] }]);
      await until(() => topDialog()?.textContent.includes('새로 만든 계정이 없어요')); button('닫기', topDialog()).click();
      await until(() => !view.bulk.querySelector('.spinner'));
      calls.length = 0;
      view.gradeSel.value = '고2'; view.gradeSel.dispatchEvent(new Event('change'));
      const pending = view.bulkAccounts(); await until(() => topDialog()?.textContent.includes('계정이 없는 학생 1명의'));
      button('취소', topDialog()).click(); await pending;
      list = list.map((s) => (s.deletedAt ? s : { ...s, account: { username: 'x' } }));
      await view.load(); calls.length = 0;
      await view.bulkAccounts(); ok(document.body.textContent.includes('지금 목록의 학생은 모두 계정이 있어요'));
      ok(!calls.some((c) => c[0] === 'POST'));
      button('삭제한 학생').click(); await tick();
      equal(view.bulk.style.display, 'none');
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
      ok(button('학원 코드 mago', view.el.querySelector('.page-head')));
      code = null; view.role = 'teacher'; await view.bulkAccounts();
      ok(document.body.textContent.includes('원장님께 학원 코드 설정을 부탁'));
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
      await until(() => topDialog()?.textContent.includes('지금 한 번만 보여요'));
      button('가입 주소 복사', topDialog()).click(); button('코드 복사', topDialog()).click(); await tick();
      ok(calls.some((c) => c[0] === 'copy' && c[1] === 'https://local.test/#/join?code=invite%2Fone'));
      ok(topDialog().textContent.includes('까지 한 번'));
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
    await run('학생 명단 학원 코드: 원장 표시·저장·선생님 숨김·선생님 관리에서 제거', async () => {
      const view = await studentsPage();
      const head = view.el.querySelector('.page-head');
      ok(button('학원 코드 mago', head)); button('학원 코드 mago', head).click();
      await until(() => topDialog()?.textContent.includes('학원 코드 정하기'));
      topDialog().querySelector('input').value = 'newmago'; button('저장', topDialog()).click();
      await until(() => button('학원 코드 newmago', head));
      const teacher = await studentsPage({ role: 'teacher' });
      ok(!teacher.el.querySelector('.page-head').textContent.includes('학원 코드'));
      state.user.role = 'director';
      cloud.api = async (m, p) => p === '/api/academies' ? { academies: [] } : { users: [] };
      const { PeopleView } = await import('./js/views/people.js');
      const people = new PeopleView({ cloud, store: { state } }); mount(people);
      ok(!people.el.querySelector('.page-head').textContent.includes('학원 코드'));
      ok(button('학원 이름 바꾸기', people.el.querySelector('.page-head')));
    });
    await run('운영자 학원 코드: 선택 전 비활성·학원 전환·선택 학원에 저장', async () => {
      const { StudentsView } = await import('./js/views/students.js');
      state.user.role = 'admin';
      const codes = { 7: 'mago', 8: null }; let academies;
      cloud.api = async (m, p, b) => {
        calls.push([m, p, b]);
        if (p === '/api/academies') return new Promise((resolve) => { academies = resolve; });
        const id = new URL(p, 'https://local.test').searchParams.get('academy');
        if (p.startsWith('/api/academy?')) { if (m === 'PATCH') codes[id] = b.code; return { academy: { code: codes[id] } }; }
        if (p.startsWith('/api/academy/members')) return { members: [] };
        return { students: [], purgeDays: 30 };
      };
      const view = new StudentsView({ cloud, store: { state } }); mount(view);
      const head = view.el.querySelector('.page-head');
      const control = [...head.querySelectorAll('button')].find((b) => b.textContent.startsWith('학원 코드'));
      ok(control?.disabled || control?.hidden, '학원을 고르기 전에는 쓸 수 없어요');
      academies({ academies: [{ id: 7, name: '마고' }, { id: 8, name: '다음학원' }] });
      await until(() => button('학원 코드 mago', head));
      view.picker.el.value = '8'; view.picker.el.dispatchEvent(new Event('change'));
      await until(() => button('학원 코드 정하기', head) && !control.disabled);
      control.click(); await until(() => topDialog());
      topDialog().querySelector('input').value = 'next'; button('저장', topDialog()).click();
      await until(() => button('학원 코드 next', head));
      ok(calls.some((c) => c[0] === 'PATCH' && c[1] === '/api/academy?academy=8' && c[2].code === 'next'));
      ok(!calls.some((c) => c[1] === '/api/academy'));
    });
    await run('학생 추가: 나중에 기본값·추가 POST만·고치기에는 계정 선택 없음', async () => {
      const view = await studentsPage();
      const { pending } = addStudent(view);
      equal(topDialog().querySelector('.seg .on').textContent, '나중에');
      ok(topDialog().textContent.includes('명단에서 ‘계정 만들기’'));
      button('추가', topDialog()).click(); await pending;
      equal(calls.filter((c) => c[0] === 'POST').map((c) => c[1]), ['/api/students']);
      await until(() => view.students.length === 1);
      const editing = view.edit(view.students[0]);
      ok(!topDialog().querySelector('.seg')); button('취소', topDialog()).click(); await editing;
    });
    await run('학생 추가: 초대 코드·새 ID로 발급·공유 결과창·복사', async () => {
      const view = await studentsPage({ role: 'admin' });
      const { pending } = addStudent(view, '초대 코드');
      ok(topDialog().textContent.includes('7일 안에 직접 아이디·비밀번호를 정해요'));
      button('추가', topDialog()).click();
      await until(() => topDialog()?.textContent.includes('학생 초대 코드를 만들었어요'));
      equal(calls.filter((c) => c[0] === 'POST').map((c) => c[1]), ['/api/students?academy=7', '/api/students/new%2Fstudent/invite?academy=7']);
      equal(document.querySelectorAll('.dim:not(.out) .dialog').length, 1);
      ok(topDialog().textContent.includes('invite/new') && topDialog().textContent.includes('까지 한 번'));
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
      ok(topDialog().textContent.includes('처음 로그인할 때 바꿔야 해요'));
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
      ok(button('학원 코드 newmago', view.el.querySelector('.page-head')));
      equal(calls.find((c) => c[0] === 'POST' && c[1].includes('/bulk'))[2], { studentIds: ['new/student'] });
      button('닫기', topDialog()).click(); await pending;
    });
    await run('학생 추가 임시 계정: 코드 없는 선생님은 안내·학생 유지·계정 POST 없음', async () => {
      const view = await studentsPage({ role: 'teacher', code: null });
      const { pending } = addStudent(view, '아이디·임시 비밀번호'); button('추가', topDialog()).click(); await pending;
      ok(document.body.textContent.includes('학생은 추가했어요. 계정은 만들지 못했어요:'));
      ok(document.body.textContent.includes('원장님께 학원 코드 설정을 부탁'));
      ok(document.body.textContent.includes('‘계정 만들기’'));
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
    await run('계약 과목: 원장·선생님 프로필과 실시간 갱신, 운영자·학생은 숨김', async () => {
      const { AccountView } = await import('./js/views/account.js');
      cloud.refreshStorage = async () => ({ apps: [], usageBytes: 0, quotaBytes: 0 });
      cloud.api = async () => ({ devices: [] });
      for (const role of ['director', 'teacher', 'admin', 'student']) {
        state.user = { ...state.user, role, academy: { id: 7, name: '마고', subjects: ['math', 'english'] } };
        const view = new AccountView({ cloud, store: { state } }); mount(view);
        if (['director', 'teacher'].includes(role)) {
          equal([...view.profile.querySelectorAll('.pill')].slice(1).map((p) => p.textContent), ['수학', '영어']);
          ok(view.profile.textContent.includes('과목을 늘리거나 바꾸려면 운영자에게 문의해 주세요.'));
          equal(view.profile.querySelectorAll('input[type=checkbox]').length, 0);
          state.user = { ...state.user, academy: { ...state.user.academy, name: '바뀐 학원', subjects: [] } };
          view.update(state);
          ok(view.profile.textContent.includes('바뀐 학원') && view.profile.textContent.includes('계약한 과목 없음'));
          equal(view.profile.querySelectorAll('.pill').length, 1);
          state.user = { ...state.user, academy: { ...state.user.academy, subjects: ['korean'] } };
          view.update(state);
          equal([...view.profile.querySelectorAll('.pill')].slice(1).map((p) => p.textContent), ['국어']);
        } else ok(!view.profile.textContent.includes('계약 과목'));
      }
    });
    await run('학원 관리: 과목 저장·빈 과목 재확인·취소·새 학원 과목', async () => {
      const { PeopleView } = await import('./js/views/people.js');
      state.user.role = 'admin';
      let academy = { id: 7, name: '마고', subjects: ['math'], directors: 1, teachers: 0, usageBytes: 0, quotaBytes: 0 };
      cloud.api = async (m, p, b) => {
        calls.push([m, p, b]);
        if (m === 'GET' && p === '/api/academies') return { academies: [academy] };
        if (m === 'PATCH') { academy = { ...academy, ...b }; return { academy }; }
        if (m === 'POST') return { academy: { id: 8, ...b } };
        return { users: [] };
      };
      const view = new PeopleView({ cloud, store: { state } }); mount(view); await until(() => view.academies.length);
      const pending = view.manageAcademies(); await until(() => topDialog());
      ok(topDialog().textContent.includes('과목: 수학'));
      button('과목', topDialog()).click();
      equal(topDialog().querySelector('.dialog-title').textContent, '마고 계약 과목');
      ok(topDialog().textContent.includes('과목을 빼도 이미 올린 교재는 볼 수 있어요.'));
      equal([...topDialog().querySelectorAll('.check')].map((c) => c.textContent), ['수학', '영어', '국어']);
      equal([...topDialog().querySelectorAll('input')].map((c) => c.checked), [true, false, false]);
      topDialog().querySelectorAll('input')[1].click(); button('저장', topDialog()).click();
      await until(() => topDialog()?.querySelector('.dialog-title').textContent === '학원 관리');
      await until(() => topDialog().textContent.includes('과목: 수학 · 영어'));
      equal(calls.find((c) => c[0] === 'PATCH'), ['PATCH', '/api/academies/7', { subjects: ['math', 'english'] }]);
      button('과목', topDialog()).click();
      for (const input of topDialog().querySelectorAll('input:checked')) input.click();
      button('저장', topDialog()).click(); await until(() => topDialog()?.textContent.includes('그래도 저장할까요?'));
      button('취소', topDialog()).click(); await tick();
      equal(calls.filter((c) => c[0] === 'PATCH').length, 1);
      equal(topDialog().querySelector('.dialog-title').textContent, '마고 계약 과목');
      button('저장', topDialog()).click(); await until(() => topDialog()?.textContent.includes('그래도 저장할까요?'));
      button('저장', topDialog()).click();
      await until(() => topDialog()?.querySelector('.dialog-title').textContent === '학원 관리');
      await until(() => topDialog().textContent.includes('계약한 과목 없음'));
      equal(calls.filter((c) => c[0] === 'PATCH').at(-1)[2], { subjects: [] });
      const inputs = topDialog().querySelectorAll('input[type=checkbox]');
      equal([...inputs].map((c) => c.checked), [true, false, false]);
      inputs[2].click();
      topDialog().querySelector('input[placeholder="새 학원 이름"]').value = '새 학원';
      button('추가', topDialog()).click(); await until(() => calls.some((c) => c[0] === 'POST'));
      equal(calls.find((c) => c[0] === 'POST'), ['POST', '/api/academies', { name: '새 학원', subjects: ['math', 'korean'] }]);
      button('닫기', topDialog()).click(); await pending;
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
    console.log('STUDENT_TESTS=' + JSON.stringify(results));
    win.destroy();
    app.exit(results.some((r) => r.error) ? 1 : 0);
  }).catch((e) => { console.error(e); app.exit(1); });
}

function setup() {
  window.calls = [];
  window.state = { phase: 'ready', web: true, online: true, version: '1', config: { serverUrl: 'https://local.test' }, apps: [], notices: [], unreadNotices: 0, user: { id: 1, role: 'student', name: '김학생', username: 'student1', academy: { id: 7, name: '마고' }, student: { id: 's1', teacherName: '이선생' }, aiMode: 'academy' } };
  window.cloud = {
    getState: async () => state, onState: (fn) => { window.onState = fn; }, onToast() {}, onNavigate() {},
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
