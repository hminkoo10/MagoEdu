import { icon } from './icons.js';

const menu = document.getElementById('menu');
const api = window.trayMenu;

api.onModel(async (model) => {
  const selected = model.resetSelection ? null : document.activeElement?.dataset.id;
  const fragment = document.createDocumentFragment();
  for (const item of model.items) {
    if (item.type === 'separator') {
      const separator = document.createElement('div');
      separator.className = 'tray-separator';
      separator.setAttribute('role', 'separator');
      fragment.append(separator);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tray-item${item.danger ? ' danger' : ''}`;
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    button.dataset.id = item.id;
    // SVG는 번들 아이콘만, 앱 이름은 textContent로 넣는다.
    button.innerHTML = icon(item.icon, 20);
    if (item.image) {
      const image = document.createElement('img');
      image.alt = '';
      image.src = item.image;
      image.addEventListener('error', () => { image.remove(); button.firstElementChild.style.removeProperty('display'); });
      button.firstElementChild.style.display = 'none';
      button.append(image);
    }
    const label = document.createElement('span');
    label.className = 'tray-label';
    label.textContent = item.label;
    button.append(label);
    button.addEventListener('click', () => api.activate(item.id));
    button.addEventListener('pointermove', () => button.focus({ preventScroll: true }));
    fragment.append(button);
  }
  menu.replaceChildren(fragment);
  menu.style.maxWidth = `${model.maxWidth}px`;
  menu.style.maxHeight = `${model.maxHeight}px`;
  const previous = [...menu.querySelectorAll('button')].find((button) => button.dataset.id === selected);
  (previous || menu).focus({ preventScroll: true });
  // 대체 글꼴 폭으로 창 크기를 정하지 않도록 번들 글꼴 로드를 기다린다.
  await document.fonts.ready;
  const { width, height } = menu.getBoundingClientRect();
  api.measure(model.revision, Math.ceil(width), Math.ceil(height));
});

document.addEventListener('keydown', (event) => {
  const buttons = [...menu.querySelectorAll('button')];
  const current = buttons.indexOf(document.activeElement);
  if (event.key === 'Escape') api.close();
  else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    let next = event.key === 'ArrowUp' ? (current < 0 ? buttons.length - 1 : (current - 1 + buttons.length) % buttons.length) : (current + 1) % buttons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    buttons[next]?.focus();
  } else if (event.key === 'Enter' || event.key === ' ') {
    if (current >= 0) buttons[current].click();
  } else if (event.key !== 'Tab') return;
  event.preventDefault();
});
document.addEventListener('contextmenu', (event) => { event.preventDefault(); api.close(); });
api.ready();
