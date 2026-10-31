// 내 계정: 아이디·비밀번호·이름 바꾸기, 저장 공간, 로그인한 기기
import { h, ic, btn, busy, toast, field, input, passwordInput, checkbox, pill, bytes, ago, initial, ROLE, confirmDialog, reveal, put } from '../ui.js';

export class AccountView {
  constructor({ cloud, store }) {
    this.cloud = cloud;
    this.store = store;
    this.profile = h('div', { class: 'card' });
    this.storage = h('div', { class: 'card' });
    this.devices = h('div', { class: 'card' });
    this.el = h(
      'div',
      {},
      h('div', { class: 'page-head' }, h('div', { class: 'tt' }, h('h1', { class: 'title' }, '내 계정'), h('div', { class: 'subtitle' }, '아이디와 비밀번호를 바꾸고, 로그인한 컴퓨터를 관리해요.'))),
      h('div', { class: 'grid2' }, h('div', { class: 'stack' }, this.profile, this.usernameCard(), this.passwordCard()), h('div', { class: 'stack' }, this.storage, this.devices)),
    );
    this.renderProfile(store.state.user);
    this.loadStorage();
    this.loadDevices();
  }

  update(s) {
    const key = `${s.user.name}|${s.user.username}`;
    if (key !== this._key) this.renderProfile(s.user);
  }

  renderProfile(u) {
    this._key = `${u.name}|${u.username}`;
    const nameInput = input({ value: u.name });
    const save = btn('저장');
    save.addEventListener('click', () =>
      busy(save, async () => {
        try {
          await this.cloud.changeName(nameInput.value);
          toast('이름을 바꿨어요', 'success');
        } catch (e) {
          toast(e.message, 'error');
        }
      }),
    );
    put(this.profile, 
      h(
        'div',
        { style: { display: 'flex', gap: '16px', alignItems: 'center' } },
        h('div', { class: 'avatar lg' }, initial(u.name)),
        h(
          'div',
          { style: { minWidth: 0 } },
          h('div', { style: { fontSize: '20px', fontWeight: 700 } }, u.name),
          h('div', { class: 'muted', style: { marginTop: '2px', display: 'flex', gap: '6px', alignItems: 'center' } }, h('span', { class: 'mono' }, u.username), pill(ROLE[u.role], u.role === 'admin' ? 'dark' : u.role === 'director' ? '' : 'grey')),
          u.academy ? h('div', { class: 'subtle', style: { marginTop: '4px' } }, u.academy.name) : null,
        ),
      ),
      h('div', { style: { height: '16px' } }),
      h('div', { class: 'form-row', style: { alignItems: 'flex-end' } }, field('이름', nameInput), h('div', { style: { flex: 'none' } }, save)),
    );
  }

  usernameCard() {
    const nu = input({ placeholder: '새 아이디' });
    const pw = passwordInput({ placeholder: '지금 비밀번호' });
    const go = btn('아이디 바꾸기', { variant: 'soft' });
    go.addEventListener('click', () =>
      busy(go, async () => {
        try {
          const u = await this.cloud.changeUsername(nu.value, pw.input.value);
          toast(`아이디를 ${u.username}(으)로 바꿨어요`, 'success');
          nu.value = '';
          pw.input.value = '';
        } catch (e) {
          toast(e.message, 'error');
        }
      }),
    );
    return h(
      'div',
      { class: 'card' },
      h('h2', { class: 'card-title' }, ic('user', 18), '아이디 바꾸기'),
      h('p', { class: 'card-desc' }, '아이디를 바꿔도 데이터는 그대로예요. 다른 컴퓨터에서는 새 아이디로 로그인해요.'),
      field('새 아이디', nu, '영어 소문자·숫자·._- 로 3~32자'),
      field('지금 비밀번호', pw),
      h('div', { style: { marginTop: '16px', display: 'flex', justifyContent: 'flex-end' } }, go),
    );
  }

  passwordCard() {
    const cur = passwordInput({ placeholder: '지금 비밀번호' });
    const pw = passwordInput({ placeholder: '6자 이상' });
    const pw2 = passwordInput({ placeholder: '한 번 더' });
    let others = true;
    const go = btn('비밀번호 바꾸기', { variant: 'soft' });
    go.addEventListener('click', () =>
      busy(go, async () => {
        try {
          if (pw.input.value !== pw2.input.value) throw new Error('새 비밀번호가 서로 달라요.');
          await this.cloud.changePassword(cur.input.value, pw.input.value, others);
          toast('비밀번호를 바꿨어요', 'success');
          for (const x of [cur, pw, pw2]) x.input.value = '';
          this.loadDevices();
        } catch (e) {
          toast(e.message, 'error');
        }
      }),
    );
    return h(
      'div',
      { class: 'card' },
      h('h2', { class: 'card-title' }, ic('key', 18), '비밀번호 바꾸기'),
      h('div', { style: { height: '6px' } }),
      field('지금 비밀번호', cur),
      field('새 비밀번호', pw),
      field('새 비밀번호 확인', pw2),
      h('div', { style: { marginTop: '16px', display: 'flex', alignItems: 'center', gap: '10px' } }, checkbox('다른 컴퓨터에서는 로그아웃', true, (v) => (others = v)), h('div', { style: { flex: 1 } }), go),
    );
  }

