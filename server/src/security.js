'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// 비밀번호 (scrypt)
// ---------------------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function verifyPassword(password, stored) {
  try {
    const [kind, n, r, p, saltB64, keyB64] = String(stored).split('$');
    if (kind !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64url');
    const key = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64url'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// 없는 아이디로 로그인할 때도 시간이 비슷하게 걸리도록
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

// ---------------------------------------------------------------------------
// 시도 횟수 제한 (메모리)
// ---------------------------------------------------------------------------

class RateLimiter {
  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  _entry(key, now) {
    let e = this.hits.get(key);
    if (!e || now - e.start > this.windowMs) {
      e = { start: now, count: 0 };
      this.hits.set(key, e);
    }
    return e;
  }

  /** 막혔으면 다시 시도할 수 있을 때까지 남은 초, 아니면 0 */
  blocked(key, now = Date.now()) {
    const e = this._entry(key, now);
    if (e.count < this.max) return 0;
    return Math.ceil((e.start + this.windowMs - now) / 1000);
  }

  hit(key, now = Date.now()) {
    this._entry(key, now).count += 1;
    if (this.hits.size > 10000) this.sweep(now);
  }

  reset(key) {
    this.hits.delete(key);
  }

  sweep(now = Date.now()) {
    for (const [k, e] of this.hits) if (now - e.start > this.windowMs) this.hits.delete(k);
  }
}

// ---------------------------------------------------------------------------
// 실행 허가증(티켓) 서명 키 (Ed25519)
//   서버만 비밀 키를 가지고, 통합 클라우드 프로그램과 각 앱은 공개 키로 확인한다.
// ---------------------------------------------------------------------------

function loadOrCreateSigningKey(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ticket-ed25519.pem');
  let privateKey;
  if (fs.existsSync(file)) {
    privateKey = crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
  } else {
    ({ privateKey } = crypto.generateKeyPairSync('ed25519'));
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const x = publicKey.export({ format: 'jwk' }).x; // 32바이트 공개 키 (base64url)
  const kid = crypto.createHash('sha256').update(Buffer.from(x, 'base64url')).digest('hex').slice(0, 16);
  return { privateKey, publicKey, x, kid };
}

const TICKET_PREFIX = 'MGT1';

function signTicket(key, payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, kid: key.kid })).toString('base64url');
  const signed = `${TICKET_PREFIX}.${body}`;
  const sig = crypto.sign(null, Buffer.from(signed), key.privateKey).toString('base64url');
  return `${signed}.${sig}`;
}

/** 서버 쪽 확인용 (앱 쪽 확인은 sdk/ 참고) */
function verifyTicket(publicKeys, ticket, now = Date.now()) {
  const parts = String(ticket || '').split('.');
  if (parts.length !== 3 || parts[0] !== TICKET_PREFIX) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const k = publicKeys.find((p) => p.kid === payload.kid);
  if (!k) return null;
  const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x }, format: 'jwk' });
  const ok = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), pub, Buffer.from(parts[2], 'base64url'));
  if (!ok) return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null;
  return payload;
}

module.exports = {
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
  RateLimiter,
  loadOrCreateSigningKey,
  signTicket,
  verifyTicket,
  TICKET_PREFIX,
};
