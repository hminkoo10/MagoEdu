// 화면 도우미: 요소 만들기, 대화상자, 메뉴, 토스트, 글자 형식
import { icon } from './icons.js';

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

/** 안의 내용을 바꾼다 (null·false 는 건너뜀 — DOM replaceChildren 은 "null" 글자를 넣어 버림) */
export function put(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function ic(name, size = 20, stroke = 2) {
  const span = document.createElement('span');
  span.style.display = 'contents';
  span.innerHTML = icon(name, size, stroke);
  return span.firstElementChild;
}

export function btn(label, { variant = '', size = '', iconName = null, onClick, title, disabled, type = 'button', cls = '' } = {}) {
  const b = h('button', { type, class: `btn ${variant} ${size} ${!label && iconName ? 'icon' : ''} ${cls}`.trim(), title, 'aria-label': !label ? title : undefined, disabled });
  if (iconName) b.append(ic(iconName, size === 'sm' ? 16 : 18));
  if (label) b.append(document.createTextNode(label));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** 오래 걸리는 버튼: 누르면 돌아가는 표시, 끝나면 원래대로 */
export async function busy(button, fn) {
  if (!button) return fn();
  const old = [...button.childNodes];
  const w = button.offsetWidth;
  button.disabled = true;
  button.style.minWidth = `${w}px`;
  button.replaceChildren(h('span', { class: `spinner ${button.classList.contains('primary') || button.classList.contains('danger-solid') ? 'white' : ''}` }));
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.replaceChildren(...old);
  }
}

export function toggle(checked, onChange, { disabled = false } = {}) {
  const input = h('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.disabled = disabled;
  input.addEventListener('change', () => onChange?.(input.checked, input));
  return h('label', { class: 'toggle' }, input, h('span', { class: 'track' }), h('span', { class: 'knob' }));
}

export function checkbox(label, checked, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange?.(input.checked));
  return h('label', { class: 'check' }, input, h('span', { class: 'box' }, ic('check', 14, 3)), h('span', {}, label));
}

export const SUBJECTS = [['math', '수학'], ['english', '영어'], ['korean', '국어']];

export function subjectChecks(selected = ['math']) {
  const chosen = new Set(selected);
  const el = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '16px' } },
    ...SUBJECTS.map(([code, name]) => checkbox(name, chosen.has(code), (checked) => checked ? chosen.add(code) : chosen.delete(code))),
  );
  return { el, value: () => SUBJECTS.filter(([code]) => chosen.has(code)).map(([code]) => code) };
}

export function subjectText(list = ['math']) {
  return SUBJECTS.filter(([code]) => list.includes(code)).map(([, name]) => name).join(' · ') || '계약한 과목 없음';
}

/** 회색 트랙 위에서 흰 표시가 미끄러지는 선택 */
export function segmented(options, value, onChange, { onPage = false } = {}) {
  const pill = h('span', { class: 'seg-pill' });
  const wrap = h('div', { class: `seg ${onPage ? 'on-page' : ''}` }, pill);
  const buttons = options.map(([v, label]) => {
    const b = h('button', { type: 'button', class: v === value ? 'on' : '' }, label);
    b.addEventListener('click', () => {
      if (v === value) return;
      value = v;
      buttons.forEach((x) => x.classList.toggle('on', x === b));
      move();
      onChange?.(v);
    });
    wrap.append(b);
    return b;
  });
  const move = () => {
    const on = buttons.find((b) => b.classList.contains('on'));
    if (!on) return;
    pill.style.width = `${on.offsetWidth}px`;
    pill.style.transform = `translateX(${on.offsetLeft - 4}px)`;
  };
  requestAnimationFrame(() => requestAnimationFrame(move));
  return wrap;
}

export function field(label, control, hint) {
  const inp = control.matches('input, textarea, select') ? control : control.querySelector('input, textarea, select');
  const labelEl = label ? h('label', {}, label) : null;
  if (labelEl && inp) {
    inp.id ||= `field-${++fieldId}`;
    labelEl.htmlFor = inp.id;
  }
  return h('div', { class: 'field' }, labelEl, control, hint ? h('div', { class: 'hint' }, hint) : null);
}
let fieldId = 0;

// 이름이 같은 웹·PC 앱도 권한/용량 목록에서 구분한다. 실제 카탈로그 이름은 바꾸지 않음.
export function appLabel(app) {
  return `${app.name} · ${app.platform === 'web' ? '웹' : app.platform === 'android' ? '안드로이드' : 'PC'}`;
}

export function input(props = {}) {
  return h('input', { class: `input ${props.cls || ''}`.trim(), spellcheck: 'false', autocomplete: 'off', ...props, cls: undefined });
}

