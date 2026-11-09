'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('../http');
const { HttpError, bad, notFound, forbidden } = require('../util');
const { webhookUrl } = require('../inquiries');

function register(router, { db, svc, events, inquiries: photos, config }) {
  const row = id => db.get('SELECT * FROM inquiries WHERE id = ?', Number(id));
  function access(ctx) {
    const { user } = svc.authenticate(ctx);
    const inquiry = row(ctx.params.id);
    if (!inquiry || (user.role !== 'admin' && inquiry.user_id !== user.id)) throw notFound();
    return { user, inquiry };
  }
  function publicInquiry(i, user) {
    const last = db.get('SELECT from_admin FROM inquiry_messages WHERE inquiry_id = ? ORDER BY id DESC LIMIT 1', i.id);
    const admin = user.role === 'admin';
    const unread = !!last && !!last.from_admin !== admin && i.last_message_at > (admin ? i.admin_seen_at || 0 : i.owner_seen_at || 0);
    const owner = admin && db.get('SELECT name FROM users WHERE id = ?', i.user_id);
    return { id: i.id, title: i.title, status: i.closed_at ? 'closed' : last?.from_admin ? 'answered' : 'open', lastMessageAt: i.last_message_at, unread,
      createdAt: i.created_at, closedAt: i.closed_at, ...(admin ? { senderName: owner?.name || '', role: i.role, academyName: svc.academyName(i.academy_id) || '', client: i.client } : {}) };
  }
  function list(user) {
    return (user.role === 'admin' ? db.all('SELECT * FROM inquiries') : db.all('SELECT * FROM inquiries WHERE user_id = ?', user.id)).map(i => publicInquiry(i, user));
  }
  function fields(body, first) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    const ids = body.photoIds === undefined ? [] : body.photoIds;
    if (!Array.isArray(ids) || ids.length > 3 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) throw bad('사진은 3장까지 붙일 수 있어요.');
    if (first && (!title || title.length > 100)) throw bad('제목은 1~100자로 쓰세요.');
    if (text.length > 2000 || (!text && (first || !ids.length))) throw bad('내용은 1~2000자로 쓰세요.');
    return { title, text, ids };
  }
  function rate(user) {
    if (user.role !== 'admin' && db.get('SELECT COUNT(*) AS n FROM inquiry_messages WHERE author_id = ? AND created_at > ?', user.id, Date.now() - 60000).n >= 5) throw new HttpError(429, '잠시 뒤 다시 보내 주세요.', 'too_many');
  }
  function add(i, user, f, now) {
    for (const id of f.ids) if (!db.get('SELECT 1 FROM inquiry_photos WHERE id = ? AND user_id = ? AND inquiry_id IS NULL', id, user.id)) throw bad('붙일 수 없는 사진이에요.');
    const mid = db.run('INSERT INTO inquiry_messages(inquiry_id, author_id, from_admin, body, created_at, photo_count) VALUES (?, ?, ?, ?, ?, ?)', i.id, user.id, user.role === 'admin' ? 1 : 0, f.text, now, f.ids.length).lastInsertRowid;
    for (const id of f.ids) db.run('UPDATE inquiry_photos SET inquiry_id = ?, message_id = ? WHERE id = ?', i.id, mid, id);
    db.run(`UPDATE inquiries SET updated_at = ?, last_message_at = ?, ${user.role === 'admin' ? 'admin_seen_at' : 'owner_seen_at'} = ?${user.role === 'admin' ? '' : ', closed_at = NULL'} WHERE id = ?`, now, now, now, i.id);
  }
  router.get('/api/inquiries/unread', ctx => {
    const { user } = svc.authenticate(ctx);
    return { count: list(user).filter(i => i.unread).length };
  });
  router.get('/api/inquiries', ctx => {
    const { user } = svc.authenticate(ctx);
    let all = list(user);
    const filter = ctx.query.get('status');
    if (filter && user.role === 'admin') {
      if (!['open', 'answered', 'closed'].includes(filter)) throw bad('상태를 확인하세요.');
      all = all.filter(i => i.status === filter);
    }
    const rank = i => ({ open: 0, answered: 2, closed: 3 })[i.status] + (i.status === 'open' && !i.unread ? 1 : 0);
    all.sort((a, b) => (user.role === 'admin' ? rank(a) - rank(b) : 0) || b.lastMessageAt - a.lastMessageAt || b.id - a.id);
    return { inquiries: all };
  });
  router.post('/api/inquiries/photos', ctx => { const { user } = svc.authenticate(ctx); return photos.receive(ctx.req, user); });
  router.post('/api/inquiries', async ctx => {
    const { user, session } = svc.authenticate(ctx);
    if (user.role === 'admin') throw forbidden('운영자는 문의를 받는 쪽이에요.');
    const f = fields(await readJson(ctx.req), true);
    const id = db.tx(() => {
      rate(user);
      const now = Date.now();
      const client = session.platform === 'web' ? '웹' : `PC 앱 ${session.client_version || ''}`.trim();
      const id = db.run('INSERT INTO inquiries(user_id, academy_id, role, title, client, created_at, updated_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', user.id, user.academy_id, user.role, f.title, client, now, now, now).lastInsertRowid;
      add(row(id), user, f, now);
      return id;
    });
    const inquiry = row(id);
    events.publishInquiry(inquiry, 'created', user.role === 'admin');
    // Start delivery only once the successful HTTP response has been sent.
    ctx.res.once('finish', () => { void photos.notify(inquiry); });
    return { inquiry: publicInquiry(inquiry, user) };
  });
  router.get('/api/inquiries/:id', ctx => {
    const { user, inquiry: i } = access(ctx);
    db.run(`UPDATE inquiries SET ${user.role === 'admin' ? 'admin_seen_at' : 'owner_seen_at'} = ? WHERE id = ?`, Math.max(Date.now(), i.last_message_at), i.id);
    const messages = db.all('SELECT * FROM inquiry_messages WHERE inquiry_id = ? ORDER BY id', i.id).map(m => {
      const ids = db.all('SELECT id FROM inquiry_photos WHERE message_id = ? ORDER BY created_at, id', m.id).map(p => p.id);
      return { id: m.id, fromAdmin: !!m.from_admin, body: m.body, createdAt: m.created_at, photoIds: ids, photosExpired: ids.length < m.photo_count };
    });
    return { inquiry: publicInquiry(row(i.id), user), messages };
  });
  router.post('/api/inquiries/:id/messages', async ctx => {
    const { user, inquiry: i } = access(ctx);
    const f = fields(await readJson(ctx.req), false);
    db.tx(() => { rate(user); add(i, user, f, Math.max(Date.now(), i.last_message_at + 1)); });
    events.publishInquiry(row(i.id), 'message', user.role === 'admin');
    return { ok: true };
  });
  for (const action of ['close', 'reopen']) router.post(`/api/inquiries/:id/${action}`, ctx => {
    svc.requireRole(ctx, 'admin');
    const { user, inquiry: i } = access(ctx);
    db.run('UPDATE inquiries SET closed_at = ?, updated_at = ? WHERE id = ?', action === 'close' ? Date.now() : null, Date.now(), i.id);
    events.publishInquiry(i, 'status', true);
    return { inquiry: publicInquiry(row(i.id), user) };
  });
  router.get('/api/inquiries/:id/photos/:photoId', ctx => {
    const { inquiry: i } = access(ctx);
    const p = db.get('SELECT * FROM inquiry_photos WHERE id = ? AND inquiry_id = ?', ctx.params.photoId, i.id);
    if (!p) throw notFound();
    let bytes;
    try { bytes = fs.readFileSync(path.join(photos.dir, p.id)); } catch { throw notFound(); }
    ctx.res.writeHead(200, { 'content-type': p.mime, 'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'inline' });
    ctx.res.end(bytes);
  });
  router.get('/api/admin/inquiry-webhook', ctx => {
    svc.requireRole(ctx, 'admin');
    const value = svc.meta('inquiry_discord_webhook');
    if (!value) return { set: false, hint: '' };
    const u = webhookUrl(value, config.inquiryWebhookAllowLocal);
    return { set: true, hint: `${u.hostname}/…/${u.pathname.split('/')[3].slice(-4)}` };
  });
  router.put('/api/admin/inquiry-webhook', async ctx => {
    svc.requireRole(ctx, 'admin');
    const body = await readJson(ctx.req);
    const value = webhookUrl(body.url, config.inquiryWebhookAllowLocal).href;
    svc.setMeta('inquiry_discord_webhook', value);
    svc.audit(ctx, 'inquiry.webhook.set');
    return { ok: true };
  });
  router.delete('/api/admin/inquiry-webhook', ctx => {
    svc.requireRole(ctx, 'admin');
    db.run("DELETE FROM meta WHERE key = 'inquiry_discord_webhook'");
    svc.audit(ctx, 'inquiry.webhook.clear');
    return { ok: true };
  });
  router.post('/api/admin/inquiry-webhook/test', ctx => {
    svc.requireRole(ctx, 'admin');
    ctx.res.once('finish', () => { void photos.notify(null, true); });
    return { ok: true };
  });
}
module.exports = { register };
