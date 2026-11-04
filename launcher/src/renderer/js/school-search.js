import { h, input, put } from './ui.js';

let nextId = 0;
const KIND = { 초등학교: '초', 중학교: '중', 고등학교: '고' };

/** 학교 이름 직접 입력도 허용. 선택 뒤 글자를 고치면 두 코드를 함께 지운다. */
export function schoolSearch(cloud) {
  const id = `school-results-${++nextId}`;
  const name = input({ placeholder: '학교 이름을 2자 이상 입력', maxlength: 60, role: 'combobox',
    'aria-label': '학교', 'aria-autocomplete': 'list', 'aria-controls': id, 'aria-expanded': 'false' });
  const list = h('div', { id, class: 'school-results', role: 'listbox', 'aria-label': '학교 검색 결과', hidden: true });
  const status = h('div', { class: 'hint', role: 'status', 'aria-live': 'polite' });
  const el = h('div', { class: 'school-search' }, name, list, status);
  let office = '', code = '', selectedName = '', hits = [], active = -1, timer, seq = 0, composing = false, pending = false;

  function close() {
    clearTimeout(timer);
    timer = null;
    pending = false;
    seq++;
    hits = [];
    active = -1;
    list.hidden = true;
    put(list);
    name.setAttribute('aria-expanded', 'false');
    name.removeAttribute('aria-activedescendant');
  }

  function pick(s) {
    close();
    name.value = selectedName = s.name;
    office = s.office;
    code = s.code;
    status.textContent = '학교를 선택했어요.';
  }

  function highlight() {
    [...list.children].forEach((option, i) => {
      option.classList.toggle('active', i === active);
      option.setAttribute('aria-selected', String(i === active));
    });
    if (active >= 0) {
      name.setAttribute('aria-activedescendant', `${id}-${active}`);
      list.children[active]?.scrollIntoView?.({ block: 'nearest' });
    }
  }

  function changed() {
    office = code = selectedName = '';
    close();
    status.textContent = '';
    const q = name.value.trim();
    if (composing || q.length < 2) return;
    if (q.length > 20 || !/^[가-힣A-Za-z0-9 ]+$/.test(q)) {
      status.textContent = '검색은 한글·영문·숫자 2~20자. 입력한 이름만 저장할 수도 있어요.';
      return;
    }
    const request = seq;
    timer = setTimeout(async () => {
      timer = null;
      pending = true;
      status.textContent = '학교를 찾고 있어요…';
      try {
        const r = await cloud.api('GET', `/api/schools/search?q=${encodeURIComponent(q)}`);
        if (request !== seq) return;
        hits = r.schools;
        put(list, ...hits.map((s, i) => h('button', { type: 'button', id: `${id}-${i}`, role: 'option', tabindex: -1,
          'aria-selected': 'false', title: s.address,
          onMousedown: (e) => e.preventDefault(), onClick: () => pick(s),
        }, [s.name, s.region, KIND[s.kind] || s.kind].filter(Boolean).join(' · '))));
        list.hidden = !hits.length;
        name.setAttribute('aria-expanded', String(!!hits.length));
        status.textContent = hits.length ? '학교를 고르거나 입력한 이름만 저장하세요.' : '검색 결과가 없어요. 입력한 이름만 저장할 수 있어요.';
      } catch (e) {
        if (request === seq) status.textContent = `${e.message || '학교 검색에 실패했어요.'} 입력한 이름만 저장할 수 있어요.`;
      } finally {
        if (request === seq) pending = false;
      }
    }, 300);
  }

  name.addEventListener('input', changed);
  name.addEventListener('compositionstart', () => { composing = true; close(); });
  name.addEventListener('compositionend', () => { composing = false; changed(); });
  name.addEventListener('blur', () => { close(); status.textContent = ''; });
  name.addEventListener('keydown', (e) => {
    if (e.isComposing || composing) { if (e.key === 'Enter') e.stopPropagation(); return; }
    if (e.key === 'Escape') {
      if (hits.length || timer || pending) { e.preventDefault(); e.stopPropagation(); close(); status.textContent = ''; }
    } else if (hits.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      active = active < 0 ? (e.key === 'ArrowDown' ? 0 : hits.length - 1)
        : (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      highlight();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      e.stopPropagation(); // 학교 선택을 대화상자 저장으로 해석하지 않음
      pick(hits[active]);
    }
  });

  return {
    el,
    fill(s) {
      close();
      name.value = selectedName = s?.school || '';
      office = s?.schoolOffice || '';
      code = s?.schoolCode || '';
      status.textContent = '';
    },
    value: () => ({ school: name.value.trim(), schoolOffice: name.value.trim() === selectedName ? office : '', schoolCode: name.value.trim() === selectedName ? code : '' }),
    destroy: close,
  };
}
