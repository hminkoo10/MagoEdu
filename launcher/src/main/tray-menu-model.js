'use strict';

// 화면에 보낸 항목과 실행할 명령을 같은 모델에서 만든다.
function trayMenuItems(state, visible) {
  const items = [{ id: 'open', label: '열기', icon: 'apps' }];
  if (visible) items.push({ id: 'hide', label: '숨기기', icon: 'x' });
  if (state.phase === 'ready') {
    const apps = state.apps.filter((a) => a.installed);
    if (apps.length) {
      items.push({ type: 'separator' });
      for (const a of apps) {
        const image = state.icons?.[a.id] || a.icon;
        items.push({
          id: `launch:${a.id}`, appId: a.id, action: 'launch',
          label: `${a.name}${a.running ? ' (켜져 있음)' : ''}`, icon: 'apps',
          // 외부 주소나 파일 경로는 팝업에서 읽지 않는다.
          image: typeof image === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(image) ? image : null,
        });
        if (a.running) items.push({ id: `stop:${a.id}`, appId: a.id, action: 'stop', label: `${a.name} 끄기`, icon: 'stop' });
      }
    }
    items.push({ type: 'separator' }, { id: 'sync', label: '지금 동기화', icon: 'refresh' });
  }
  items.push({ type: 'separator' }, { id: 'quit', label: '종료', icon: 'power', danger: true });
  return items;
}

function trayMenuAction(items, id) {
  // 문자열을 명령으로 해석하지 않고, 최신 모델에 실제 있는 id만 허용한다.
  return typeof id === 'string' ? items.find((item) => item.id === id && item.type !== 'separator') || null : null;
}

function trayMenuBounds(point, size, workArea) {
  // 커서·workArea·BrowserWindow 모두 DIP. scaleFactor를 다시 곱하면 혼합 DPI에서 벗어난다.
  // Windows의 DIP↔물리 픽셀 왕복 반올림으로 창이 1 DIP 커질 수 있어 가장자리에 여유를 둔다.
  const left = Math.ceil(workArea.x) + 1;
  const top = Math.ceil(workArea.y) + 1;
  const right = Math.floor(workArea.x + workArea.width) - 1;
  const bottom = Math.floor(workArea.y + workArea.height) - 1;
  const width = Math.min(Math.ceil(size.width), right - left);
  const height = Math.min(Math.ceil(size.height), bottom - top);
  return {
    x: Math.max(left, Math.min(Math.round(point.x), right - width)),
    y: Math.max(top, Math.min(Math.round(point.y), bottom - height)),
    width, height,
  };
}

module.exports = { trayMenuItems, trayMenuAction, trayMenuBounds };