export function passwordInput(props = {}) {
  const inp = input({ type: 'password', ...props });
  const eye = btn('', { variant: 'subtle', size: 'sm', iconName: 'eye', title: '비밀번호 보기' });
  eye.classList.add('eye');
  eye.addEventListener('click', () => {
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    eye.replaceChildren(ic(show ? 'eyeOff' : 'eye', 16));
    eye.title = eye.title.replace(/보기|숨기기/, show ? '숨기기' : '보기');
    eye.setAttribute('aria-label', eye.title);
  });
  const wrap = h('div', { class: 'input-wrap' }, inp, eye);
  wrap.input = inp;
  return wrap;
}

export function select(options, value, props = {}) {
  const s = h('select', { class: `input ${props.cls || ''}`.trim(), ...props, cls: undefined });
  for (const [v, label] of options) {
    const o = h('option', { value: v }, label);
    if (String(v) === String(value)) o.selected = true;
    s.append(o);
  }
  return s;
}

export function pill(text, kind = '') {
  return h('span', { class: `pill ${kind}` }, text);
}

export function reveal(container) {
  container.classList.remove('reveal');
  [...container.children].forEach((c, i) => c.style.setProperty('--i', i));
  void container.offsetWidth;
  container.classList.add('reveal');
}

// ---------------------------------------------------------------- 토스트
const ERROR_TEXT = {
  account_exists: '이미 계정이 있어요. 명단의 ‘계정 관리’를 열어요.',
  username_taken: '사용 중인 아이디예요. 다른 아이디를 입력해요.',
  academy_code_required: '‘학원 코드 정하기’가 필요해요. 선생님은 원장님께 요청해요.',
  academy_code_taken: '사용 중인 학원 코드예요. 다른 코드를 입력해요.',
  student_deleted: '‘삭제한 학생’에서 되살린 뒤 다시 시도해요.',
  no_student: '학생을 찾지 못했어요. 명단을 새로 고침해요.',
  no_account: '학생 계정을 만든 뒤 다시 시도해요.',
  invalid_code: '사용할 수 없는 코드예요. 코드·기간을 확인해요.',
  rate_limited: '요청이 많아요. 잠시 후 다시 시도해요.',
  session_invalid: '로그인이 만료됐어요. 다시 로그인해요.',
  auth_required: '로그인 후 다시 시도해요.',
  offline: '인터넷 연결을 확인하고 다시 시도해요.',
};

/** API·저장 값은 그대로 두고 화면에 표시할 오류만 풀어 쓴다. */
export function errorText(error) {
  const message = String(error?.message ?? error ?? '');
  const code = error?.code || message.match(/\b[a-z]+(?:_[a-z]+)+\b/)?.[0];
  if (ERROR_TEXT[code]) return `${ERROR_TEXT[code]} (${code})`;
  if (!message || !/[가-힣]/.test(message)) return `다시 시도해요. 계속 실패하면 원장님·운영자에게 오류를 알려요.${message ? ` (${message})` : ''}`;
  return message;
}

let toastBox = null;
export function toast(text, kind = 'info', ms = 2800, action = null) {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts' });
    document.body.append(toastBox);
  }
  const names = { success: 'circleCheck', error: 'alert', warning: 'warning', info: 'info' };
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status', 'data-keep': kind === 'error' || !!action }, ic(names[kind] || 'info', 18), h('span', {}, kind === 'error' && !/[가-힣]/.test(text) ? errorText(text) : text));
  const dismiss = () => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 220);
  };
  if (action) {
    const undo = btn(action.label, { size: 'sm', variant: 'subtle' });
    undo.addEventListener('click', () => busy(undo, async () => {
      try { if (await action.onClick() !== false) dismiss(); }
      catch (e) { toast(errorText(e), 'error'); }
    }));
    t.append(undo);
  }
  if (kind === 'error' || action) t.append(btn('닫기', { size: 'sm', variant: 'subtle', onClick: dismiss }));
  toastBox.append(t);
  while (toastBox.children.length > 3) {
    const oldest = toastBox.querySelector('.toast:not([data-keep])');
    if (!oldest) break;
    oldest.remove();
  }
  setTimeout(dismiss, kind === 'error' || action ? Math.max(ms, 12000) : ms);
}

// ---------------------------------------------------------------- 대화상자
/**
 * dialog({ title, sub, body, ok, cancel, danger, wide, onOk })
 * onOk 가 Error 를 던지면 대화상자 안에 보여 주고 닫지 않는다.
 */
