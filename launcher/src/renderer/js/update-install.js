import { h, btn, dialog } from './ui.js';

const NOTICE = '업데이트를 설치하려고 잠시 닫아요. 1분쯤 뒤에 다시 켜져요.';

export function updateInstallButton(cloud, store, { confirm = false, label = '지금 설치' } = {}) {
  const u = store.state.update;
  const waiting = u.status === 'deferred';
  const locked = waiting || u.status === 'installing';
  return btn(locked ? (waiting ? '설치 대기 중' : '설치 준비 중…') : u.canRetryInstall ? '다시 설치' : label, {
    variant: 'primary', size: 'sm', iconName: locked ? 'refresh' : 'download', disabled: locked,
    onClick: async () => {
      if (['installing', 'deferred'].includes(store.state.update?.status)) return;
      if (confirm && !await dialog({
        title: '통합 클라우드를 업데이트할까요?',
        body: h('p', { class: 'update-notice' }, `${NOTICE} 켜져 있는 프로그램은 계속 실행돼요.`),
        ok: '지금 설치', okIcon: 'download', cancelIcon: 'x',
      })) return;
      if (['installing', 'deferred'].includes(store.state.update?.status)) return;
      store.setUpdate({ ...u, status: 'installing', message: NOTICE });
      try {
        const result = await cloud.installUpdate();
        if (!['installing', 'deferred', 'error'].includes(result?.status)) {
          throw new Error(result?.message || '설치를 시작하지 못했어요. 업데이트를 다시 확인해 주세요.');
        }
        store.setUpdate(result);
      } catch (err) {
        store.setUpdate({ ...u, status: 'error', canRetryInstall: true, message: err.message || '설치 요청을 보내지 못했어요.' });
      }
    },
  });
}
