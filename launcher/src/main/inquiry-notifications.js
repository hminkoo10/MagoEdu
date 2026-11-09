'use strict';
const ROLE = { director: '원장', teacher: '선생님', student: '학생', admin: '운영자' };
async function notifyInquiry({ event, cloud, Notification, window, navigate }) {
  if (cloud.user?.role !== 'admin' || event.fromAdmin || !['created', 'message'].includes(event.kind)) return;
  if (window?.isFocused() && cloud.viewingInquiry === event.id) return;
  const account = cloud.user;
  const { inquiries } = await cloud.api.get('/api/inquiries');
  const inquiry = inquiries.find(i => i.id === event.id);
  if (!inquiry) return;
  // List metadata does not mark the conversation seen.
  if (cloud.user !== account) return;
  const n = new Notification({ title: event.kind === 'created' ? '새 문의' : '새 답글', body: `#${event.id} · ${ROLE[inquiry.role] || ''}${inquiry.academyName ? ` · ${inquiry.academyName}` : ''}` });
  n.on('click', () => navigate(event.id));
  n.show();
}
module.exports = { notifyInquiry };
