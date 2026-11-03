import { h, btn, toast, dialog, field, input, put } from './ui.js';

export async function editAcademyCode(cloud, qs = '') {
  const r = await cloud.api('GET', `/api/academy${qs}`);
  const code = input({ value: (r.academy || r).code || '', placeholder: '예: mago', maxlength: '8' });
  return dialog({
    title: '학원 코드 정하기',
    sub: '학생 아이디는 학원 코드 + 연월 + 번호로 만들어요. 예: mago2611001',
    body: field('학원 코드', code, '영문 소문자·숫자로 2~8자를 넣어 주세요. 다른 학원과 겹치지 않아야 해요.'),
    ok: '저장',
    onOk: async () => {
      const value = code.value.trim();
      if (!/^[a-z0-9]{2,8}$/.test(value)) throw new Error('학원 코드는 영문 소문자·숫자로 2~8자를 넣어 주세요.');
      await cloud.api('PATCH', `/api/academy${qs}`, { code: value });
      toast('학원 코드를 저장했어요', 'success');
    },
  });
}

export function credentialsCsv(rows) {
  const cell = (value) => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return '\uFEFF' + [['이름', '아이디', '임시 비밀번호'], ...rows.map((r) => [r.name, r.username, r.password])].map((row) => row.map(cell).join(',')).join('\r\n');
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function credentialsTable(rows) {
  return h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, ...['이름', '아이디', '임시 비밀번호'].map((t) => h('th', {}, t)))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, ...[r.name, r.username, r.password].map((v) => h('td', { class: 'selectable' }, v))))),
  );
}

export function printCredentials(rows) {
  const frame = h('iframe', { title: '학생 계정 인쇄', style: { position: 'fixed', width: '1px', height: '1px', border: '0', bottom: '0' } });
  document.body.append(frame);
  const doc = frame.contentDocument;
  doc.title = '학생 계정';
  const style = doc.createElement('style');
  style.textContent = 'body{font-family:sans-serif;padding:24px;color:#111}table{border-collapse:collapse;width:100%}th,td{border:1px solid #aaa;padding:10px;text-align:left}td{overflow-wrap:anywhere}thead{display:table-header-group}tr{break-inside:avoid}';
  doc.head.append(style);
  put(doc.body, h('h1', {}, '학생 계정'), h('p', {}, '임시 비밀번호로 처음 로그인하면 새 비밀번호를 정해야 해요.'), credentialsTable(rows));
  const cleanup = () => frame.remove();
  frame.contentWindow.addEventListener('afterprint', cleanup, { once: true });
  setTimeout(cleanup, 60000);
  frame.contentWindow.focus();
  frame.contentWindow.print();
}

const SKIP_REASON = {
  account_exists: '이미 계정이 있어요', already_exists: '이미 계정이 있어요',
  student_deleted: '삭제한 학생이에요', no_student: '학생을 찾지 못했어요',
};

export async function showCredentials({ created = [], skipped = [] }) {
  const print = btn('인쇄', { onClick: () => {
    try { printCredentials(created); } catch (e) { toast(e.message, 'error'); }
  } });
  const csv = btn('CSV 받기', { iconName: 'download', onClick: () => downloadBlob(new Blob([credentialsCsv(created)], { type: 'text/csv;charset=utf-8' }), '학생-계정.csv') });
  await dialog({
    title: `계정 ${created.length}개를 만들었어요`,
    sub: '임시 비밀번호는 지금 한 번만 보여요. 닫기 전에 인쇄하거나 CSV로 받아 주세요. 학생은 처음 로그인할 때 비밀번호를 바꿔야 해요.',
    wide: true,
    body: h('div', {},
      created.length ? h('div', { class: 'table-wrap' }, credentialsTable(created)) : h('p', {}, '새로 만든 계정이 없어요.'),
      skipped.length ? h('div', {}, h('h3', {}, `건너뛴 학생 ${skipped.length}명`), ...skipped.map((r) => h('p', {}, `${r.name} · ${SKIP_REASON[r.reason] || '계정을 만들지 못했어요'} (${r.reason})`))) : null,
    ),
    footLeft: created.length ? h('div', { class: 'right' }, print, csv) : null,
    ok: '닫기', cancel: null,
  });
}
