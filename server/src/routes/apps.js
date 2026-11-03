'use strict';

// 프로그램 목록, 내려받기, 실행 허가증(티켓), 프로그램 관리(운영자), 통합 클라우드 자동 업데이트

const fs = require('node:fs');
const crypto = require('node:crypto');
const { readJson, sendJson, send } = require('../http');
const { HttpError, bad, forbidden, notFound, intOr, str, randomToken } = require('../util');
const { signTicket } = require('../security');
const { publicRelease, sniffImageType, PLATFORMS } = require('../catalog');

const APP_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const RESERVED_IDS = ['events']; // /api/sync/events 와 겹침
const DL_SECONDS = 10 * 60; // 브라우저 내려받기 주소가 쓸 수 있는 시간
const DL_RE = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

function register(router, deps) {
  const { db, svc, catalog, keys } = deps;

  // ---------------- 브라우저 내려받기 주소 (dl) ----------------
  // 브라우저는 그냥 누르는 링크에 로그인 정보(Bearer)를 붙일 수 없어서, 로그인한 화면이 10분짜리 서명 주소를 받아 연다.
  // 서명은 서버만 아는 값으로 하고, 프로그램 ID와 버전에 묶는다.
  let dlSecret = svc.meta('download_link_secret');
  if (!dlSecret) {
    dlSecret = randomToken(32);
    svc.setMeta('download_link_secret', dlSecret);
  }
  const dlSign = (appId, version, exp) => crypto.createHmac('sha256', dlSecret).update(`dl1\n${appId}\n${version}\n${exp}`).digest('base64url');

  function dlToken(appId, version, now = Date.now()) {
    const exp = Math.floor(now / 1000) + DL_SECONDS;
    return { token: `${exp}.${dlSign(appId, version, exp)}`, expiresAt: exp * 1000 };
  }

  function dlValid(token, appId, version, now = Date.now()) {
    const m = DL_RE.exec(String(token || ''));
    if (!m) return false;
    const exp = Number(m[1]);
    const want = Buffer.from(dlSign(appId, version, exp));
    const got = Buffer.from(m[2]);
    return got.length === want.length && crypto.timingSafeEqual(got, want) && exp * 1000 >= now;
  }

  function forUser(app, user) {
    return {
      id: app.id,
      name: app.name,
      description: app.description,
      color: app.color,
      platform: app.platform,
      iconUrl: `/api/apps/${app.id}/icon`,
      exe: app.exe,
      autoLaunchDefault: app.autoLaunchDefault,
      coldStorage: app.coldStorage,
      release: publicRelease(app.release),
      allowed: svc.canUseApp(user, app.id),
    };
  }

  function usable(ctx) {
    const { user } = svc.authenticate(ctx);
    const app = catalog.get(ctx.params.id);
    if (!app || !app.enabled) throw notFound('프로그램을 찾을 수 없어요.');
    if (!svc.canUseApp(user, app.id)) throw forbidden('이 프로그램을 쓸 권한이 없어요. 원장님이나 운영자에게 문의해 주세요.');
    return { user, app };
  }

  // ---------------- 사용자 ----------------
  router.get('/api/apps', (ctx) => {
    const { user } = svc.authenticate(ctx);
    const apps = catalog
      .list()
      .map((a) => forUser(a, user))
      .filter((a) => a.allowed);
    return { apps };
  });

  router.get('/api/apps/:id/icon', async (ctx) => {
    const app = catalog.get(ctx.params.id);
    if (!app) throw notFound();
    const icon = await catalog.icon(app);
    if (!icon) throw notFound('아이콘이 없어요.');
    const buf = fs.readFileSync(icon.file);
    send(ctx.res, 200, buf, { 'content-type': sniffImageType(buf), 'cache-control': 'public, max-age=3600' });
    return undefined;
  });

  // 로그인 정보(Bearer) 또는 download-link 로 받은 dl 값
  router.get('/api/apps/:id/download', async (ctx) => {
    const dl = ctx.query.get('dl');
    let app;
    if (dl !== null && !ctx.req.headers.authorization) {
      app = catalog.get(ctx.params.id);
      if (!app || !app.enabled) throw notFound('프로그램을 찾을 수 없어요.');
      if (!dlValid(dl, app.id, str(ctx.query.get('version'), 30))) {
        throw new HttpError(403, '내려받기 주소를 쓸 수 있는 시간이 지났어요. 화면에서 다시 눌러 주세요.', 'invalid_link');
      }
    } else {
      ({ app } = usable(ctx));
    }
    const want = str(ctx.query.get('version'), 30);
    if (!app.release) throw notFound('아직 배포된 버전이 없어요.', 'no_release');
    if (want && want !== app.release.version) throw notFound(`그 버전은 받을 수 없어요. 지금 받을 수 있는 버전은 ${app.release.version} 이에요.`, 'no_release');
    await catalog.sendAsset(ctx.res, catalog.releaseAsset(app), ctx.req.method);
    return undefined;
  });

  /** 브라우저에서 바로 여는 내려받기 주소 (10분) → { url, expiresAt } */
  router.post('/api/apps/:id/download-link', (ctx) => {
    const { app } = usable(ctx);
    if (!app.release) throw notFound('아직 배포된 버전이 없어요.', 'no_release');
    const version = app.release.version;
    const { token, expiresAt } = dlToken(app.id, version);
    return {
      url: `/api/apps/${encodeURIComponent(app.id)}/download?version=${encodeURIComponent(version)}&dl=${token}`,
      expiresAt,
    };
  });

  router.post('/api/apps/:id/ticket', (ctx) => {
    const { user, app } = usable(ctx);
    if (app.platform !== 'windows') {
      throw new HttpError(400, '휴대폰용 프로그램은 통합 클라우드에서 켜지 않아요. 휴대폰에서 내려받아 설치해 주세요.', 'wrong_platform');
    }
    const days = svc.getSettings().ticketDays;
    const iat = Math.floor(Date.now() / 1000);
    const payload = {
      v: 1,
      typ: 'app',
      iss: svc.meta('server_id'),
      sub: user.uid,
      usr: user.username,
      nam: user.name,
      rol: user.role,
      aca: user.academy_id || null,
      app: app.id,
      dev: ctx.auth.session.device_id,
      iat,
      exp: iat + days * 24 * 60 * 60,
    };
    return { ticket: signTicket(keys, payload), expiresAt: payload.exp * 1000 };
  });

  // ---------------- 운영자: 프로그램 관리 ----------------
  function adminView(app) {
    return { ...app, release: publicRelease(app.release), iconPath: `/api/apps/${app.id}/icon` };
  }

  function parseApp(body, existing) {
    const out = {};
    if (!existing) {
      const id = str(body.id, 32);
      if (!APP_ID_RE.test(id)) throw bad('프로그램 ID는 영어 소문자로 시작하는 2~32자(소문자·숫자·-)여야 해요.');
      if (RESERVED_IDS.includes(id)) throw bad('이 ID는 쓸 수 없어요. 다른 ID를 정해 주세요.');
      out.id = id;
    }
    if (body.platform !== undefined || !existing) {
      const platform = body.platform === undefined ? 'windows' : String(body.platform);
      if (!PLATFORMS.includes(platform)) throw bad('플랫폼은 Windows 또는 안드로이드 중에서 골라 주세요.', 'invalid_platform');
      out.platform = platform;
    }
    if (body.name !== undefined || !existing) {
      out.name = str(body.name, 60);
      if (!out.name) throw bad('프로그램 이름을 입력해 주세요.');
    }
    if (body.description !== undefined) out.description = str(body.description, 300);
    if (body.enabled !== undefined) out.enabled = !!body.enabled;
    if (body.sort !== undefined) out.sort = intOr(body.sort, 0, -1000, 1000);
    if (body.iconUrl !== undefined) out.iconUrl = str(body.iconUrl, 500);
    if (body.exe !== undefined) out.exe = str(body.exe, 120);
    if (body.color !== undefined) out.color = /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : null;
    if (body.autoLaunchDefault !== undefined) out.autoLaunchDefault = !!body.autoLaunchDefault;
    if (body.coldStorage !== undefined) {
      out.coldStorage = {
        enabled: !!body.coldStorage.enabled,
        days: intOr(body.coldStorage.days, existing?.coldStorage.days ?? 30, 1, 3650),
      };
    }
    if (body.source !== undefined || !existing) {
      const s = body.source || {};
      if (s.type === 'github') {
        const repo = str(s.repo, 100);
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw bad('GitHub 저장소는 "주인/이름" 형태로 적어 주세요.');
        const asset = str(s.asset, 200);
        try {
          if (!/\(.+\)/.test(asset)) throw new Error('no group');
          new RegExp(asset); // eslint-disable-line no-new
        } catch {
          throw bad('파일 이름 규칙(정규식)에 버전을 담는 괄호 ( ) 가 있어야 해요.');
        }
        out.source = { type: 'github', repo, asset, ...(s.tagPrefix ? { tagPrefix: str(s.tagPrefix, 40) } : {}) };
      } else if (s.type === 'local' || !existing) {
        out.source = { type: 'local', ...(s.asset ? { asset: str(s.asset, 200) } : {}) };
      }
    }
    return out;
  }

  router.get('/api/admin/apps', (ctx) => {
    svc.requireRole(ctx, 'admin');
    return {
      apps: catalog.list({ includeDisabled: true }).map(adminView),
      launcher: catalog.launcher
        ? { version: catalog.launcher.version, setupName: catalog.launcher.setupName, publishedAt: catalog.launcher.publishedAt }
        : null,
      launcherError: catalog.launcherError,
    };
  });

  router.post('/api/admin/apps', async (ctx) => {
    svc.requireRole(ctx, 'admin');
    const fields = parseApp(await readJson(ctx.req), null);
    if (catalog.get(fields.id)) throw bad('이미 있는 프로그램 ID예요.');
    const app = catalog.upsert(fields);
    svc.audit(ctx, 'app.create', app.name);
    catalog.refreshApp(app.id).catch(() => {});
    return { app: adminView(app) };
  });

  router.patch('/api/admin/apps/:id', async (ctx) => {
    svc.requireRole(ctx, 'admin');
    const cur = catalog.get(ctx.params.id);
    if (!cur) throw notFound('프로그램을 찾을 수 없어요.');
    const fields = parseApp(await readJson(ctx.req), cur);
    const app = catalog.upsert({ ...fields, id: cur.id });
    svc.audit(ctx, 'app.update', app.name, fields);
    return { app: adminView(app) };
  });

  router.delete('/api/admin/apps/:id', (ctx) => {
    svc.requireRole(ctx, 'admin');
    const cur = catalog.get(ctx.params.id);
    if (!cur) throw notFound('프로그램을 찾을 수 없어요.');
    catalog.remove(cur.id);
    svc.audit(ctx, 'app.delete', cur.name);
    return { ok: true };
  });

  router.post('/api/admin/apps/refresh', async (ctx) => {
    svc.requireRole(ctx, 'admin');
    const body = await readJson(ctx.req);
    if (body.id) {
      const app = await catalog.refreshApp(String(body.id));
      if (!app) throw notFound('프로그램을 찾을 수 없어요.');
    } else {
      await catalog.refreshAll();
    }
    return {
      apps: catalog.list({ includeDisabled: true }).map(adminView),
      launcher: catalog.launcher ? { version: catalog.launcher.version, setupName: catalog.launcher.setupName } : null,
      launcherError: catalog.launcherError,
    };
  });

  // ---------------- 통합 클라우드 자동 업데이트 (electron-updater generic) ----------------
  router.get('/updates/launcher/latest.yml', async (ctx) => {
    const l = await catalog.freshLauncher();
    if (!l) throw notFound('아직 배포된 버전이 없어요.');
    send(ctx.res, 200, l.ymlText, { 'content-type': 'text/yaml; charset=utf-8' });
    return undefined;
  });

  router.get('/updates/launcher/:file', async (ctx) => {
    const l = catalog.launcher;
    const asset = l && l.assets[ctx.params.file];
    if (!asset) throw notFound('파일을 찾을 수 없어요.');
    await catalog.sendAsset(ctx.res, asset, ctx.req.method);
    return undefined;
  });

  router.get('/download/launcher', async (ctx) => {
    const l = catalog.launcher;
    if (!l) throw new HttpError(404, '아직 배포된 설치 파일이 없어요.', 'no_release');
    await catalog.sendAsset(ctx.res, l.assets[l.setupName], ctx.req.method);
    return undefined;
  });

  router.get('/api/launcher', () => {
    const l = catalog.launcher;
    return l ? { version: l.version, setupName: l.setupName, publishedAt: l.publishedAt, notes: l.notes } : { version: null };
  });

  // 공개 정보: 서버 이름·버전·티켓 확인용 공개 키
  router.get('/api/meta', (ctx) => {
    sendJson(ctx.res, 200, {
      name: '마고에듀 통합 클라우드',
      developer: '구현민',
      version: deps.version,
      build: deps.build,
      serverId: svc.meta('server_id'),
      keys: deps.trustKeys(),
      time: Date.now(),
    });
    return undefined;
  });
}

module.exports = { register };
