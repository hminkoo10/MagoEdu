'use strict';

// 아주 작은 라우터와 응답 도우미 (외부 라이브러리 없이)

const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./util');

class Router {
  constructor() {
    this.routes = [];
  }

  /** pattern 의 :이름 은 한 단계, 맨 끝의 /* 는 나머지 전부 (params.rest, 비어 있을 수 있음) */
  on(method, pattern, handler) {
    const keys = [];
    const rest = pattern.endsWith('/*');
    const body = (rest ? pattern.slice(0, -2) : pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_m, k) => {
      keys.push(k);
      return '([^/]+)';
    });
    if (rest) keys.push('rest');
    const re = new RegExp(`^${body}${rest ? '(?:/(.*))?$' : '/?$'}`);
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  get(p, h) {
    return this.on('GET', p, h);
  }
  post(p, h) {
    return this.on('POST', p, h);
  }
  put(p, h) {
    return this.on('PUT', p, h);
  }
  patch(p, h) {
    return this.on('PATCH', p, h);
  }
  delete(p, h) {
    return this.on('DELETE', p, h);
  }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = k === 'rest' ? m[i + 1] || '' : decodeURIComponent(m[i + 1]);
      });
      return { handler: r.handler, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8', ...headers });
}

function sendError(res, err) {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message, ...(err.extra || {}) } });
    return;
  }
  sendJson(res, 500, { error: { code: 'server_error', message: '서버에서 문제가 생겼어요. 잠시 뒤 다시 해 주세요.' } });
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '보낸 내용이 너무 커요.', 'too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, '요청 형식이 올바르지 않아요.', 'invalid_json');
  }
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, dir, rel) {
  const file = path.resolve(dir, rel);
  if (!file.startsWith(path.resolve(dir) + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  // 글꼴은 거의 안 바뀌니 일주일 보관, 나머지는 매번 새 버전인지 확인 (배포하면 바로 바뀌게).
  // private: Cloudflare 가 no-cache 를 '브라우저에 4시간 보관'으로 바꿔 버리지 않게
  const cacheControl = ext === '.woff2' ? 'public, max-age=604800' : 'private, no-cache';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': cacheControl });
    res.end();
    return true;
  }
  const headers = {
    'content-type': STATIC_MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': cacheControl,
    etag,
  };
  if (ext === '.html') {
    // 다른 사이트가 이 화면을 틀(iframe)에 넣지 못하게
    headers['x-frame-options'] = 'DENY';
    headers['content-security-policy'] = "frame-ancestors 'none'";
    headers['referrer-policy'] = 'same-origin';
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
  return true;
}

module.exports = { Router, send, sendJson, sendError, readBody, readJson, clientIp, serveStatic };
