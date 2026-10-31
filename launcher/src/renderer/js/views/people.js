// 계정 관리
//   원장: 우리 학원 선생님 계정 만들기·지우기·비밀번호 초기화·사용 중지·프로그램 권한
//   운영자: 모든 계정 (원장·선생님·운영자), 학원
import { h, ic, btn, busy, toast, dialog, field, input, passwordInput, select, checkbox, toggle, segmented, pill, menu, bytes, ago, initial, ROLE, confirmDialog, secretDialog, reveal, put } from '../ui.js';

export class PeopleView {
  constructor({ cloud, store, mode }) {
    this.cloud = cloud;
    this.store = store;
    this.isAdmin = store.state.user.role === 'admin';
    this.mode = mode;
    this.filter = { role: '', q: '', academy: '' };
    this.academies = [];
    this.table = h('div', { class: 'table-wrap' });
    const add = btn(this.isAdmin ? '계정 만들기' : '선생님 추가', { variant: 'primary', iconName: 'userPlus', onClick: () => this.create() });
    this.academyBox = h('div');
    const search = input({ cls: 'page search', placeholder: '이름이나 아이디로 찾기' });
    let t = null;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        this.filter.q = search.value.trim();
        this.load();
      }, 250);
    });
    const toolbar = h('div', { class: 'toolbar' });
    if (this.isAdmin) {
      toolbar.append(
        segmented(
          [
            ['', '전체'],
            ['director', '원장'],
            ['teacher', '선생님'],
            ['admin', '운영자'],
          ],
          '',
          (v) => {
            this.filter.role = v;
            this.load();
          },
          { onPage: true },
        ),
      );
      this.academySel = select([['', '모든 학원']], '', { cls: 'page', style: 'width: 180px' });
      this.academySel.addEventListener('change', () => {
        this.filter.academy = this.academySel.value;
        this.load();
      });
      toolbar.append(this.academySel);
    }
    toolbar.append(search, h('div', { class: 'spacer' }));
    if (this.isAdmin) toolbar.append(btn('학원 관리', { variant: 'white', iconName: 'building', onClick: () => this.manageAcademies() }));
    const u = store.state.user;
    this.el = h(
      'div',
      {},
      h(
        'div',
        { class: 'page-head' },
        h(
          'div',
          { class: 'tt' },
          h('h1', { class: 'title' }, this.isAdmin ? '계정 관리' : '선생님 관리'),
          h('div', { class: 'subtitle' }, this.isAdmin ? '원장·선생님·운영자 계정을 직접 만들고 관리해요.' : `${u.academy?.name || '우리 학원'} 선생님 계정을 만들고 관리해요.`),
        ),
        h('div', { class: 'right' }, this.isAdmin ? null : btn('학원 이름 바꾸기', { variant: 'white', iconName: 'edit', onClick: () => this.renameAcademy() }), add),
      ),
      toolbar,
      this.table,
    );
    this.init();
  }

  async init() {
    await this.loadAcademies();
    await this.load();
  }

  async loadAcademies() {
    try {
      const r = await this.cloud.api('GET', '/api/academies');
      this.academies = r.academies;
      if (this.academySel) {
        const cur = this.academySel.value;
        put(this.academySel, h('option', { value: '' }, '모든 학원'), ...this.academies.map((a) => h('option', { value: String(a.id) }, a.name)));
        this.academySel.value = cur;
      }
    } catch {
      this.academies = [];
    }
  }

  apps() {
    return this.store.state.apps; // 내가 쓸 수 있는 프로그램 = 줄 수 있는 프로그램
  }

  async load() {
    const qs = new URLSearchParams();
    if (this.filter.role) qs.set('role', this.filter.role);
    if (this.filter.q) qs.set('q', this.filter.q);
    if (this.filter.academy) qs.set('academy', this.filter.academy);
    try {
      const r = await this.cloud.api('GET', `/api/users?${qs}`);
      this.render(r.users);
    } catch (e) {
      put(this.table, h('div', { class: 'empty' }, e.message));
    }
  }

  render(users) {
    const appNames = Object.fromEntries(this.apps().map((a) => [a.id, a.name]));
    if (!users.length) {
      put(this.table, h('div', { class: 'empty' }, ic('users', 40, 1.6), this.isAdmin ? '계정이 없어요' : '아직 선생님 계정이 없어요. ‘선생님 추가’를 눌러 만들어 주세요.'));
      return;
    }
    const rows = users.map((u) => {
      const more = btn('', { variant: 'subtle', size: 'sm', iconName: 'more', title: '관리' });
      more.addEventListener('click', () => this.openMenu(more, u));
      if (!u.manageable) more.style.visibility = 'hidden';
      const perm = u.allowedApps === null ? h('span', { class: 'subtle' }, '모든 프로그램') : u.allowedApps.length ? h('span', {}, u.allowedApps.map((id) => appNames[id] || id).join(', ')) : h('span', { class: 'subtle' }, '없음');
      return h(
        'tr',
        {},
        h(
          'td',
          {},
          h(
            'div',
            { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
            h('div', { class: 'avatar' }, initial(u.name)),
            h('div', {}, h('div', { style: { fontWeight: 600 } }, u.name), h('div', { class: 'subtle mono' }, u.username)),
          ),
        ),
        this.isAdmin ? h('td', {}, pill(ROLE[u.role], u.role === 'admin' ? 'dark' : u.role === 'director' ? '' : 'grey')) : null,
        this.isAdmin ? h('td', {}, u.academy?.name || h('span', { class: 'subtle' }, '-')) : null,
        h('td', {}, u.status === 'active' ? (u.mustChangePassword ? pill('첫 로그인 전', 'yellow') : pill('사용 중', 'green')) : pill('사용 중지', 'red')),
        h('td', {}, perm),
        h('td', { class: 'num' }, bytes(u.usageBytes), u.quotaBytes ? h('span', { class: 'subtle' }, ` / ${bytes(u.quotaBytes)}`) : null),
        h('td', { class: 'subtle' }, u.lastLoginAt ? ago(u.lastLoginAt) : '없음'),
        h('td', { class: 'acts' }, more),
      );
    });
    const head = ['이름', this.isAdmin ? '종류' : null, this.isAdmin ? '학원' : null, '상태', '프로그램', '서버 사용량', '마지막 로그인', ''].filter((x) => x !== null);
    put(this.table, 
      h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ...head.map((t, i) => h('th', { class: i === head.length - 3 ? 'num' : '' }, t)))), h('tbody', {}, ...rows)),
    );
    reveal(this.table.querySelector('tbody'));
  }

  openMenu(anchor, u) {
    menu(anchor, [
      { icon: 'key', label: '비밀번호 초기화', onClick: () => this.resetPassword(u) },
      { icon: 'box', label: '프로그램 권한', onClick: () => this.editApps(u) },
      { icon: 'edit', label: '이름·아이디 바꾸기', onClick: () => this.editInfo(u) },
      this.isAdmin && u.role !== 'admin' ? { icon: 'building', label: '학원·종류 바꾸기', onClick: () => this.editAcademy(u) } : null,
      this.isAdmin ? { icon: 'drive', label: '저장 공간 한도', onClick: () => this.editQuota(u) } : null,
      { icon: 'monitor', label: '모든 컴퓨터에서 로그아웃', onClick: () => this.logoutAll(u) },
      '-',
      u.status === 'active' ? { icon: 'ban', label: '사용 중지', onClick: () => this.suspend(u) } : { icon: 'unlock', label: '다시 사용하게 하기', onClick: () => this.activate(u) },
      { icon: 'trash', label: '계정 삭제', danger: true, onClick: () => this.remove(u) },
    ]);
  }

  appChecks(selected) {
    const apps = this.apps();
    const set = new Set(selected === null ? apps.map((a) => a.id) : selected);
    let all = selected === null;
    const box = h('div', { class: 'checks' });
    const drawList = () => {
      put(box, 
        ...apps.map((a) =>
          checkbox(a.name, set.has(a.id), (on) => {
            if (on) set.add(a.id);
            else set.delete(a.id);
          }),
        ),
      );
      box.style.opacity = all ? '.45' : '';
      box.style.pointerEvents = all ? 'none' : '';
    };
    drawList();
    const myAll = this.store.state.user.allowedApps === null;
    const allToggle = myAll
      ? h(
          'div',
          { class: 'row', style: { padding: '0 0 10px', borderBottom: 0 } },
          h('div', { class: 'grow' }, h('div', { class: 'row-title', style: { fontSize: '14px' } }, '모든 프로그램'), h('div', { class: 'row-desc' }, '나중에 새로 생기는 프로그램도 쓸 수 있어요.')),
          toggle(all, (v) => {
            all = v;
            drawList();
          }),
        )
      : null;
    return { el: h('div', {}, allToggle, box), value: () => (all && myAll ? null : apps.map((a) => a.id).filter((id) => set.has(id))) };
  }

  async create() {
    const name = input({ placeholder: '예: 홍길동' });
    const username = input({ placeholder: '영어 소문자·숫자 3자 이상' });
    const pw = passwordInput({ placeholder: '비우면 자동으로 만들어요' });
    let mustChange = true;
    const role = this.isAdmin
      ? select(
          [
            ['teacher', '선생님'],
            ['director', '원장'],
            ['admin', '운영자'],
          ],
          'teacher',
        )
      : null;
    const academy = this.isAdmin ? select([['__new', '+ 새 학원 만들기'], ...this.academies.map((a) => [String(a.id), a.name])], this.academies[0] ? String(this.academies[0].id) : '__new') : null;
    const newAcademy = input({ placeholder: '새 학원 이름' });
    const newWrap = field('새 학원 이름', newAcademy);
    const academyWrap = academy ? field('학원', academy) : null;
    const quota = input({ type: 'number', min: '0', placeholder: '비우면 기본값' });
    const sync = () => {
      if (!academy) return;
      const isAdminRole = role.value === 'admin';
      academyWrap.style.display = isAdminRole ? 'none' : '';
      newWrap.style.display = !isAdminRole && academy.value === '__new' ? '' : 'none';
    };
    role?.addEventListener('change', sync);
    academy?.addEventListener('change', sync);
    const apps = this.appChecks(this.store.state.user.allowedApps === null ? null : this.store.state.user.allowedApps);
    sync();
    let result = null;
    const ok = await dialog({
      title: this.isAdmin ? '계정 만들기' : '선생님 추가',
      sub: this.isAdmin ? null : '선생님에게 아이디와 비밀번호를 알려 주세요. 처음 로그인하면 비밀번호를 새로 정해요.',
      wide: true,
      body: h(
        'div',
        {},
        role ? h('div', { class: 'form-row' }, field('종류', role), academyWrap) : null,
        academy ? newWrap : null,
        h('div', { class: 'form-row', style: { marginTop: '14px' } }, field('이름', name), field('아이디', username)),
        field('비밀번호', pw, '6자 이상. 비워 두면 받아 적기 쉬운 비밀번호를 만들어 보여 드려요.'),
        field('쓸 수 있는 프로그램', apps.el),
        this.isAdmin ? field('저장 공간 한도 (MB)', quota, '0 이면 제한 없음') : null,
        h('div', { style: { marginTop: '14px' } }, checkbox('처음 로그인할 때 비밀번호 바꾸게 하기', true, (v) => (mustChange = v))),
      ),
      ok: '만들기',
      onOk: async () => {
        const body = { name: name.value, username: username.value, allowedApps: apps.value(), mustChangePassword: mustChange };
        if (pw.input.value) body.password = pw.input.value;
        if (this.isAdmin) {
          body.role = role.value;
          if (role.value !== 'admin') {
            if (academy.value === '__new') body.academyName = newAcademy.value;
            else body.academyId = Number(academy.value);
          }
          if (quota.value !== '') body.quotaMb = Number(quota.value);
        }
        result = await this.cloud.api('POST', '/api/users', body);
      },
    });
    if (!ok || !result) return;
    toast(`${result.user.name} 계정을 만들었어요`, 'success');
    if (result.password) await secretDialog('계정을 만들었어요', `아이디 ${result.user.username} 의 비밀번호예요. 이 창을 닫으면 다시 볼 수 없어요.`, result.password);
    await this.loadAcademies();
    this.load();
  }

  async resetPassword(u) {
    const pw = passwordInput({ placeholder: '비우면 자동으로 만들어요' });
    let res = null;
    const ok = await dialog({
      title: `${u.name} 비밀번호 초기화`,
      sub: '초기화하면 모든 컴퓨터에서 로그아웃되고, 다음 로그인 때 비밀번호를 새로 정해요.',
      body: field('새 비밀번호', pw),
      ok: '초기화',
      onOk: async () => {
        res = await this.cloud.api('POST', `/api/users/${u.id}/password`, pw.input.value ? { password: pw.input.value } : {});
      },
    });
    if (ok && res) await secretDialog('비밀번호를 초기화했어요', `${u.name}(${u.username})에게 알려 주세요.`, res.password);
  }

  async editApps(u) {
    const apps = this.appChecks(u.allowedApps);
    const ok = await dialog({
      title: `${u.name} 프로그램 권한`,
      sub: '고른 프로그램만 목록에 보이고 실행할 수 있어요.',
      body: apps.el,
      ok: '저장',
      onOk: () => this.cloud.api('PATCH', `/api/users/${u.id}`, { allowedApps: apps.value() }),
    });
    if (ok) {
      toast('권한을 바꿨어요', 'success');
      this.load();
    }
  }

  async editInfo(u) {
    const name = input({ value: u.name });
    const username = input({ value: u.username });
    const ok = await dialog({
      title: '이름·아이디 바꾸기',
      sub: '아이디를 바꿔도 데이터는 그대로예요.',
      body: h('div', {}, field('이름', name), field('아이디', username)),
      ok: '저장',
      onOk: () => this.cloud.api('PATCH', `/api/users/${u.id}`, { name: name.value, username: username.value }),
    });
    if (ok) {
      toast('바꿨어요', 'success');
      this.load();
    }
  }

  async editAcademy(u) {
    const academy = select(this.academies.map((a) => [String(a.id), a.name]), u.academy ? String(u.academy.id) : '');
    const role = select(
      [
        ['director', '원장'],
        ['teacher', '선생님'],
      ],
      u.role,
    );
    const ok = await dialog({
      title: `${u.name} 학원·종류`,
      body: h('div', { class: 'form-row' }, field('학원', academy), field('종류', role)),
      ok: '저장',
      onOk: () => this.cloud.api('PATCH', `/api/users/${u.id}`, { academyId: Number(academy.value), role: role.value }),
    });
    if (ok) {
      toast('바꿨어요', 'success');
      this.load();
    }
  }

  async editQuota(u) {
    const q = input({ type: 'number', min: '0', value: u.quotaMb ?? '', placeholder: '비우면 기본값' });
    const ok = await dialog({
      title: `${u.name} 저장 공간 한도`,
      sub: `지금 ${bytes(u.usageBytes)} 쓰고 있어요.`,
      body: field('한도 (MB)', q, '0 이면 제한 없음, 비우면 서버 기본값'),
      ok: '저장',
      onOk: () => this.cloud.api('PATCH', `/api/users/${u.id}`, { quotaMb: q.value === '' ? null : Number(q.value) }),
    });
    if (ok) {
      toast('한도를 바꿨어요', 'success');
      this.load();
    }
  }

  async logoutAll(u) {
    if (!(await confirmDialog(`${u.name}을(를) 모든 컴퓨터에서 로그아웃할까요?`, '다시 로그인하면 계속 쓸 수 있어요.', '로그아웃'))) return;
    await this.cloud.api('POST', `/api/users/${u.id}/logout-all`, {});
    toast('로그아웃했어요', 'success');
  }

  async suspend(u) {
    const reason = input({ placeholder: '예: 휴직 (선택)' });
    const ok = await dialog({
      title: `${u.name} 계정을 사용 중지할까요?`,
      sub: '로그인할 수 없게 되고 모든 컴퓨터에서 로그아웃돼요. 데이터는 그대로 남고, 언제든 다시 쓰게 할 수 있어요.',
      body: field('이유', reason),
      ok: '사용 중지',
      danger: true,
      onOk: () => this.cloud.api('POST', `/api/users/${u.id}/suspend`, { reason: reason.value }),
    });
    if (ok) {
      toast('사용 중지했어요', 'success');
      this.load();
    }
  }

  async activate(u) {
    try {
      await this.cloud.api('POST', `/api/users/${u.id}/activate`, {});
      toast('다시 쓸 수 있게 했어요', 'success');
      this.load();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async remove(u) {
    const typed = input({ placeholder: u.username });
    const ok = await dialog({
      title: `${u.name} 계정을 삭제할까요?`,
      sub: `서버에 있는 이 계정의 데이터(${bytes(u.usageBytes)})도 함께 지워지고 되살릴 수 없어요.\n확인하려면 아이디 ${u.username} 을(를) 입력해 주세요.`,
      body: typed,
      ok: '삭제',
      danger: true,
      onOk: async () => {
        if (typed.value.trim().toLowerCase() !== u.username) throw new Error('아이디가 맞지 않아요.');
        await this.cloud.api('DELETE', `/api/users/${u.id}`);
      },
    });
    if (ok) {
      toast('계정을 삭제했어요', 'success');
      this.load();
    }
  }

  async renameAcademy() {
    const a = this.store.state.user.academy;
    if (!a) return;
    const name = input({ value: a.name });
    const ok = await dialog({
      title: '학원 이름 바꾸기',
      body: field('학원 이름', name),
      ok: '저장',
      onOk: () => this.cloud.api('PATCH', `/api/academies/${a.id}`, { name: name.value }),
    });
    if (ok) {
      await this.cloud.refreshMe();
      toast('학원 이름을 바꿨어요', 'success');
    }
  }

  async manageAcademies() {
    await this.loadAcademies();
    const list = h('div');
    const draw = () => {
      put(list, 
        ...this.academies.map((a) => {
          const edit = btn('', { variant: 'subtle', size: 'sm', iconName: 'edit', title: '이름 바꾸기' });
          edit.addEventListener('click', async () => {
            const name = input({ value: a.name });
            const ok = await dialog({ title: '학원 이름 바꾸기', body: field('학원 이름', name), ok: '저장', onOk: () => this.cloud.api('PATCH', `/api/academies/${a.id}`, { name: name.value }) });
            if (ok) {
              await this.loadAcademies();
              draw();
            }
          });
          const del = btn('', { variant: 'subtle', size: 'sm', iconName: 'trash', title: '지우기', disabled: a.directors + a.teachers > 0 });
          del.addEventListener('click', async () => {
            try {
              await this.cloud.api('DELETE', `/api/academies/${a.id}`);
              await this.loadAcademies();
              draw();
            } catch (e) {
              toast(e.message, 'error');
            }
          });
          return h('div', { class: 'row' }, ic('building', 20), h('div', { class: 'grow' }, h('div', { class: 'row-title' }, a.name), h('div', { class: 'row-desc' }, `원장 ${a.directors}명 · 선생님 ${a.teachers}명`)), edit, del);
        }),
      );
      if (!this.academies.length) put(list, h('div', { class: 'empty' }, '학원이 없어요'));
    };
    draw();
    const name = input({ placeholder: '새 학원 이름' });
    const add = btn('추가', { variant: 'soft' });
    add.addEventListener('click', () =>
      busy(add, async () => {
        try {
          await this.cloud.api('POST', '/api/academies', { name: name.value });
          name.value = '';
          await this.loadAcademies();
          draw();
        } catch (e) {
          toast(e.message, 'error');
        }
      }),
    );
    await dialog({ title: '학원 관리', wide: true, body: h('div', {}, list, h('div', { class: 'form-row', style: { marginTop: '14px', alignItems: 'center' } }, name, h('div', { style: { flex: 'none' } }, add))), ok: '닫기', cancel: null });
    this.load();
  }
}
