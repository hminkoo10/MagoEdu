// 프로그램 관리 (운영자): 목록, 배포 위치(GitHub), 보관 기간, 켜기/끄기, 새 프로그램 추가, 웹 프로그램 주소·앱 비밀값
import { errorText, h, ic, btn, busy, toast, dialog, field, input, select, toggle, pill, bytes, ago, date, confirmDialog, reveal, put } from '../ui.js';

export class AppsAdminView {
  constructor({ cloud }) {
    this.cloud = cloud;
    this.list = h('div', { class: 'stack' });
    this.launcher = h('div', { class: 'card' });
    const refresh = btn('새 버전 확인', { variant: 'white', iconName: 'refresh' });
    refresh.addEventListener('click', () =>
      busy(refresh, async () => {
        try {
          const r = await this.cloud.api('POST', '/api/admin/apps/refresh', {});
          this.render(r);
          await this.cloud.refreshApps().catch(() => {});
          toast('새 버전을 확인했어요', 'success');
        } catch (e) {
          toast(errorText(e), 'error');
        }
      }),
    );
    this.el = h(
      'div',
      {},
      h(
        'div',
        { class: 'page-head' },
        h('div', { class: 'tt' }, h('h1', { class: 'title' }, '프로그램 관리'), h('div', { class: 'subtitle' }, '')),
        h('div', { class: 'right' }, refresh, btn('프로그램 추가', { variant: 'primary', iconName: 'plus', onClick: () => this.edit(null) })),
      ),
      this.list,
      h('div', { style: { height: '16px' } }),
      this.launcher,
    );
    this.load();
  }

  async load() {
    try {
      this.render(await this.cloud.api('GET', '/api/admin/apps'));
    } catch (e) {
      put(this.list, h('div', { class: 'card empty' }, errorText(e)));
    }
  }

