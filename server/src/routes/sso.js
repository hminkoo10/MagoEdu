'use strict';

// 웹 프로그램 로그인 (통합 클라우드 계정으로, 예: 마고 과목내비)
//
//   1) 웹 프로그램이 브라우저를 https://<클라우드>/#/sso?app=<ID>&state=<값> 으로 보낸다
//   2) 클라우드 웹 화면(로그인한 사람)이 POST /api/sso/authorize {appId, state}
//      → 60초짜리 일회용 코드 + 돌아갈 주소 <프로그램 주소>/api/auth/mago/callback?code=&state= (주소는 서버가 정함)
//   3) 웹 프로그램 서버가 POST /api/sso/token {appId, secret, code} (서버끼리, 앱 비밀값)
//      → 사용자 정보 + 그 프로그램 전용 세션 토큰 (학생 명단·학원 AI·내 정보만 쓸 수 있음.
//         로그아웃·비밀번호 초기화·사용 중지되면 같이 끊김)
//   PC 프로그램(매니페스트 sso)은 통합 클라우드가 자기 로그인으로 2)를 불러 코드만 넘긴다 (7일짜리 허가증은 넘기지 않음).
//
//   POST /api/admin/apps/:id/secret   앱 비밀값 새로 만들기 (운영자, 한 번만 보여 줌)

const crypto = require('node:crypto');
const { readJson } = require('../http');
const { HttpError, bad, forbidden, notFound, str, randomToken, sha256Hex } = require('../util');

const CODE_MS = 60 * 1000;
const MAX_CODES = 5000;

function register(router, deps) {
  const { db, svc, catalog } = deps;
  const codes = new Map(); // sha256(코드) → { appId, userId, exp }

  function sweep(now = Date.now()) {
    for (const [k, c] of codes) if (c.exp < now) codes.delete(k);
  }

  function webApp(appId) {
    const app = catalog.get(String(appId || ''));
    if (!app || !app.enabled || app.platform !== 'web' || !app.url) throw notFound('웹 프로그램을 찾을 수 없어요.', 'no_app');
    return app;
  }

  router.post('/api/sso/authorize', async (ctx) => {
    const { user } = svc.authenticate(ctx); // 웹 프로그램 전용 세션으로는 다른 프로그램에 로그인할 수 없음
    const body = await readJson(ctx.req);
    const app = webApp(body.appId);
    if (!svc.canUseApp(user, app.id)) throw forbidden('이 프로그램을 쓸 권한이 없어요. 원장님이나 운영자에게 문의해 주세요.');
    const state = str(body.state, 200);
    const now = Date.now();
    sweep(now);
    if (codes.size >= MAX_CODES) throw new HttpError(503, '잠시 뒤 다시 해 주세요.', 'busy');
    const code = `msc_${randomToken(32)}`;
    codes.set(sha256Hex(code), { appId: app.id, userId: user.id, exp: now + CODE_MS });
    const url = new URL('/api/auth/mago/callback', app.url);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    svc.audit(ctx, 'sso.authorize', app.name);
    return { code, redirect: url.toString(), expiresAt: now + CODE_MS };
  });

  router.post('/api/sso/token', async (ctx) => {
    const body = await readJson(ctx.req);
    const app = webApp(body.appId);
    const row = db.get('SELECT client_secret_hash FROM apps WHERE id = ?', app.id);
    const want = Buffer.from(row?.client_secret_hash || '', 'hex');
    const got = Buffer.from(sha256Hex(String(body.secret || '')), 'hex');
    if (!want.length || want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
      throw new HttpError(401, '앱 비밀값이 맞지 않아요.', 'invalid_client');
    }
    const key = sha256Hex(String(body.code || ''));
    const c = codes.get(key);
    codes.delete(key); // 한 번만
    if (!c || c.exp < Date.now() || c.appId !== app.id) throw new HttpError(400, '로그인 코드가 맞지 않거나 시간이 지났어요. 다시 로그인해 주세요.', 'invalid_code');
    const user = db.get('SELECT * FROM users WHERE id = ?', c.userId);
    if (!user || user.status !== 'active') throw new HttpError(401, '사용할 수 없는 계정이에요.', 'account_suspended');
    if (!svc.canUseApp(user, app.id)) throw forbidden('이 프로그램을 쓸 권한이 없어요.');
    // 로그인마다 따로 (같은 기기 ID 면 예전 세션을 지우므로)
    const token = svc.createSession(user, { id: `app-${app.id}-${randomToken(9)}`, name: app.name, platform: 'web-app' }, ctx.ip, { appId: app.id });
    svc.audit({ ...ctx, auth: { user } }, 'sso.login', app.name, null, user.academy_id);
    return { token, user: svc.publicUser(user) };
  });

  router.post('/api/admin/apps/:id/secret', (ctx) => {
    svc.requireRole(ctx, 'admin');
    const app = catalog.get(ctx.params.id);
    if (!app) throw notFound('프로그램을 찾을 수 없어요.');
    if (app.platform !== 'web') throw bad('앱 비밀값은 웹 프로그램에만 있어요.', 'wrong_platform');
    const secret = `mgs_${randomToken(32)}`;
    db.run('UPDATE apps SET client_secret_hash = ?, updated_at = ? WHERE id = ?', sha256Hex(secret), Date.now(), app.id);
    // 예전 비밀값으로 받은 세션은 그대로 둔다 (사람들이 갑자기 로그아웃되지 않게)
    svc.audit(ctx, 'app.secret', app.name);
    return { secret };
  });
}

module.exports = { register };
