// 서버 설정 (운영자): 기본 저장 공간, 인터넷 없이 쓸 수 있는 기간, 자동 로그아웃 기간, 현황
import { errorText, h, ic, btn, busy, toast, field, input, bytes, date, confirmDialog, reveal, put } from '../ui.js';

export class ServerView {
  constructor({ cloud }) {
    this.cloud = cloud;
    this.stats = h('div', { class: 'card' });
    this.form = h('div', { class: 'card' });
    this.webhook = h('div', { class: 'card stack' });
    this.el = h(
      'div',
      {},
      h('div', { class: 'page-head' }, h('div', { class: 'tt' }, h('h1', { class: 'title' }, '서버 설정'), h('div', { class: 'subtitle' }, '기본값은 모든 계정에 적용돼요.'))),
      h('div', { class: 'stack' }, this.stats, this.form, this.webhook),
    );
    this.load();
  }

  async load() {
    try {
      const [st, se] = await Promise.all([this.cloud.api('GET', '/api/admin/stats'), this.cloud.api('GET', '/api/admin/settings')]);
      this.renderStats(st);
      this.renderForm(se.settings);
      await this.renderWebhook();
    } catch (e) {
      put(this.stats, h('div', { class: 'muted' }, errorText(e)));
    }
  }

  async renderWebhook() {
    const r = await this.cloud.api('GET', '/api/admin/inquiry-webhook');
    const url = input({ type: 'password', autocomplete: 'off', placeholder: r.set ? '바꿀 때만 새 주소를 넣으세요.' : 'https://discord.com/api/webhooks/…' });
    const action = (label, iconName, method, suffix = '') => btn(label, { iconName, onClick: async () => {
      try {
        await this.cloud.api(method, `/api/admin/inquiry-webhook${suffix}`, method === 'PUT' ? { url: url.value } : undefined);
        url.value = '';
        toast(suffix ? '시험 알림을 요청했어요.' : '저장했어요.', 'success');
        await this.renderWebhook();
      } catch (e) { toast(errorText(e), 'error'); }
    } });
    put(this.webhook, h('h2', { class: 'card-title' }, ic('bell', 18), '문의 알림'),
      h('div', { class: 'muted' }, r.set ? `디스코드 알림이 켜져 있어요 (${r.hint})` : '디스코드 알림이 꺼져 있어요. 주소를 넣으면 새 문의를 알려요.'),
      field('디스코드 웹훅 주소', url),
      h('div', { class: 'inquiry-actions' }, action('저장', 'check', 'PUT'), action('지우기', 'trash', 'DELETE'), action('시험 보내기', 'right', 'POST', '/test')));
  }

  renderStats(s) {
    const stat = (k, v) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
    const run = btn('지금 정리', { size: 'sm' });
    run.addEventListener('click', async () => {
      if (!(await confirmDialog('오래 안 쓴 데이터를 지금 정리할까요?', '보관 기간이 지난 데이터를 서버에서 지워요. 자동 정리는 6시간마다 실행해요.', '정리'))) return;
      await busy(run, async () => {
        const r = await this.cloud.api('POST', '/api/admin/cold-storage/run', {});
        toast(r.groups ? `${r.groups}묶음(${bytes(r.bytes)})을 정리했어요` : '정리할 데이터가 없어요', 'success');
        this.load();
      });
    });
    put(this.stats, 
      h('div', { style: { display: 'flex', alignItems: 'center' } }, h('h2', { class: 'card-title', style: { flex: 1 } }, ic('server', 18), '현황'), h('span', { class: 'subtle' }, `서버 버전 ${s.server.version} · ${date(s.server.startedAt, true)}부터 실행 중`)),
      h('div', { style: { height: '12px' } }),
      h(
        'div',
        { class: 'stat-grid' },
        stat('학원', `${s.academies}곳`),
        stat('원장', `${s.users.director}명`),
        stat('선생님', `${s.users.teacher}명`),
        stat('운영자', `${s.users.admin}명`),
        stat('사용 중지', `${s.users.suspended}명`),
        stat('로그인한 기기', `${s.devices}대`),
        stat('개인 보관 데이터', bytes(s.storage.bytes)),
        stat('학원 공간 데이터', bytes(s.storage.sharedBytes || 0)),
        stat('실제 저장 용량', bytes(s.storage.diskBytes)),
      ),
      h('div', { class: 'row', style: { marginTop: '10px', borderBottom: 0 } }, h('div', { class: 'grow' }, h('div', { class: 'row-title' }, '서버에서 정리한 파일'), h('div', { class: 'row-desc' }, `보관 기간이 지나 컴퓨터에만 남은 파일 ${s.storage.evictedFiles}개`)), run),
    );
    reveal(this.stats.querySelector('.stat-grid'));
  }

  renderForm(set) {
    const quota = input({ type: 'number', min: '0', value: set.defaultQuotaMb });
    const academyQuota = input({ type: 'number', min: '0', value: set.defaultAcademyQuotaMb });
    const ticket = input({ type: 'number', min: '1', max: '90', value: set.ticketDays });
    const session = input({ type: 'number', min: '1', max: '365', value: set.sessionDays });
    const audit = input({ type: 'number', min: '30', value: set.auditKeepDays });
    const save = btn('저장', { variant: 'primary' });
    save.addEventListener('click', () =>
      busy(save, async () => {
        try {
          await this.cloud.api('PATCH', '/api/admin/settings', {
            defaultQuotaMb: Number(quota.value),
            defaultAcademyQuotaMb: Number(academyQuota.value),
            ticketDays: Number(ticket.value),
            sessionDays: Number(session.value),
            auditKeepDays: Number(audit.value),
          });
          toast('저장했어요', 'success');
        } catch (e) {
          toast(errorText(e), 'error');
        }
      }),
    );
    put(this.form, 
      h('h2', { class: 'card-title' }, ic('sliders', 18), '기본값'),
      h('div', { style: { height: '8px' } }),
      h(
        'div',
        { class: 'grid2', style: { gap: '4px 16px' } },
        field('계정마다 서버 저장 공간 (MB)', quota, '개별 설정이 없을 때 적용. 0은 무제한.'),
        field('학원마다 학원 공간 (MB)', academyQuota, '학원 공용 공간. 개별 설정이 없을 때 적용. 0은 무제한.'),
        field('인터넷 없이 쓸 수 있는 기간 (일)', ticket, ''),
        field('자동 로그아웃 (일)', session, '사용하지 않은 기기만 로그아웃돼요.'),
        field('활동 기록 보관 (일)', audit),
      ),
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '18px' } }, save),
    );
  }
}