  render(r) {
    put(this.list, 
      ...r.apps.map((a) => {
        const android = a.platform === 'android';
        const web = a.platform === 'web';
        const src = web ? `웹 · ${a.url || '주소 없음'}` : `${android ? '안드로이드 · ' : ''}${a.source.type === 'github' ? `GitHub · ${a.source.repo}` : '서버에 직접 올림 (packages 폴더)'}`;
        const enabled = toggle(a.enabled, async (on) => {
          try {
            await this.cloud.api('PATCH', `/api/admin/apps/${a.id}`, { enabled: on });
            toast(on ? `${a.name}을(를) 켰어요` : `${a.name}을(를) 목록에서 숨겼어요`, 'success');
            await this.cloud.refreshApps().catch(() => {});
          } catch (e) {
            toast(errorText(e), 'error');
          }
        });
        const cold = toggle(a.coldStorage.enabled, (on) => this.saveCold(a, on, Number(days.value)));
        const days = input({ type: 'number', min: '1', value: a.coldStorage.days, style: 'width: 80px' });
        days.addEventListener('change', () => this.saveCold(a, a.coldStorage.enabled, Number(days.value)));
        const rel = a.release;
        return h(
          'div',
          { class: 'card' },
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'center' } },
            h('div', { class: 'app-icon', style: a.color ? { background: a.color } : {} }, a.name[0]),
            h(
              'div',
              { style: { flex: '1 1 160px', minWidth: 0 } }, // 좁은 화면에서는 오른쪽 조작부가 아래 줄로
              h('div', { class: 'app-name', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, a.name, h('span', { class: 'subtle mono' }, a.id), a.enabled ? null : pill('숨김', 'grey')),
              h('div', { class: 'muted' }, src),
            ),
            h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginLeft: 'auto' } }, h('span', { class: 'muted' }, '목록에 보이기'), enabled, btn('고치기', { variant: 'subtle', iconName: 'edit', onClick: () => this.edit(a) })),
          ),
          // 웹 프로그램은 배포 버전 대신 앱 비밀값 (웹 프로그램 서버가 로그인 코드를 바꿀 때 씀)
          web
            ? this.secretRow(a)
            : h(
                'div',
                { class: 'row', style: { marginTop: '10px' } },
                h(
                  'div',
                  { class: 'grow' },
                  h('div', { class: 'row-title' }, rel ? `최신 버전 ${rel.version}` : '아직 배포된 버전 없음'),
                  h('div', { class: 'row-desc' }, rel ? `${rel.fileName} · ${bytes(rel.size)}${rel.publishedAt ? ` · ${date(rel.publishedAt)} 배포` : ''}` : android ? '배포된 APK가 없어요.' : '배포된 ZIP이 없어요.'),
                  a.releaseError ? h('div', { class: 'row-desc', style: { color: 'var(--danger)' } }, `확인 실패: ${a.releaseError}`) : null,
                ),
                h('span', { class: 'subtle' }, a.releaseCheckedAt ? `${ago(a.releaseCheckedAt)} 확인` : ''),
              ),
          // 안드로이드 항목은 데이터를 따로 두지 않음 (같은 데이터를 PC 항목 ID로 맞춤), 웹 프로그램은 자기 서버에 둠
          android || web
            ? null
            : h(
                'div',
                { class: 'row' },
                h('div', { class: 'grow' }, h('div', { class: 'row-title' }, '오래 안 쓰면 서버에서 정리'), h('div', { class: 'row-desc' }, '서버에서만 지워요. 사용하던 컴퓨터에는 남아요.')),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '16px', flex: 'none' } }, h('span', { class: 'muted' }, '기간'), days, h('span', { class: 'muted' }, '일'), cold),
              ),
        );
      }),
    );
    reveal(this.list);
    const l = r.launcher;
    put(this.launcher, 
      h('h2', { class: 'card-title' }, ic('cloud', 18), '통합 클라우드 프로그램'),
      h('p', { class: 'card-desc' }, ''),
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'grow' }, h('div', { class: 'row-title' }, l ? `배포된 버전 ${l.version}` : '아직 배포된 설치 파일 없음'), h('div', { class: 'row-desc' }, l ? l.setupName : r.launcherError || '배포 파일: MagoEduCloud-Setup-x.y.z.exe · latest.yml')),
      ),
    );
  }

  secretRow(a) {
    const make = btn(a.hasSecret ? '새로 만들기' : '만들기', { variant: a.hasSecret ? '' : 'soft', size: 'sm', iconName: 'key' });
    make.addEventListener('click', () => busy(make, () => this.makeSecret(a)));
    return h(
      'div',
      { class: 'row', style: { marginTop: '10px' } },
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'row-title' }, '앱 비밀값'),
        h('div', { class: 'row-desc' }, a.hasSecret ? '등록됨 · 통합 클라우드 계정 로그인용' : '미등록 · 웹 서버의 MAGO_APP_SECRET에 설정해요.'),
      ),
      make,
    );
  }

  /** 앱 비밀값은 서버에 해시만 남아서 한 번만 보여 준다 */
  async makeSecret(a) {
    if (a.hasSecret && !(await confirmDialog(`${a.name} 앱 비밀값을 새로 만들까요?`, '이전 비밀값으로 새 로그인 불가. 서버의 MAGO_APP_SECRET도 바꿔요. 기존 로그인은 유지돼요.', '새로 만들기', true))) return;
    let secret = null;
    try {
      secret = (await this.cloud.api('POST', `/api/admin/apps/${a.id}/secret`, {})).secret;
    } catch (e) {
      toast(errorText(e), 'error');
      return;
    }
    this.load();
    const copy = btn('복사', { variant: 'white', size: 'sm', iconName: 'copy' });
    copy.addEventListener('click', async () => {
      try {
        await this.cloud.copy(secret);
        toast('복사했어요', 'success', 1600);
      } catch (e) {
        toast(errorText(e), 'error');
      }
    });
    await dialog({
      title: '앱 비밀값을 만들었어요',
      sub: `${a.name} 서버의 MAGO_APP_SECRET에 설정해요. 닫으면 다시 볼 수 없어요.`,
      ok: '확인',
      cancel: null,
      body: h('div', { class: 'secret long' }, h('span', { class: 'mono' }, secret), copy),
    });
  }

  async saveCold(a, enabled, days) {
    try {
      await this.cloud.api('PATCH', `/api/admin/apps/${a.id}`, { coldStorage: { enabled, days: days || a.coldStorage.days } });
      a.coldStorage = { enabled, days };
      toast(enabled ? `${a.name}: ${days}일 동안 안 쓰면 서버에서 정리해요` : `${a.name}: 서버에서 정리하지 않아요`, 'success');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  async edit(a) {
    const id = input({ value: a?.id || '', placeholder: '예: ohdapnote', disabled: !!a });
    const name = input({ value: a?.name || '', placeholder: '예: 오답노트' });
    const desc = input({ value: a?.description || '', placeholder: '한 줄 설명' });
    const platform = select(
      [
        ['windows', 'Windows PC (통합 클라우드가 설치·실행)'],
        ['android', '안드로이드 (웹에서 APK 내려받기만)'],
        ['web', '웹 (브라우저에서 열고 통합 클라우드 계정으로 로그인)'],
      ],
      a?.platform || 'windows',
    );
    const url = input({ value: a?.url || '', placeholder: 'https://navi.example.com' });
    const type = select(
      [
        ['github', 'GitHub Releases'],
        ['local', '서버에 직접 올림'],
      ],
      a?.source.type || 'github',
    );
    const repo = input({ value: a?.source.repo || '', placeholder: 'hminkoo10/ohdapnote' });
    const asset = input({ value: a?.source.asset || '', placeholder: '^OhdapNote-(\\d+\\.\\d+\\.\\d+)-win-x64\\.zip$', cls: 'mono' });
    const exe = input({ value: a?.exe || '', placeholder: '예: OhdapNote.exe (묶음 안 magoedu-app.json 이 먼저)' });
    const iconUrl = input({ value: a?.iconUrl || '', placeholder: 'https://... (PNG)' });
    const color = input({ value: a?.color || '#F76B15', type: 'color', style: 'width: 64px; padding: 4px' });
    let guardianEnabled = !!a?.guardianEnabled;
    const guardianRow = h('div', {class: 'row'}, '보호자 사용 가능 (웹만)', toggle(guardianEnabled, v => guardianEnabled = v));
    let autoLaunch = !!a?.autoLaunchDefault;
    const gh = h('div', {}, field('저장소', repo), field('묶음 파일 이름 규칙 (정규식, 괄호 안이 버전)', asset));
    const exeField = field('실행 파일', exe);
    const typeField = field('배포 위치', type);
    const urlField = field('주소', url, 'https:// 필수. 로컬 시험은 http://localhost 허용.');
    const autoRow = h('div', { class: 'row', style: { borderBottom: 0, marginTop: '6px' } }, h('div', { class: 'grow' }, h('div', { class: 'row-title' }, '기본으로 윈도우 시작 시 실행'), h('div', { class: 'row-desc' }, '사용자가 바꿀 수 있어요.')), toggle(autoLaunch, (v) => (autoLaunch = v)));
    const sync = () => {
      const pc = platform.value === 'windows';
      const web = platform.value === 'web'; // 웹은 배포 파일 없이 주소만
      typeField.style.display = web ? 'none' : '';
      urlField.style.display = web ? '' : 'none';
      gh.style.display = !web && type.value === 'github' ? '' : 'none';
      exeField.style.display = pc ? '' : 'none';
      autoRow.style.display = pc ? '' : 'none';
      asset.placeholder = pc ? '^OhdapNote-(\\d+\\.\\d+\\.\\d+)-win-x64\\.zip$' : '^MaplTajong-(\\d+\\.\\d+\\.\\d+)\\.apk$';
    };
    type.addEventListener('change', sync);
    platform.addEventListener('change', sync);
    sync();
    const footLeft = a ? btn('삭제', { variant: 'danger', onClick: () => this.remove(a) }) : null;
    const ok = await dialog({
      title: a ? `${a.name} 고치기` : '프로그램 추가',
      wide: true,
      footLeft,
      body: h(
        'div',
        {},
        h('div', { class: 'form-row' }, field('ID', id, '영어 소문자, 바꿀 수 없음'), field('이름', name)),
        field('설명', desc),
        guardianRow, field('플랫폼', platform, '안드로이드는 휴대폰에 설치해요. 웹은 브라우저에서 열려요.'),
        typeField,
        urlField,
        gh,
        exeField,
        h('div', { class: 'form-row', style: { marginTop: '14px' } }, field('아이콘 주소', iconUrl), h('div', { style: { flex: 'none' } }, field('색', color))),
        autoRow,
      ),
      ok: a ? '저장' : '추가',
      onOk: async () => {
        const body = {
          name: name.value,
          description: desc.value,
          exe: exe.value,
          iconUrl: iconUrl.value,
          color: color.value,
          platform: platform.value,
          guardianEnabled: platform.value === 'web' && guardianEnabled,
          autoLaunchDefault: platform.value === 'windows' && autoLaunch,
          ...(platform.value === 'web' ? { url: url.value.trim() } : { source: type.value === 'github' ? { type: 'github', repo: repo.value, asset: asset.value } : { type: 'local' } }),
        };
        if (a) await this.cloud.api('PATCH', `/api/admin/apps/${a.id}`, body);
        else await this.cloud.api('POST', '/api/admin/apps', { ...body, id: id.value });
      },
    });
    if (ok) {
      toast(a ? '저장했어요' : '프로그램을 추가했어요', 'success');
      await this.load();
      this.cloud.refreshApps().catch(() => {});
    }
  }

  async remove(a) {
    if (!(await confirmDialog(`${a.name}을(를) 목록에서 지울까요?`, '이미 설치한 컴퓨터의 프로그램과 데이터는 그대로 남아요. 잠시 숨기려면 ‘목록에 보이기’를 끄세요.', '지우기', true))) return;
    await this.cloud.api('DELETE', `/api/admin/apps/${a.id}`);
    toast('지웠어요', 'success');
    document.querySelector('.dim')?.remove();
    this.load();
    this.cloud.refreshApps().catch(() => {});
  }
}
