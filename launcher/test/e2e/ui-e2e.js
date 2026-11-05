'use strict';

// 통합 클라우드 화면 전체 흐름 (실제 서버 + Electron)
//   node test/e2e/ui-e2e.js → OS 임시 폴더/magoedu-ui-out/*.png (화면 없는 Linux는 xvfb-run 사용)
const assert = require('node:assert/strict');
const { startAll } = require('./harness');

(async () => {
  const t = await startAll();
  const { page } = t;
  const btn = (name) => page.getByRole('button', { name, exact: true });
  const step = (m) => console.log(`- ${m}`);
  try {
    // 1) 서버 연결
    await page.locator('.server-chip').click();
    await page.getByPlaceholder('예: http://192.168.0.10:8470').fill(t.server.base);
    await t.shot('01-server');
    await btn('연결').click();
    await page.getByPlaceholder('아이디').waitFor();
    step('서버 연결');

    // 2) 운영자 로그인 → 첫 비밀번호 바꾸기
    await page.getByPlaceholder('아이디').fill('admin');
    await page.getByPlaceholder('비밀번호', { exact: true }).fill(t.ADMIN_PASSWORD);
    await t.shot('02-login');
    await btn('로그인').click();
    await page.getByText('프로그램', { exact: true }).first().waitFor();
    step('운영자 로그인');

    // 3) 프로그램 화면
    await page.locator('.app-card').nth(1).waitFor();
    await t.shot('03-home-admin');
    // 설치
    await page.locator('.app-card').filter({ hasText: '오답노트' }).getByRole('button', { name: '설치' }).click();
    await page.locator('.app-card').filter({ hasText: '오답노트' }).getByRole('button', { name: '열기' }).waitFor({ timeout: 20000 });
    await page.locator('.app-card').filter({ hasText: '오답노트' }).getByRole('button', { name: '지금 맞추기', exact: true }).click();
    await page.getByText('서버와 맞추기를 마쳤어요', { exact: true }).waitFor();
    await t.shot('04-installed');
    step('설치');
    await page.locator('.app-card').filter({ hasText: '오답노트' }).getByRole('button', { name: '열기' }).click();
    await page.locator('.app-card').filter({ hasText: '오답노트' }).getByText('실행 중').waitFor({ timeout: 20000 });
    await t.shot('05-running');
    step('실행');
    await page.locator('.app-card').filter({ hasText: '오답노트' }).getByText('서버와 맞춤').waitFor({ timeout: 20000 });
    await page.locator('.app-card').filter({ hasText: '오답노트' }).locator('button[title="더 보기"]').click();
    await t.shot('06-app-menu');
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 700);

    // 4) 원장 가입 코드
    await page.locator('.nav-item', { hasText: '원장 가입 코드' }).click();
    await btn('코드 만들기').click();
    await page.getByPlaceholder('비워 두면 가입할 때 입력').fill('마고수학학원');
    await page.getByPlaceholder('예: 마고수학학원 본원 원장').fill('본원 원장');
    await t.shot('07-code-dialog');
    await btn('만들기').click();
    const code = (await page.locator('.secret .mono').innerText()).trim();
    assert.match(code, /^MAGO-/);
    await t.shot('08-code-made');
    await btn('확인').click();
    await page.locator('.table tbody tr').first().waitFor();
    await t.shot('09-codes');
    step(`가입 코드 ${code}`);

    // 5) 공지
    await page.locator('.nav-item', { hasText: '공지사항' }).click();
    await btn('공지 쓰기').click();
    await page.getByPlaceholder('제목').fill('통합 클라우드를 시작해요');
    await page.getByPlaceholder('내용').fill('이제 모든 학원 프로그램은 통합 클라우드에서 설치하고 실행해요.\n같은 아이디로 로그인하면 어느 컴퓨터에서든 같은 데이터를 써요.');
    await btn('올리기').click();
    await page.locator('.notice').first().waitFor();
    await t.shot('10-notices');
    step('공지');

    // 6) 계정 관리 (운영자)
    await page.locator('.nav-item', { hasText: '계정 관리' }).click();
    await btn('계정 만들기').click();
    await page.locator('.dialog select').first().selectOption('director');
    await page.getByPlaceholder('새 학원 이름').fill('마고영어학원');
    await page.getByPlaceholder('예: 홍길동').fill('박원장');
    await page.getByPlaceholder('영어 소문자·숫자 3자 이상').fill('park');
    await t.shot('11-create-account');
    await btn('만들기').click();
    await page.locator('.secret .mono').waitFor();
    await btn('확인').click();
    await page.locator('.table tbody tr', { hasText: 'park' }).waitFor();
    await t.shot('12-people');
    step('계정 만들기');

    // 7) 다른 운영 화면
    for (const [nav, name] of [['apps-admin', '13-apps-admin'], ['audit', '14-audit'], ['server', '15-server'], ['account', '16-account'], ['settings', '17-settings']]) {
      await page.locator(`.nav-item[data-id="${nav}"]`).click();
      await page.waitForTimeout(700);
      await t.shot(name);
    }
    step('운영 화면');

    // 8) 로그아웃 → 원장 가입
    await page.locator('button[title="로그아웃"]').click();
    await page.locator('.dialog').getByRole('button', { name: '로그아웃', exact: true }).click();
    await page.getByText('가입 코드가 있어요').click();
    await page.getByPlaceholder('받은 가입 코드').fill(code);
    await btn('다음').click();
    // 다음 단계의 예약된 자동 포커스가 입력 중인 칸을 바꾸지 않도록 기다린다.
    await page.waitForFunction(() => document.activeElement?.getAttribute('placeholder') === '예: 홍길동');
    await page.getByPlaceholder('예: 홍길동').fill('김원장');
    await page.getByPlaceholder('영어 소문자·숫자 3자 이상').fill('kim');
    await page.getByPlaceholder('6자 이상').fill('secret12');
    await page.getByPlaceholder('한 번 더').fill('secret12');
    await t.shot('18-signup');
    await btn('가입하기').click();
    await page.locator('.nav-item', { hasText: '선생님 관리' }).waitFor();
    step('원장 가입');

    // 9) 선생님 추가
    await page.locator('.nav-item', { hasText: '선생님 관리' }).click();
    await btn('선생님 추가').click();
    await page.getByPlaceholder('예: 홍길동').fill('이선생');
    await page.getByPlaceholder('영어 소문자·숫자 3자 이상').fill('lee');
    await btn('만들기').click();
    await page.locator('.secret .mono').waitFor();
    const teacherPw = (await page.locator('.secret .mono').innerText()).trim();
    await t.shot('19-teacher-password');
    await btn('확인').click();
    await page.locator('.table tbody tr', { hasText: 'lee' }).waitFor();
    await page.locator('.table tbody tr', { hasText: 'lee' }).getByRole('button', { name: '관리', exact: true }).click();
    await t.shot('20-teacher-menu');
    await page.mouse.click(5, 700);
    await page.locator('.nav-item[data-id="home"]').click();
    await page.waitForTimeout(500);
    await t.shot('21-home-director');
    step('선생님 관리');

    // 10) 선생님 첫 로그인 → 비밀번호 바꾸기 강제
    await page.locator('button[title="로그아웃"]').click();
    await page.locator('.dialog').getByRole('button', { name: '로그아웃', exact: true }).click();
    await page.getByPlaceholder('아이디').fill('lee');
    await page.getByPlaceholder('비밀번호', { exact: true }).fill(teacherPw);
    await btn('로그인').click();
    await page.getByText('새 비밀번호 설정').waitFor();
    await page.getByPlaceholder('지금 비밀번호 (받은 비밀번호)').fill(teacherPw);
    await page.locator('.dialog').getByPlaceholder('6자 이상').fill('teacher123');
    await page.locator('.dialog').getByPlaceholder('한 번 더').fill('teacher123');
    await t.shot('22-first-login');
    await btn('바꾸기').click();
    await page.getByText('비밀번호를 바꿨어요').waitFor();
    assert.equal(await page.locator('.nav-item[data-id="teachers"]').count(), 0, '선생님은 관리 메뉴가 없음');
    await t.shot('23-home-teacher');
    step('선생님 첫 로그인');

    assert.deepEqual(t.errors, [], `화면 오류: ${t.errors.join('\n')}`);
    console.log('화면 흐름 통과');
  } catch (err) {
    await t.shot('zz-failure').catch(() => {});
    console.error('오류:', t.errors);
    throw err;
  } finally {
    await t.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
