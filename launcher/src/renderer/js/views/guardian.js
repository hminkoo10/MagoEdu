import { h, btn, input, field, passwordInput, checkbox, busy, put, errorText, toast } from '../ui.js';

const labels = {
  collect: '개인정보 수집·이용 (필수)',
  messaging: '학원 알림 받기 (선택)',
};
const consentTexts = {
  collect: [
    '목적: 보호자 계정 만들기, 자녀 연결과 학원 서비스 제공.',
    '항목: 학생 이름, 보호자 이름·관계·연락처, 아이디와 비밀번호.',
    '보유 기간: 자녀 연결 정보와 동의 기록은 학생 정보를 완전히 지울 때까지, 계정 정보는 계정을 지울 때까지 보관합니다.',
    '동의를 거부할 수 있습니다. 거부하면 보호자 계정을 만들거나 자녀를 연결할 수 없습니다.',
  ],
  messaging: [
    '목적: 학원 알림을 문자·알림톡으로 보내기. 발송은 업체에 맡깁니다.',
    '항목: 보호자 이름·연락처와 학원 알림 내용.',
    '이용 기간: 동의를 철회하거나 학생 정보를 완전히 지울 때까지 알림 발송에 씁니다. 동의 기록은 학생 정보를 완전히 지울 때까지 보관합니다.',
    '동의를 거부할 수 있습니다. 거부해도 가입과 자녀 확인은 가능하며, 문자·알림톡만 받지 않습니다.',
  ],
};

export class GuardianJoinView {
  constructor({ cloud, code = '', back, verified }) {
    this.el = h('div');
    const invite = input({ value: code, placeholder: '학원에서 받은 초대 코드', autocomplete: 'off' });
    const info = h('div');
    const form = h('div');
    const error = h('div', { class: 'error-text', style: { display: 'none' } });
    const showError = (e) => {
      error.textContent = errorText(e);
      error.style.display = '';
    };
    let checkedCode = null;
    const showAccount = async (checked) => {
      const { user: existing } = await cloud.getState();
      checkedCode = invite.value.trim();
      invite.disabled = true;
      put(info, h('div', { class: 'note', style: { margin: '16px 0' } }, `${checked.academyName} · ${checked.studentName} 학생이 맞는지 확인하세요.`));
      if (existing && existing.role !== 'guardian') {
        put(form, h('p', { class: 'muted' }, '로그아웃하고 이 학원용 보호자 계정을 만들어 주세요.'));
        return;
      }
      const name = input({ placeholder: '보호자 이름', autocomplete: 'name' });
      const username = input({ placeholder: '영문 소문자·숫자·._- 3~32자', autocomplete: 'username' });
      const password = passwordInput({ placeholder: '6자 이상', autocomplete: 'new-password' });
      const again = passwordInput({ placeholder: '한 번 더', autocomplete: 'new-password' });
      const next = btn(existing ? '동의 확인' : '다음: 동의 확인', {
        variant: 'primary', size: 'lg', cls: 'block',
        onClick: () => {
          error.style.display = 'none';
          if (!existing && password.input.value !== again.input.value) {
            showError(new Error('비밀번호가 서로 달라요.'));
            return;
          }
          const boxes = {};
          const join = btn(existing ? '내 계정에 자녀 연결' : '동의하고 가입', {
            variant: 'primary', size: 'lg', cls: 'block',
            onClick: () => busy(join, async () => {
              error.style.display = 'none';
              try {
                if (!boxes.collect.checked) throw new Error('필수 동의를 확인해 주세요.');
                await cloud.joinStudent({
                  code: checkedCode, name: name.value, username: username.value, password: password.input.value,
                  consentVersion: checked.consentVersion,
                  consents: Object.fromEntries(Object.entries(boxes).map(([item, box]) => [item, box.checked])),
                });
                back();
              } catch (e) { showError(e); }
            }),
          });
          put(form,
            h('h2', { class: 'card-title' }, '보호자 동의'),
            h('p', { class: 'muted' }, `동의문 날짜: ${checked.consentVersion}. 동의 내용은 학원 확인 전으로 표시됩니다.`),
            ...Object.entries(labels).map(([item, label]) => {
              const choice = checkbox(label, false, () => {});
              boxes[item] = choice.querySelector('input');
              return h('section', { class: 'card' }, choice,
                ...consentTexts[item].map(text => h('p', { class: 'muted' }, text)));
            }), join,
          );
        },
      });
      put(form,
        ...(existing ? [h('p', { class: 'note' }, `${existing.name} 계정에 연결합니다. 다른 학원 계정에는 연결할 수 없습니다.`)]
          : [field('이름', name), field('아이디', username), field('비밀번호', password), field('비밀번호 확인', again)]), next);
    };
    const check = btn('코드 확인', {
      variant: 'soft',
      onClick: () => busy(check, async () => {
        error.style.display = 'none';
        try {
          const checked = await cloud.checkStudentInvite(invite.value.trim());
          if (checked.role !== 'guardian') throw new Error('보호자 초대 코드를 넣어 주세요.');
          await showAccount(checked);
        } catch (e) { showError(e); }
      }),
    });
    put(this.el, field('보호자 초대 코드', invite), check, info, form, error,
      h('div', { class: 'auth-links' }, h('button', { class: 'link', onClick: back }, '돌아가기')));
    if (verified) showAccount(verified).catch(showError);
    else if (code) check.click();
  }
}

