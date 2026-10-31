'use strict';

// 실행 허가증(티켓)과 서버 공개 키(trust.json)
//
// 각 프로그램은 통합 클라우드가 넘겨준 MAGOEDU_TICKET 을 trust.json 의 공개 키로 확인한 뒤에만 켜진다.
// (sdk/ 의 magoedu_cloud.py, magoedu-cloud.js 참고) 그래서 프로그램 파일만 따로 복사해 실행할 수는 없다.

const crypto = require('node:crypto');
const { readJson, writeJson } = require('./fsutil');

const PREFIX = 'MGT1';

function decodeTicket(ticket) {
  const parts = String(ticket || '').split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function verifyTicket(keys, ticket, { now = Date.now(), appId } = {}) {
  const payload = decodeTicket(ticket);
  if (!payload) return null;
  const k = (keys || []).find((x) => x.kid === payload.kid);
  if (!k) return null;
  const parts = ticket.split('.');
  let ok = false;
  try {
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x }, format: 'jwk' });
    ok = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), pub, Buffer.from(parts[2], 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null;
  if (appId && payload.app !== appId) return null;
  return payload;
}

async function writeTrust(file, { serverUrl, serverId, keys }) {
  const cur = await readJson(file, null);
  const next = { format: 1, serverUrl, serverId, keys, updatedAt: Date.now() };
  if (cur && cur.serverId === serverId && JSON.stringify(cur.keys) === JSON.stringify(keys) && cur.serverUrl === serverUrl) return cur;
  await writeJson(file, next);
  return next;
}

class TicketStore {
  constructor(file) {
    this.file = file;
  }

  async get(appId, keys) {
    const all = (await readJson(this.file, {})) || {};
    const t = all[appId];
    if (!t) return null;
    return verifyTicket(keys, t.ticket, { appId }) ? t : null;
  }

  async put(appId, ticket, expiresAt) {
    const all = (await readJson(this.file, {})) || {};
    all[appId] = { ticket, expiresAt, savedAt: Date.now() };
    await writeJson(this.file, all);
  }
}

module.exports = { decodeTicket, verifyTicket, writeTrust, TicketStore, PREFIX };
