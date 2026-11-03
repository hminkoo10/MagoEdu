'use strict';

const { githubOidc } = require('../github-oidc');
const { bad } = require('../util');

const BODY_LIMIT = 128 * 1024; // latest.yml 64 KB + JSON 이스케이프·메타데이터
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeName = (v) => typeof v === 'string' && v.length <= 255 && /^[A-Za-z0-9]/.test(v) &&
  !/[^A-Za-z0-9._+-]/.test(v) && !v.includes('..');

// 초과한 본문은 저장하지 않는다. 소켓을 바로 끊지 않아 400 응답을 받을 수 있다.
function readRelease(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        chunks.length = 0;
        reject(bad('릴리스 알림은 128 KB 이하여야 해요.'));
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > BODY_LIMIT) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(bad('요청 형식이 올바르지 않아요.', 'invalid_json')); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(bad('본문 전송이 끊겼어요.')));
  });
}

function validateRelease(body) {
  if (!object(body) || Object.keys(body).some((k) => !['tag', 'version', 'notes', 'assets', 'latestYml'].includes(k)) ||
      typeof body.version !== 'string' || body.version.trim() !== body.version || !/^\d+\.\d+\.\d+$/.test(body.version) ||
      !body.version.split('.').every((n) => Number.isSafeInteger(Number(n))) ||
      !safeName(body.tag) || body.tag.length > 128 || typeof body.notes !== 'string' ||
      !Array.isArray(body.assets) || !body.assets.length || body.assets.length > 256 ||
      (body.latestYml !== undefined && (typeof body.latestYml !== 'string' || !body.latestYml.trim() ||
        Buffer.byteLength(body.latestYml) > 64 * 1024))) throw bad('릴리스 알림 형식이 올바르지 않아요.');
  const names = new Set();
  for (const a of body.assets) {
    if (!object(a) || Object.keys(a).some((k) => !['name', 'size', 'sha256'].includes(k)) ||
        !safeName(a.name) || names.has(a.name) || !Number.isSafeInteger(a.size) || a.size < 0 ||
        typeof a.sha256 !== 'string' || a.sha256.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(a.sha256)) throw bad('릴리스 파일 정보가 올바르지 않아요.');
    names.add(a.name);
  }
  return body;
}

function register(router, { config, catalog, svc }) {
  const verify = githubOidc(config);
  router.post('/api/ci/releases', async (ctx) => {
    const { repository } = await verify(ctx.req.headers.authorization);
    if (!/^application\/json(?:\s*;|$)/i.test(ctx.req.headers['content-type'] || '')) throw bad('JSON 본문이 필요해요.');
    const body = validateRelease(await readRelease(ctx.req));
    const updated = catalog.acceptCiRelease(repository, body);
    svc.audit({ ...ctx, actorLabel: `GitHub Actions (${repository})` }, 'release.ci', repository,
      { repo: repository, version: body.version, updated });
    return { updated };
  });
}

module.exports = { register };
