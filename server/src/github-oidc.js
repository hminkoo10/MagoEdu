'use strict';

// GitHub Actions 서명만 신뢰한다. 토큰 안의 jku/x5u 주소는 사용하지 않는다.
const crypto = require('node:crypto');
const { HttpError } = require('./util');

const ISSUER = 'https://token.actions.githubusercontent.com';
const SKEW = 30; // 서버 시계 오차 (초)
const CACHE_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function githubOidc(config) {
  const fetchKeys = config.githubOidcFetch || fetch;
  let keys = new Map();
  let checkedAt = -Infinity;
  let expiresAt = 0;
  let pending = null;

  async function keyFor(kid) {
    const now = Date.now();
    if ((!keys.has(kid) || now >= expiresAt) && !pending && now - checkedAt >= RETRY_MS) {
      checkedAt = now; // 실패해도 분당 한 번만 요청한다.
      pending = (async () => {
        const res = await fetchKeys(config.githubOidcJwksUrl, {
          signal: AbortSignal.timeout(5000), redirect: 'error',
        });
        if (!res.ok) throw new Error('JWKS 응답 실패');
        const body = await res.json();
        if (!object(body) || !Array.isArray(body.keys) || body.keys.length > 100) throw new Error('잘못된 JWKS');
        const next = new Map();
        for (const jwk of body.keys) {
          if (!object(jwk) || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.kid ||
              (jwk.alg !== undefined && jwk.alg !== 'RS256') || (jwk.use !== undefined && jwk.use !== 'sig') ||
              (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify'))) || jwk.d) continue;
          const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
          if (key.asymmetricKeyDetails.modulusLength < 2048 || next.has(jwk.kid)) throw new Error('잘못된 RSA 키');
          next.set(jwk.kid, key);
        }
        if (!next.size) throw new Error('서명 키가 없어요.');
        keys = next;
        expiresAt = Date.now() + CACHE_MS;
      })().finally(() => { pending = null; });
    }
    if (pending) await pending;
    if (Date.now() >= expiresAt || !keys.has(kid)) throw new Error('서명 키를 찾을 수 없어요.');
    return keys.get(kid);
  }

  return async (authorization) => {
    try {
      if (typeof authorization !== 'string' || authorization.length > 16384) throw new Error('잘못된 토큰');
      const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
      const parts = token?.split('.');
      if (parts?.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) throw new Error('잘못된 JWT');
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (!object(header) || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid ||
          header.kid.length > 256 || header.crit !== undefined || !object(claims)) throw new Error('잘못된 JWT');
      const now = Date.now() / 1000;
      if (claims.iss !== ISSUER || claims.aud !== 'mago.milky.kr' ||
          !['exp', 'nbf', 'iat'].every((k) => Number.isSafeInteger(claims[k]) && claims[k] >= 0) ||
          claims.exp <= now - SKEW || claims.nbf > now + SKEW || claims.iat > now + SKEW ||
          claims.exp <= claims.nbf || claims.exp <= claims.iat ||
          typeof claims.repository !== 'string' || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(claims.repository) ||
          (claims.ref !== 'refs/heads/main' && !/^refs\/(tags|heads\/release)\/[^\s]+$/.test(claims.ref || ''))) throw new Error('잘못된 클레임');
      const key = await keyFor(header.kid);
      if (!crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), {
        key, padding: crypto.constants.RSA_PKCS1_PADDING,
      }, Buffer.from(parts[2], 'base64url'))) throw new Error('서명 불일치');
      return claims;
    } catch {
      throw new HttpError(401, 'GitHub Actions 인증을 확인할 수 없어요.', 'invalid_oidc');
    }
  };
}

module.exports = { githubOidc };
