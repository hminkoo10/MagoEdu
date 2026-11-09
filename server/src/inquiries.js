'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError, bad } = require('./util');
const MAX_PHOTO = 5 * 1024 * 1024;
const ROLE = { director: '원장', teacher: '선생님', student: '학생', admin: '운영자' };

function webhookUrl(value, allowLocal = false) {
  const fail = () => { throw bad('디스코드 웹훅 주소만 넣을 수 있어요.'); };
  let u;
  try { u = new URL(value); } catch { return fail(); }
  const local = allowLocal && u.protocol === 'http:' && u.hostname === '127.0.0.1' && !!u.port;
  const explicitPort = /:\d+$/.test(String(value).split('/')[2] || '');
  if ((!local && !(u.protocol === 'https:' && ['discord.com', 'discordapp.com'].includes(u.hostname) && !u.port && !explicitPort)) ||
      u.username || u.password || u.search || u.hash || !/^\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/.test(u.pathname)) fail();
  return u;
}

function createInquiries({ db, config, svc, log }) {
  const dir = path.join(config.dataDir, 'inquiry-photos');
  fs.mkdirSync(dir, { recursive: true });
  const uploads = new Map();
  const uploading = new Map();
  function removeFiles(ids) {
    for (const id of ids) {
      if (!/^[a-f0-9]{48}$/.test(id)) continue;
      try { fs.rmSync(path.join(dir, id), { force: true }); } catch { log.warn('[문의] 사진 삭제 실패'); }
    }
  }
  function userPhotos(user) {
    return db.all('SELECT id FROM inquiry_photos WHERE (user_id = ? AND inquiry_id IS NULL) OR inquiry_id IN (SELECT id FROM inquiries WHERE user_id = ?)', user.id, user.id).map(p => p.id);
  }
  async function receive(req, user) {
    const now = Date.now();
    const recent = (uploads.get(user.id) || []).filter(t => t > now - 60000);
    if (recent.length >= 15) throw new HttpError(429, '잠시 뒤 다시 보내 주세요.', 'too_many');
    recent.push(now); uploads.set(user.id, recent);
    if (db.get('SELECT COUNT(*) AS n FROM inquiry_photos WHERE user_id = ? AND inquiry_id IS NULL', user.id).n + (uploading.get(user.id) || 0) >= 9) throw bad('대기 중인 사진이 많아요. 먼저 문의를 보내세요.');
    uploading.set(user.id, (uploading.get(user.id) || 0) + 1);
    try {
      let size = 0;
      const chunks = [];
      // Do not destroy the request on overflow: the caller still needs a 413 response.
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > MAX_PHOTO) { req.resume(); throw new HttpError(413, '사진은 한 장 5MB까지 붙일 수 있어요.', 'too_large'); }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const mime = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
        : bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? 'image/jpeg'
        : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
      if (!size || !mime) throw bad('PNG, JPG, WEBP 사진을 붙이세요.');
      const id = crypto.randomBytes(24).toString('hex');
      fs.writeFileSync(path.join(dir, id), bytes, { flag: 'wx', mode: 0o600 });
      try { db.run('INSERT INTO inquiry_photos(id, user_id, mime, size, created_at) VALUES (?, ?, ?, ?, ?)', id, user.id, mime, size, now); }
      catch (e) { removeFiles([id]); throw e; }
      return { photo: { id } };
    } finally { uploading.set(user.id, uploading.get(user.id) - 1); }
  }
  function cleanup(now = Date.now()) {
    const ids = db.all(`SELECT p.id FROM inquiry_photos p LEFT JOIN inquiries i ON i.id = p.inquiry_id
      WHERE (p.inquiry_id IS NULL AND p.created_at < ?) OR i.closed_at < ?`, now - 3600000, now - 30 * 86400000).map(p => p.id);
    db.tx(() => { for (const id of ids) db.run('DELETE FROM inquiry_photos WHERE id = ?', id); });
    removeFiles(ids);
    for (const name of fs.readdirSync(dir)) {
      if (/^[a-f0-9]{48}$/.test(name) && !db.get('SELECT 1 FROM inquiry_photos WHERE id = ?', name) && fs.statSync(path.join(dir, name)).mtimeMs < now - 86400000) removeFiles([name]);
    }
    return ids.length;
  }
  async function notify(inquiry, test = false) {
    const value = svc.meta('inquiry_discord_webhook');
    if (!value) return;
    try {
      const url = webhookUrl(value, config.inquiryWebhookAllowLocal);
      const academy = inquiry?.academy_id && svc.academyName(inquiry.academy_id);
      const title = String(inquiry?.title || '').replace(/[\\`*_~|<>@\r\n]/g, ' ');
      const content = test ? '문의 알림 시험이에요.' : `새 문의 #${inquiry.id} · ${ROLE[inquiry.role]}${academy ? ` · ${academy}` : ''}\n제목: ${title}`;
      const res = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
      await res.body?.cancel();
      if (!res.ok) log.warn(`[문의] 디스코드 알림 실패 (상태 ${res.status})`);
    } catch (e) { log.warn(`[문의] 디스코드 알림 실패 (${e.name === 'TimeoutError' ? '시간 초과' : '전송 오류'})`); }
  }
  return { dir, receive, cleanup, removeFiles, userPhotos, notify };
}

module.exports = { createInquiries, webhookUrl, ROLE };