  async loadStorage() {
    put(this.storage, h('h2', { class: 'card-title' }, ic('cloud', 18), '서버 저장 공간'), h('div', { class: 'spinner', style: { margin: '18px 0' } }));
    try {
      const r = await this.cloud.refreshStorage();
      const s = this.store.state;
      const names = Object.fromEntries(s.apps.map((a) => [a.id, a.name]));
      const quota = r.quotaBytes;
      const pct = quota ? Math.min(100, (r.usageBytes / quota) * 100) : 0;
      const rows = r.apps.map((a) =>
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'grow' }, h('div', { class: 'row-title' }, names[a.appId] || a.appId), h('div', { class: 'row-desc' }, `파일 ${a.files}개${a.lastChange ? ` · ${ago(a.lastChange)} 바뀜` : ''}`)),
          a.evictedGroups ? pill(`서버 보관 기간 지남 ${a.evictedGroups}`, 'yellow') : null,
          h('div', { style: { fontWeight: 600 } }, bytes(a.bytes)),
        ),
      );
      put(this.storage, 
        h('h2', { class: 'card-title' }, ic('cloud', 18), '서버 저장 공간'),
        h('p', { class: 'card-desc' }, '같은 아이디로 로그인한 컴퓨터끼리 이 데이터를 함께 써요.'),
        h(
          'div',
          { class: 'usage' },
          h('div', { class: 'nums' }, h('span', {}, h('b', {}, bytes(r.usageBytes)), ' 사용'), h('span', {}, quota ? `${bytes(quota)} 중` : '제한 없음')),
          quota ? h('div', { class: 'progress' }, h('i', { style: { width: `${pct}%` } })) : null,
        ),
        h('div', { style: { height: '8px' } }),
        ...rows,
        r.apps.some((a) => a.evictedGroups)
          ? h('div', { class: 'note', style: { marginTop: '12px' } }, ic('info', 18), h('span', {}, '오래 쓰지 않은 큰 데이터(예: 오답노트 문제집)는 서버에서만 지우고 그 데이터를 쓰던 컴퓨터에는 남겨 둬요. 그 컴퓨터에서 다시 열면 서버에 다시 올라가요.'))
          : null,
      );
    } catch (e) {
      put(this.storage, h('h2', { class: 'card-title' }, '서버 저장 공간'), h('div', { class: 'muted' }, e.message));
    }
  }

  async loadDevices() {
    try {
      const r = await this.cloud.api('GET', '/api/me/devices');
      const rows = r.devices.map((d) => {
        const out = d.current ? pill('지금 이 컴퓨터', 'green') : btn('로그아웃', { size: 'sm' });
        if (!d.current) {
          out.addEventListener('click', async () => {
            if (!(await confirmDialog(`${d.deviceName}에서 로그아웃할까요?`, '그 컴퓨터에서는 다시 로그인해야 해요.', '로그아웃'))) return;
            await this.cloud.api('DELETE', `/api/me/devices/${d.id}`);
            toast('로그아웃했어요', 'success');
            this.loadDevices();
          });
        }
        return h(
          'div',
          { class: 'row' },
          h('div', { style: { color: 'var(--grey500)' } }, ic(/win/i.test(d.platform) ? 'monitor' : 'laptop', 22)),
          h('div', { class: 'grow' }, h('div', { class: 'row-title' }, d.deviceName), h('div', { class: 'row-desc' }, `${ago(d.lastSeenAt)} 사용${d.ip ? ` · ${d.ip}` : ''}${d.clientVersion ? ` · 버전 ${d.clientVersion}` : ''}`)),
          out,
        );
      });
      const others = btn('다른 컴퓨터 모두 로그아웃', { size: 'sm', variant: 'subtle' });
      others.addEventListener('click', async () => {
        if (!(await confirmDialog('다른 컴퓨터에서 모두 로그아웃할까요?', '이 컴퓨터만 로그인 상태로 남아요.', '로그아웃'))) return;
        await this.cloud.api('POST', '/api/me/devices/logout-others', {});
        toast('다른 컴퓨터에서 로그아웃했어요', 'success');
        this.loadDevices();
      });
      put(this.devices, 
        h('div', { style: { display: 'flex', alignItems: 'center' } }, h('h2', { class: 'card-title', style: { flex: 1 } }, ic('monitor', 18), '로그인한 컴퓨터'), r.devices.length > 1 ? others : null),
        h('p', { class: 'card-desc' }, '모르는 컴퓨터가 있으면 로그아웃하고 비밀번호를 바꿔 주세요.'),
        ...rows,
      );
      reveal(this.devices);
    } catch (e) {
      put(this.devices, h('h2', { class: 'card-title' }, '로그인한 컴퓨터'), h('div', { class: 'muted' }, e.message));
    }
  }
}