export class GuardianView {
  constructor({ cloud }) {
    this.cloud = cloud;
    this.el = h('div');
    this.load();
  }

  async load() {
    const cloud = this.cloud;
    try {
      const { user } = await cloud.api('GET', '/api/me');
      const own = await cloud.api('GET', '/api/me/guardians');
      const { consents } = await cloud.api('GET', '/api/me/consents');
      const invite = input({ placeholder: '학원에서 받은 초대 코드', autocomplete: 'off' });
      const connect = btn('자녀 연결', {
        variant: 'primary',
        onClick: () => {
          if (!invite.value.trim()) return toast('초대 코드를 넣어 주세요.', 'error');
          location.hash = `#/join?code=${encodeURIComponent(invite.value.trim())}`;
        },
      });
      const currentPassword = passwordInput({ autocomplete: 'current-password' });
      const newPassword = passwordInput({ autocomplete: 'new-password' });
      const change = btn('비밀번호 바꾸기', {
        variant: 'primary',
        onClick: () => busy(change, async () => {
          try {
            await cloud.api('PATCH', '/api/me/password', {
              currentPassword: currentPassword.input.value, newPassword: newPassword.input.value,
            });
            currentPassword.input.value = '';
            newPassword.input.value = '';
            toast('비밀번호를 바꿨어요.', 'success');
          } catch (e) { toast(errorText(e), 'error'); }
        }),
      });
      put(this.el,
        h('div', { class: 'page-head' }, h('div', { class: 'tt' },
          h('h1', { class: 'title' }, '내 자녀'), h('div', { class: 'subtitle' }, '자녀와 학원 알림 동의를 확인해요.'))),
        h('section', { class: 'card' }, h('h2', { class: 'card-title' }, '연결된 자녀'),
          ...(user.children.length ? user.children.map(child => h('p', {}, child.name))
            : [h('p', { class: 'muted' }, '연결된 자녀가 없어요.')]),
          field('자녀 초대 코드', invite, '다른 자녀를 연결하려면 학원에서 받은 코드를 넣어 주세요.'), connect),
        h('section', { class: 'card' }, h('h2', { class: 'card-title' }, '사용할 수 있는 프로그램'),
          h('div', { class: 'apps-grid' }, ...own.apps.map(app => h('div', { class: 'app-card' },
            h('div', { class: 'app-name' }, app.name),
            h('div', { class: 'app-foot' }, h('span', { class: 'muted' }, '새 탭에서 열어요'), btn('열기', {
              variant: 'primary', iconName: 'external',
              onClick: () => cloud.openExternal(app.url).catch(e => toast(errorText(e), 'error')),
            })),
          ))), own.apps.length ? null : h('p', { class: 'muted' }, '아직 사용할 수 있는 프로그램이 없어요.')),
        h('section', { class: 'card' }, h('h2', { class: 'card-title' }, '내 동의'),
          ...consents.filter(c => labels[c.item]).map(c => this.consentRow(c)),
          consents.some(c => labels[c.item]) ? null : h('p', { class: 'muted' }, '기록된 동의가 없어요.')),
        h('section', { class: 'card' }, h('h2', { class: 'card-title' }, '비밀번호 변경'),
          field('현재 비밀번호', currentPassword), field('새 비밀번호', newPassword), change),
      );
    } catch (e) { put(this.el, h('div', { class: 'empty' }, errorText(e))); }
  }

  consentRow(consent) {
    const withdraw = btn('철회', {
      variant: 'soft',
      onClick: () => busy(withdraw, async () => {
        try {
          await this.cloud.api('POST', `/api/me/consents/${consent.id}/withdraw`, {});
          await this.load();
        } catch (e) { toast(errorText(e), 'error'); }
      }),
    });
    const status = consent.withdrawn_at ? '철회함' : consent.verified ? '확인됨' : '학원 확인 전';
    return h('div', { class: 'note' }, h('p', {}, labels[consent.item]),
      h('p', { class: 'muted' }, `동의문 날짜: ${consent.version} · ${status}`),
      consent.item !== 'collect' && !consent.withdrawn_at ? withdraw : null);
  }

  onNav() { this.load(); }
}
