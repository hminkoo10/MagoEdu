'use strict';

// 학원 AI 중계: 학원 AI 키는 서버에만 두고(원장·운영자도 끝 4자리만 봄), 프로그램이 보낸 AI 요청에 서버가 키를 붙여 대신 보낸다
//   GET|POST /api/ai/relay/<프로그램 ID>/<AI 주소 뒤쪽>
//     Gemini        …/v1beta/models/<모델>:generateContent · …/v1beta/models · …/v1beta/openai/chat/completions
//     OpenAI 호환   …/chat/completions · …/models
//     Claude        …/v1/messages · …/v1/models
//   프로그램은 AI 주소를 <서버>/api/ai/relay/<프로그램 ID> 로, 키 자리(Authorization: Bearer · x-goog-api-key · x-api-key)에
//   실행 허가증(PC 프로그램의 MAGOEDU_TICKET) 또는 그 웹 프로그램 전용 세션 토큰을 넣으면 요청·응답 모양은 그 AI 그대로 쓸 수 있다.
//   학원 AI 주소가 학원 안 주소(192.168.x.x 등)면 서버가 부를 수 없으니 GET /api/academy/ai 가 direct 로 알려 주고 각 PC 에서 바로 부른다.

const dns = require('node:dns');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { readBody, sendJson } = require('../http');
const { RateLimiter, verifyTicket } = require('../security');
const { HttpError, forbidden, notFound } = require('../util');

const MAX_BODY = 25 * 1024 * 1024; // 문항 그림 여러 장
const TIMEOUT_MS = 5 * 60 * 1000;

const UPSTREAM = {
  gemini: 'https://generativelanguage.googleapis.com',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

// 키로 할 수 있는 일 중 글·그림 생성과 모델 목록만 (파일 올리기·미세 조정 같은 것은 막음)
const PATHS = {
  gemini: [/^v1(beta)?\/models(\/[\w-][\w.-]*(:(generateContent|streamGenerateContent|countTokens))?)?$/, /^v1beta\/openai\/(chat\/completions|models)$/],
  openai: [/^(chat\/completions|models)$/],
  anthropic: [/^v1\/(messages|messages\/count_tokens|models)$/],
};

// 서버 안쪽·학원 안 주소 (서버가 대신 부르면 안 되는 곳: 클라우드 메타데이터·같은 서버의 다른 서비스 …)
const PRIVATE = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
])
  PRIVATE.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
])
  PRIVATE.addSubnet(a, p, 'ipv6');

function privateIp(ip) {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (v4) return PRIVATE.check(v4, 'ipv4');
  if (net.isIPv4(ip)) return PRIVATE.check(ip, 'ipv4');
  return net.isIPv6(ip) ? PRIVATE.check(ip, 'ipv6') : false;
}

