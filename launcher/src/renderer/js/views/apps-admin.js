// 프로그램 관리 (운영자): 목록, 배포 위치(GitHub), 보관 기간, 켜기/끄기, 새 프로그램 추가
import { h, ic, btn, busy, toast, dialog, field, input, select, toggle, pill, bytes, ago, date, confirmDialog, reveal, put } from '../ui.js';

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
          toast(e.message, 'error');
        }
      }),
    );
    this.el = h(
      'div',
      {},
      h(
        'div',
        { class: 'page-head' },
        h('div', { class: 'tt' }, h('h1', { class: 'title' }, '프로그램 관리'), h('div', { class: 'subtitle' }, '통합 클라우드에서 설치할 수 있는 프로그램과 배포 위치, 서버 보관 기간을 정해요.')),
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
      put(this.list, h('div', { class: 'card empty' }, e.message));
    }
  }

  render(r) {
    put(this.list, 
      ...r.apps.map((a) => {
        const src = a.source.type === 'github' ? `GitHub · ${a.source.repo}` : '서버에 직접 올림 (packages 폴더)';
        const enabled = toggle(a.enabled, async (on) => {
          try {
            await this.cloud.api('PATCH', `/api/admin/apps/${a.id}`, { enabled: on });
            toast(on ? `${a.name}을(를) 켰어요` : `${a.name}을(를) 목록에서 숨겼어요`, 'success');
            await this.cloud.refreshApps().catch(() => {});
          } catch (e) {
            toast(e.message, 'error');
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
            h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginLeft: 'auto' } }, h('span', { class: 'muted' }, '목록에 보이기'), enabled, btn('', { variant: 'subtle', iconName: 'edit', title: '고치기', onClick: () => this.edit(a) })),
          ),
          h(
            'div',
            { class: 'row', style: { marginTop: '10px' } },
            h(
              'div',
              { class: 'grow' },
              h('div', { class: 'row-title' }, rel ? `최신 버전 ${rel.version}` : '아직 배포된 버전 없음'),
              h('div', { class: 'row-desc' }, rel ? `${rel.fileName} · ${bytes(rel.size)}${rel.publishedAt ? ` · ${date(rel.publishedAt)} 배포` : ''}` : '묶음 파일(zip)을 배포하면 여기에 나타나요.'),
              a.releaseError ? h('div', { class: 'row-desc', style: { color: 'var(--danger)' } }, `확인 실패: ${a.releaseError}`) : null,
            ),
            h('span', { class: 'subtle' }, a.releaseCheckedAt ? `${ago(a.releaseCheckedAt)} 확인` : ''),
          ),
          h(
            'div',
            { class: 'row' },
            h('div', { class: 'grow' }, h('div', { class: 'row-title' }, '오래 안 쓰면 서버에서 정리'), h('div', { class: 'row-desc' }, '정한 기간 동안 쓰지 않은 큰 데이터(예: 오답노트 문제집)는 서버에서만 지우고, 그 데이터를 쓰던 컴퓨터에는 남겨 둬요.')),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '16px', flex: 'none' } }, h('span', { class: 'muted' }, '기간'), days, h('span', { class: 'muted' }, '일'), cold),
          ),
        );
      }),
    );
    reveal(this.list);
    const l = r.launcher;
    put(this.launcher, 
      h('h2', { class: 'card-title' }, ic('cloud', 18), '통합 클라우드 프로그램'),
      h('p', { class: 'card-desc' }, '설치된 통합 클라우드는 이 서버를 통해 새 버전을 받아 스스로 업데이트해요.'),
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'grow' }, h('div', { class: 'row-title' }, l ? `배포된 버전 ${l.version}` : '아직 배포된 설치 파일 없음'), h('div', { class: 'row-desc' }, l ? l.setupName : r.launcherError || 'GitHub Releases 에 MagoEduCloud-Setup-x.y.z.exe 와 latest.yml 을 올리면 나타나요.')),
      ),
    );
  }

  async saveCold(a, enabled, days) {
    try {
      await this.cloud.api('PATCH', `/api/admin/apps/${a.id}`, { coldStorage: { enabled, days: days || a.coldStorage.days } });
      a.coldStorage = { enabled, days };
      toast(enabled ? `${a.name}: ${days}일 동안 안 쓰면 서버에서 정리해요` : `${a.name}: 서버에서 정리하지 않아요`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async edit(a) {
    const id = input({ value: a?.id || '', placeholder: '예: ohdapnote', disabled: !!a });
    const name = input({ value: a?.name || '', placeholder: '예: 오답노트' });
    const desc = input({ value: a?.description || '', placeholder: '한 줄 설명' });
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
    let autoLaunch = !!a?.autoLaunchDefault;
    const gh = h('div', {}, field('저장소', repo), field('묶음 파일 이름 규칙 (정규식, 괄호 안이 버전)', asset));
    const sync = () => (gh.style.display = type.value === 'github' ? '' : 'none');
    type.addEventListener('change', sync);
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
        field('배포 위치', type),
        gh,
        field('실행 파일', exe),
        h('div', { class: 'form-row', style: { marginTop: '14px' } }, field('아이콘 주소', iconUrl), h('div', { style: { flex: 'none' } }, field('색', color))),
        h('div', { class: 'row', style: { borderBottom: 0, marginTop: '6px' } }, h('div', { class: 'grow' }, h('div', { class: 'row-title' }, '기본으로 함께 켜기'), h('div', { class: 'row-desc' }, '통합 클라우드가 켜질 때 이 프로그램도 켜요 (예: 타종). 사용자가 바꿀 수 있어요.')), toggle(autoLaunch, (v) => (autoLaunch = v))),
      ),
      ok: a ? '저장' : '추가',
      onOk: async () => {
        const body = {
          name: name.value,
          description: desc.value,
          exe: exe.value,
          iconUrl: iconUrl.value,
          color: color.value,
          autoLaunchDefault: autoLaunch,
          source: type.value === 'github' ? { type: 'github', repo: repo.value, asset: asset.value } : { type: 'local' },
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
