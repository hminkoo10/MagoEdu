// 학원 AI (원장·운영자): 학원 사람 모두의 프로그램이 기본으로 쓸 AI 와, 프로그램마다 따로 정한 AI
//   키는 서버에만 있고 화면에는 끝 4자리만 보여 준다. 운영자는 학원을 골라서 본다.
import { h, ic, btn, busy, toast, dialog, field, input, passwordInput, select, segmented, pill, ago, put } from '../ui.js';
import { academyPicker } from './students.js';

const PROVIDERS = [
  ['gemini', 'Gemini'],
  ['openai', 'OpenAI 호환'],
  ['anthropic', 'Claude'],
];
const PROVIDER = Object.fromEntries(PROVIDERS);
const KEY_PLACEHOLDER = { gemini: 'AIza…', openai: '로컬 서버면 비워 두세요', anthropic: 'sk-ant-…' };

/** 한 줄 요약: Gemini · gemini-2.5-flash · 키 ••••1234 */
function summary(c) {
  return [PROVIDER[c.provider] || c.provider, c.model, c.keyHint ? `키 ${c.keyHint}` : null].filter(Boolean).join(' · ');
}

/** AI 설정 입력 (기본 AI 카드와 프로그램별 대화상자가 같이 씀). value() 는 서버에 보낼 config */
function aiForm(cur) {
  const provider = select(PROVIDERS, cur?.provider || 'gemini');
  const rpm = input({ type: 'number', min: '1', max: '1000', value: cur?.rpm ?? '', placeholder: '비우면 프로그램 기본값' });
  const key = passwordInput({ autocomplete: 'new-password' }); // 브라우저가 로그인 비밀번호를 채워 넣지 않게
  key.querySelector('.eye').title = '키 보기';
  const baseUrl = input({ value: cur?.baseUrl || '', placeholder: 'https://api.openai.com/v1' });
  const model = input({ value: cur?.model || '', placeholder: '비우면 프로그램 기본 모델' });
  const model2 = input({ value: cur?.model2 || '', placeholder: '비워도 돼요' });
  const urlField = field('주소', baseUrl, 'OpenRouter·LiteLLM 같은 게이트웨이나 Ollama·LM Studio 같은 로컬 서버면 그 주소를 넣어 주세요.');
  const sync = () => {
    const p = provider.value;
    // 같은 AI 종류면 키를 비워 둬도 서버에 있는 키를 그대로 씀
    key.input.placeholder = cur?.keyHint && cur.provider === p ? `${cur.keyHint} · 비워 두면 그대로` : KEY_PLACEHOLDER[p];
    urlField.style.display = p === 'openai' ? '' : 'none';
  };
  provider.addEventListener('change', sync);
  sync();
  const el = h(
    'div',
    {},
    h('div', { class: 'form-row' }, field('AI 종류', provider), field('분당 요청', rpm)),
    field('API 키', key),
    urlField,
    h('div', { class: 'form-row' }, field('모델', model), field('보조 모델', model2, '모델을 쓸 수 없거나 한도가 차면 이 모델로 넘어가요.')),
  );
  const value = () => {
    const p = provider.value;
    const c = { provider: p, model: model.value.trim(), model2: model2.value.trim(), baseUrl: p === 'openai' ? baseUrl.value.trim() : '', rpm: rpm.value === '' ? null : Number(rpm.value) };
    const k = key.input.value.trim();
    if (k) c.apiKey = k; // 비우면 보내지 않음 → 서버가 지금 키를 그대로 둠
    return c;
  };
  return { el, value };
}

export class AcademyAiView {
  constructor({ cloud, store }) {
    this.cloud = cloud;
    this.store = store;
    this.isAdmin = store.state.user.role === 'admin';
    this.academy = ''; // 운영자가 고른 학원
    this.data = null;
    this.seq = 0;
    this.stamp = store.state.academyStamp;
    this.main = h('div', { class: 'card' });
    this.apps = h('div', { class: 'card' });
    this.picker = this.isAdmin
      ? academyPicker(cloud, (id) => {
          this.academy = id;
          this.load();
        })
      : null;
    this.el = h(
      'div',
      {},
      h(
        'div',
        { class: 'page-head' },
        h(
          'div',
          { class: 'tt' },
          h('h1', { class: 'title' }, '학원 AI'),
          h('div', { class: 'subtitle' }, '학원 사람 모두의 프로그램(오답노트·마고 과목내비 등)이 기본으로 이 AI 를 써요. 각자 프로그램에서 ‘내 키 쓰기’를 고를 수도 있어요.'),
        ),
        this.picker ? h('div', { class: 'right' }, this.picker.el) : null,
      ),
      h('div', { class: 'stack' }, this.main, this.apps),
    );
    this.init();
  }

  async init() {
    if (this.picker) {
      try {
        this.academy = await this.picker.ready;
      } catch (e) {
        this.fail(e.message);
        return;
      }
      if (!this.academy) {
        this.fail('학원이 없어요. ‘계정 관리’의 ‘학원 관리’에서 먼저 만들어 주세요.');
        return;
      }
    }
    await this.load();
  }

  qs() {
    return this.academy ? `?academy=${encodeURIComponent(this.academy)}` : '';
  }

  fail(text) {
    this._key = null;
    put(this.main, h('div', { class: 'empty' }, ic('bot', 40, 1.6), text));
    this.apps.style.display = 'none';
  }