/** 이름만 보고 학원 안 주소인지 (localhost · *.local · 사설 IP …) */
function privateHost(host) {
  const h = String(host || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return privateIp(h);
  return h === 'localhost' || /\.(localhost|local|lan|internal|home|intranet)$/.test(h) || !h.includes('.');
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * 프로그램에 보여 주는 학원 AI (키는 빼고): relay 면 서버를 거쳐서, direct 면 baseUrl 로 각 PC 에서 바로 (키 없이)
 * c: students.aiFor() 결과 또는 null, allowPrivate: 시험용 — 서버 안쪽 주소도 중계 (config.aiRelayAllowPrivate)
 */
function publicAi(c, { allowPrivate = false } = {}) {
  if (!c) return null;
  const direct = !allowPrivate && !!c.baseUrl && privateHost(hostOf(c.baseUrl));
  return {
    provider: c.provider,
    model: c.model || '',
    model2: c.model2 || '',
    rpm: c.rpm ?? null,
    source: c.source,
    hasKey: !!c.apiKey,
    ...(direct ? { direct: true, baseUrl: c.baseUrl } : { relay: true }),
  };
}

/** 키 자리에 넣은 값 (그 AI 의 SDK 가 넣는 자리 어디든) */
function credential(headers) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(String(headers.authorization || ''))?.[1];
  if (bearer) return bearer;
  if (headers['x-goog-api-key']) return String(headers['x-goog-api-key']).trim();
  if (headers['x-api-key']) return String(headers['x-api-key']).trim();
  throw new HttpError(401, '실행 허가증이나 로그인 토큰이 필요해요.', 'auth_required');
}

/** 학원 AI 주소 + 뒤쪽 → 보낼 주소 (막힌 주소면 던짐) */
function upstreamUrl(c, rest, query) {
  if (!PATHS[c.provider]?.some((re) => re.test(rest))) throw forbidden('학원 AI 로 할 수 없는 요청이에요.', 'relay_path');
  let base = String(c.baseUrl || UPSTREAM[c.provider]).replace(/\/+$/, '');
  if (c.provider === 'gemini') base = base.replace(/\/v1(beta)?$/, '');
  if (c.provider === 'anthropic') base = base.replace(/\/v1$/, '');
  const u = new URL(`${base}/${rest}`);
  for (const [k, v] of query) if (k !== 'key') u.searchParams.append(k, v); // 키를 주소에 넣는 Gemini 방식은 받지 않음
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(502, '학원 AI 주소가 올바르지 않아요.', 'relay_target');
  return u;
}

/** 그 AI 가 받는 방식으로 키를 붙임 (Gemini 의 OpenAI 호환 주소는 Bearer) */
function authHeaders(c, rest) {
  const key = String(c.apiKey || '');
  if (!key) return {};
  if (c.provider === 'anthropic') return { 'x-api-key': key };
  if (c.provider === 'gemini' && !rest.startsWith('v1beta/openai/')) return { 'x-goog-api-key': key };
  return { authorization: `Bearer ${key}` };
}

const PASS_REQ = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta'];

function register(router, deps) {
  const { db, svc, students, keys, config, log } = deps;
  const limiter = new RateLimiter({ max: config.aiRelayPerTenMinutes || 600, windowMs: 10 * 60 * 1000 });

  /** 누가 어느 프로그램으로 부르는지 → 사용자 (실행 허가증이면 그 프로그램 것만, 웹 프로그램 세션도 자기 프로그램만) */
  function identify(ctx, appId, token) {
    let user;
    if (token.startsWith('MGT1.')) {
      const p = verifyTicket([keys], token);
      if (!p || p.typ !== 'app' || p.app !== appId) throw new HttpError(401, '실행 허가가 확인되지 않았어요. 통합 클라우드에서 다시 켜 주세요.', 'ticket_invalid');
      user = db.get('SELECT * FROM users WHERE uid = ?', String(p.sub));
      if (!user) throw new HttpError(401, '계정이 삭제되었어요.', 'session_invalid');
      if (user.status !== 'active') throw new HttpError(401, '사용이 중지된 계정이에요. 원장님이나 운영자에게 문의해 주세요.', 'account_suspended');
      // 그 컴퓨터의 통합 클라우드 로그인이 살아 있을 때만 (로그아웃·비밀번호 재설정·다른 곳에서 끊으면 같이 끊김)
      if (!db.get('SELECT 1 FROM sessions WHERE user_id = ? AND device_id = ? AND app_id IS NULL AND expires_at > ?', user.id, String(p.dev || ''), Date.now())) {
        throw new HttpError(401, '통합 클라우드 로그인이 끝났어요. 통합 클라우드에 다시 로그인해 주세요.', 'session_invalid');
      }
    } else {
      const auth = svc.authenticate(ctx, { app: true, token });
      if (auth.session.app_id && auth.session.app_id !== appId) throw forbidden('이 로그인으로는 쓸 수 없는 프로그램이에요.', 'app_session');
      user = auth.user;
    }
    const app = db.get('SELECT id, enabled FROM apps WHERE id = ?', appId);
    if (!app || !app.enabled) throw notFound('프로그램을 찾을 수 없어요.');
    if (!svc.canUseApp(user, appId)) throw forbidden('이 프로그램을 쓸 권한이 없어요.');
    if (!user.academy_id) throw notFound('학원에 속한 계정만 학원 AI 를 쓸 수 있어요.', 'no_academy');
    return user;
  }

  /** 서버 안쪽 주소로는 보내지 않음 (주소 이름을 풀 때마다 확인 — 이름을 바꿔치기해도) */
  const lookup = (hostname, options, cb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const ok = config.aiRelayAllowPrivate ? addrs : addrs.filter((a) => !privateIp(a.address));
      if (!ok.length) return cb(Object.assign(new Error('private address'), { code: 'EPRIVATE' }));
      if (options.all) return cb(null, ok);
      return cb(null, ok[0].address, ok[0].family);
    });
  };

  async function relay(ctx) {
    const appId = ctx.params.appId;
    const token = credential(ctx.req.headers);
    const user = identify(ctx, appId, token);
    const c = students.aiFor(user.academy_id, appId);
    if (!c) throw notFound('학원 AI 가 아직 없어요. 원장님이 통합 클라우드의 학원 AI 에서 정하면 쓸 수 있어요.', 'no_academy_ai');
    const rest = ctx.params.rest;
    const target = upstreamUrl(c, rest, ctx.query);
    const literal = target.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literal) && privateIp(literal) && !config.aiRelayAllowPrivate) {
      throw forbidden('학원 AI 주소가 학원 안 주소라 서버가 대신 부를 수 없어요. 각 PC 에서 바로 불러 주세요.', 'private_target');
    }
    const key = `${user.id}:${appId}`;
    const wait = limiter.blocked(key);
    if (wait) throw new HttpError(429, 'AI 요청이 너무 많아요. 잠시 뒤 다시 해 주세요.', 'rate_limited', { retryAfter: wait });
    limiter.hit(key);
    const body = ctx.req.method === 'POST' ? await readBody(ctx.req, MAX_BODY) : null;
    const headers = { ...authHeaders(c, rest), 'user-agent': 'MagoEdu-AI-Relay' };
    for (const h of PASS_REQ) if (ctx.req.headers[h]) headers[h] = ctx.req.headers[h];
    if (body) headers['content-length'] = String(body.length);

    await new Promise((resolve) => {
      const mod = target.protocol === 'https:' ? https : http;
      const up = mod.request(target, { method: ctx.req.method, headers, lookup, timeout: TIMEOUT_MS }, (res) => {
        const out = { 'content-type': res.headers['content-type'] || 'application/json', 'cache-control': 'no-store' };
        if (res.headers['retry-after']) out['retry-after'] = res.headers['retry-after'];
        ctx.res.writeHead(res.statusCode || 502, out);
        res.pipe(ctx.res);
        res.on('end', resolve);
        res.on('error', () => {
          ctx.res.destroy();
          resolve();
        });
      });
      up.on('timeout', () => up.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      up.on('error', (err) => {
        if (!ctx.res.headersSent) {
          const priv = err.code === 'EPRIVATE';
          sendJson(ctx.res, priv ? 403 : 502, {
            error: priv
              ? { code: 'private_target', message: '학원 AI 주소가 학원 안 주소라 서버가 대신 부를 수 없어요. 각 PC 에서 바로 불러 주세요.' }
              : { code: 'relay_failed', message: err.code === 'ETIMEDOUT' ? '학원 AI 가 시간 안에 답하지 않았어요.' : '학원 AI 에 연결하지 못했어요.' },
          });
        } else ctx.res.destroy();
        if (!err.code || !['EPRIVATE', 'ETIMEDOUT'].includes(err.code)) log.warn?.('[학원 AI 중계]', appId, err.message);
        resolve();
      });
      ctx.res.on('close', () => up.destroy()); // 프로그램이 그만두면 AI 요청도 끊음
      up.end(body || undefined);
    });
    return undefined;
  }

  router.get('/api/ai/relay/:appId/*', relay);
  router.post('/api/ai/relay/:appId/*', relay);
}

module.exports = { register, publicAi, privateHost };