export function dialog({ title, sub, body, ok = '확인', cancel = '취소', danger = false, wide = false, onOk, footLeft, okDisabled = false, okIcon = null, cancelIcon = null }) {
  return new Promise((resolve) => {
    const err = h('div', { class: 'error-text', style: { display: 'none' } });
    const okBtn = ok ? btn(ok, { variant: danger ? 'danger-solid' : 'primary', size: 'lg', disabled: okDisabled, iconName: okIcon }) : null;
    const cancelBtn = cancel ? btn(cancel, { size: 'lg', iconName: cancelIcon }) : null;
    const closeBtn = btn('', { variant: 'subtle', size: 'sm', iconName: 'x', title: '닫기' });
    const box = h(
      'div',
      { class: `dialog ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'dialog-head' }, h('div', { class: 'tt' }, h('h2', { class: 'dialog-title' }, title), sub ? h('div', { class: 'dialog-sub' }, sub) : null), closeBtn),
      body || null,
      err,
      h('div', { class: 'dialog-foot' }, footLeft ? h('div', { class: 'left' }, footLeft) : null, cancelBtn, okBtn),
    );
    const dim = h('div', { class: 'dim' }, box);
    let done = false;
    const close = (value) => {
      if (done || okBtn?.disabled && !okDisabled) return;
      done = true;
      dim.classList.add('out');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => dim.remove(), 170);
      resolve(value);
    };
    const accept = async () => {
      if (!okBtn || okBtn.disabled) return;
      err.style.display = 'none';
      try {
        const v = onOk ? await busy(okBtn, onOk) : true;
        if (v === false) return;
        close(v === undefined ? true : v);
      } catch (e) {
        err.textContent = errorText(e);
        err.style.display = '';
      }
    };
    const onKey = (e) => {
      if ([...document.querySelectorAll('.dim:not(.out)')].at(-1) !== dim) return;
      if (e.key === 'Escape' && canDismiss()) close(null);
      if (e.key === 'Enter' && !['TEXTAREA', 'BUTTON', 'SUMMARY'].includes(e.target.tagName)) accept();
    };
    const canDismiss = () => !box.querySelector('input, textarea, select, [contenteditable="true"], .secret, .selectable');
    okBtn?.addEventListener('click', accept);
    cancelBtn?.addEventListener('click', () => close(null));
    closeBtn.addEventListener('click', () => close(null));
    dim.addEventListener('mousedown', (e) => {
      if (e.target === dim && canDismiss()) close(null);
    });
    document.addEventListener('keydown', onKey);
    document.body.append(dim);
    dialog.okButton = okBtn;
    setTimeout(() => {
      if (!box.contains(document.activeElement)) box.querySelector('input:not([type=checkbox]):not([disabled]), textarea, select')?.focus();
    }, 30);
  });
}

export function confirmDialog(title, sub, ok = '확인', danger = false) {
  return dialog({ title, sub, ok, danger }).then((v) => !!v);
}

export function notify(title, sub) {
  return dialog({ title, sub, ok: '확인', cancel: null });
}

// 웹에는 window.cloud 가 없어서 app.js 가 넘겨준다
let bridge = null;
export function useCloud(cloud) {
  bridge = cloud;
}

/** 만든 비밀번호처럼 한 번만 보여 줄 값 */
export function secretDialog(title, sub, value) {
  const copy = btn('복사', { variant: 'white', size: 'sm', iconName: 'copy' });
  copy.addEventListener('click', async () => {
    await (bridge || window.cloud).copy(value);
    toast('복사했어요', 'success', 1600);
  });
  return dialog({
    title,
    sub,
    ok: '확인',
    cancel: null,
    body: h('div', { class: 'secret' }, h('span', { class: 'mono' }, value), copy),
  });
}

// ---------------------------------------------------------------- 메뉴
let openMenu = null;
export function menu(anchor, items) {
  closeMenu();
  const m = h('div', { class: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      m.append(h('div', { class: 'menu-sep' }));
      continue;
    }
    const row = h('div', { class: `menu-item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}` }, it.icon ? ic(it.icon, 18) : null, h('span', {}, it.label), it.end || null);
    row.addEventListener('click', (e) => {
      if (it.keepOpen) {
        e.stopPropagation();
        it.onClick?.(row);
        return;
      }
      closeMenu();
      it.onClick?.();
    });
    m.append(row);
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  let left = r.right - mw;
  let top = r.bottom + 6;
  if (left < 8) left = r.left;
  left = Math.min(left, window.innerWidth - mw - 8); // 좁은 화면에서 오른쪽으로 넘치지 않게
  if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
  m.style.left = `${Math.max(8, left)}px`;
  m.style.top = `${Math.max(8, top)}px`;
  openMenu = m;
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
  return m;
}

function outside(e) {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}

export function closeMenu() {
  if (openMenu) openMenu.remove();
  openMenu = null;
  document.removeEventListener('mousedown', outside);
}

// ---------------------------------------------------------------- 글자 형식
export function bytes(n) {
  if (!n) return '0B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${u[i]}`;
}

export function ago(t) {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 50) return '방금';
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}일 전`;
  return date(t);
}

export function date(t, withTime = false) {
  if (!t) return '';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  const s = `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
  return withTime ? `${s} ${p(d.getHours())}:${p(d.getMinutes())}` : s;
}

export function initial(name) {
  return (String(name || '?').trim()[0] || '?').toUpperCase();
}

export const ROLE = { admin: '운영자', director: '원장', teacher: '선생님', student: '학생' };