  async load() {
    if (this.isAdmin && !this.academy) return;
    const seq = ++this.seq;
    try {
      const r = await this.cloud.api('GET', `/api/academy/ai/all${this.qs()}`);
      if (seq !== this.seq) return;
      // 바뀐 게 없으면 다시 그리지 않음 (입력하던 내용이 지워지지 않게)
      const key = JSON.stringify(r);
      if (key === this._key) return;
      this._key = key;
      this.data = r;
      this.render();
    } catch (e) {
      if (seq === this.seq) this.fail(e.message);
    }
  }

  onNav() {
    this.load();
  }

  // 통합 클라우드 앱: 다른 원장님이 학원 AI 를 바꾸면 academyStamp 가 바뀜 (웹은 없음)
  update(s) {
    if (s.academyStamp === this.stamp) return;
    this.stamp = s.academyStamp;
    this.load();
  }

  render() {
    this.renderMain();
    this.renderApps();
  }

  renderMain() {
    const d = this.data.default;
    const form = aiForm(d);
    const err = h('div', { class: 'error-text', style: { display: 'none' } });
    const save = btn('저장', { variant: 'primary' });
    save.addEventListener('click', () =>
      busy(save, async () => {
        err.style.display = 'none';
        try {
          await this.putAi('', form.value());
          toast('기본 AI 를 저장했어요', 'success');
        } catch (e) {
          err.textContent = e.message;
          err.style.display = '';
        }
      }),
    );
    const clear = d ? btn('지우기', { variant: 'danger', onClick: () => this.clear(null) }) : null;
    put(
      this.main,
      h('h2', { class: 'card-title' }, ic('bot', 18), '기본 AI', d ? pill(PROVIDER[d.provider] || d.provider, 'green') : pill('정하지 않음', 'grey')),
      h('p', { class: 'card-desc' }, d ? `${summary(d)} · ${ago(d.updatedAt)} 바꿈` : '아직 정하지 않았어요. 정하기 전에는 각자 프로그램에서 자기 키를 넣어서 써요.'),
      form.el,
      err,
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '18px' } }, clear, h('div', { style: { flex: 1 } }), save),
    );
    this.apps.style.display = '';
  }

  renderApps() {
    const progs = this.data.programs || [];
    put(
      this.apps,
      h('h2', { class: 'card-title' }, '세부 설정 — 프로그램마다 따로'),
      h('p', { class: 'card-desc' }, '프로그램마다 다른 AI 나 키를 쓰게 할 수 있어요. 따로 정하지 않은 프로그램은 기본 AI 를 써요.'),
      ...(progs.length ? progs.map((p) => this.appRow(p)) : [h('div', { class: 'empty', style: { padding: '24px 20px' } }, '프로그램이 없어요')]),
    );
  }

  appRow(p) {
    const own = this.data.apps?.[p.id] || null;
    const choice = segmented(
      [
        ['default', '기본 AI 사용'],
        ['own', '따로 정하기'],
      ],
      own ? 'own' : 'default',
      (v) => (v === 'own' ? this.editApp(p) : this.clear(p)),
    );
    const edit = own ? btn('', { variant: 'subtle', size: 'sm', iconName: 'edit', title: '고치기', onClick: () => this.editApp(p) }) : null;
    return h(
      'div',
      { class: 'row' },
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'row-title', style: { display: 'flex', alignItems: 'center', gap: '8px' } }, p.name, p.platform === 'web' ? pill('웹 프로그램', 'grey') : null),
        h('div', { class: 'row-desc' }, own ? `따로 정함 · ${summary(own)}` : '기본 AI 를 써요'),
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flex: 'none' } }, edit, choice),
    );
  }

  /** 서버에 저장하고 다시 그림 (실패하면 던짐) */
  async putAi(app, config) {
    const r = await this.cloud.api('PUT', `/api/academy/ai${this.qs()}`, { app, config });
    this._key = JSON.stringify(r);
    this.data = r;
    if (app) this.renderApps();
    else this.render();
  }

  async editApp(p) {
    const own = this.data.apps?.[p.id] || null;
    const form = aiForm(own);
    const ok = await dialog({
      title: `${p.name} AI`,
      sub: '이 프로그램만 여기서 정한 AI 를 써요. 학원 사람 모두에게 똑같이 적용돼요.',
      wide: true,
      body: form.el,
      ok: '저장',
      onOk: () => this.putAi(p.id, form.value()),
    });
    if (ok) toast(`${p.name}은(는) 이제 따로 정한 AI 를 써요`, 'success');
    else this.renderApps(); // 고른 것을 되돌림
  }

  /** p 가 없으면 기본 AI 지우기, 있으면 그 프로그램을 기본 AI 로 되돌리기 */
  async clear(p) {
    const ok = await dialog({
      title: p ? `${p.name}도 기본 AI 를 쓰게 할까요?` : '기본 AI 를 지울까요?',
      sub: p ? '이 프로그램에 따로 정한 AI 와 키를 지워요.' : '지우면 따로 정하지 않은 프로그램에서는 학원 AI 를 쓸 수 없고, 각자 자기 키를 넣어서 써야 해요.',
      ok: p ? '기본 AI 사용' : '지우기',
      danger: !p,
      onOk: () => this.putAi(p ? p.id : '', null),
    });
    if (ok) toast(p ? `${p.name}은(는) 이제 기본 AI 를 써요` : '기본 AI 를 지웠어요', 'success');
    else if (p) this.renderApps(); // 고른 것을 되돌림
  }
}
