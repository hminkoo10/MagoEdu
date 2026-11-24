const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { Cloud } = require('../src/main/cloud');
const { Store } = require('../src/main/store');
const { makePaths } = require('../src/core/paths');
const { normalizeManifest } = require('../src/core/manifest');

test('보기 실행: 폴더 분리·받기만·환경·paths와 쓰기 거절·종료 정리', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-view-'));
  const paths = makePaths({ userData: root, localData: path.join(root, 'local') });
  const c = new Cloud({ paths, store: new Store({ paths }), version: '1', log: { warn() {} } });
  c.user = { id: 'operator', role: 'admin', username: 'admin', name: '운영자' };
  c.apps = [{ id: 'notes', name: '오답노트', platform: 'windows' }];
  c.installed.notes = { manifest: normalizeManifest({ shared: { lazy: ['*.pdf'] }, viewOnly: true }) };
  const dirs = paths.account('operator').view(1, 'notes');
  assert.notEqual(dirs.root, paths.account('operator').view(2, 'notes').root);
  assert.notEqual(dirs.root, paths.account('operator').app('notes').root);
  const calls = []; let env;
  const content = Buffer.from('original'); const sha = crypto.createHash('sha256').update(content).digest('hex');
  c.api = {
    post: async (url, body) => {
      assert.ok(fs.existsSync(dirs.academyInfo), '학원 정보 생성 뒤 발급');
      assert.ok(calls.some(([, url]) => url.startsWith('/api/sync/')), '학원 공간 받은 뒤 발급');
      calls.push(['POST', url]); assert.equal(body.viewAcademy, 1); return { ticket: 'signed' }; },
    get: async (url) => { calls.push(['GET', url]); assert.match(url, /academy=1/);
      if (url.includes('/api/sync/')) return { full: true, seq: 1, entries: [{ path: 'a.pdf', rev: 1, seq: 1, sha256: sha, size: content.length }] };
      if (url.startsWith('/api/academy/members')) return { members: [] };
      if (url.startsWith('/api/students')) return { students: [], purged: [] };
      return { academy: { id: 1, name: '선택 학원' } };
    },
    download: async (url, dest) => { calls.push(['GET', url]); assert.match(url, /academy=1/); fs.writeFileSync(dest, content); },
    upload: () => assert.fail('PUT 금지'), del: () => assert.fail('DELETE 금지'),
  };
  c.runner = { isRunning: () => false, launch: (opts) => { assert.equal(calls.at(-1)[0], 'POST', '발급 바로 뒤 실행'); env = opts.env; } };
  t.after(async () => { for (const [id, v] of c.views) await c._cleanView(id, v); c.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(dirs.sync, { recursive: true });
  fs.writeFileSync(path.join(dirs.sync, 'stale.json'), '{}');
  await c.viewAcademy('notes', 1);
  assert.equal(fs.existsSync(paths.account('operator').tickets), false, '보기 허가증 보관 안 함');
  const view = c.views.get('notes'); clearInterval(view.timer);
  assert.equal(env.MAGOEDU_VIEW_ONLY, '1'); assert.equal(env.MAGOEDU_ACADEMY, '선택 학원');
  assert.equal(env.MAGOEDU_ACADEMY_ID, '1'); assert.equal(env.MAGOEDU_DATA_KEY, '');
  for (const [key, value] of Object.entries({ ACADEMY_DIR: dirs.academy, ACADEMY_INFO: dirs.academyInfo, REQUEST_DIR: dirs.requests, DATA_DIR: dirs.sync, LOCAL_DIR: dirs.local })) assert.equal(env['MAGOEDU_'+key], value);
  assert.deepEqual(fs.readdirSync(dirs.sync), []);
  assert.equal(JSON.parse(fs.readFileSync(dirs.academyInfo)).ai, null);
  for (const [rid, body] of Object.entries({ read: { paths: ['a.pdf'] }, remove: { remove: ['a.pdf'] }, op: { op: 'students.save', student: {} } })) fs.writeFileSync(path.join(dirs.requests, rid+'.json'), JSON.stringify(body));
  await c._viewRequests('notes', view);
  assert.equal(fs.readFileSync(path.join(dirs.academy, 'a.pdf')).toString(), 'original');
  for (const rid of ['remove','op']) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirs.requests, rid+'.done.json'))), { ok: false, error: '보기 전용이라 고칠 수 없어요.', errorCode: 'view_only' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.requests,'read.done.json'))).ok,true);
  fs.writeFileSync(path.join(dirs.academy,'a.pdf'),'local change');
  await view.engine.run();
  assert.equal(fs.readFileSync(path.join(dirs.academy,'a.pdf')).toString(),'original');
  assert.equal(calls.filter(([method]) => ['PUT','DELETE'].includes(method)).length,0);
  await assert.rejects(c.viewAcademy('notes',1), /먼저 닫아/);
  c._onAppExit('notes', { code: 75 });
  for (let i=0;i<100 && c.views.size;i++) await new Promise(r=>setTimeout(r,10));
  assert.equal(fs.existsSync(dirs.root),false);
  await c.viewAcademy('notes', 1);
  let running = true;
  c.runner = { isRunning: () => running, runningInfo: () => ({ userId: 'operator' }), stop: () => { running = false; return true; } };
  c.syncApp = async () => null;
  c.api.logout = async () => {};
  await c.logout();
  assert.equal(running, false);
  assert.equal(fs.existsSync(dirs.root), false);
  assert.equal(c.views.size, 0);
});

test('보기 단추: PC·운영자·shared·viewOnly, 옛 버전 안내, 이전 IPC 제거', () => {
  const file = path.join(__dirname,'../src/renderer/js/views/academies.js');
  const source = fs.readFileSync(file,'utf8').replace(/^import .*;$/gm,'').replace(/export class /g,'class ');
  const ctx = { h: (tag,opts,text) => ({text}), btn: (label, opts) => ({label,opts}) };
  vm.runInNewContext(source+';globalThis.View = AcademySettingsView;',ctx);
  const view = Object.create(ctx.View.prototype); view.isAdmin=true; view.store={state:{apps:[]}};
  assert.match(view.viewControl({id:1}).text,/설치/);
  view.store.state.apps=[{id:'notes',name:'오답노트',installed:{manifest:{shared:true,viewOnly:false}}}];
  assert.match(view.viewControl({id:1}).text,/업데이트/);
  view.store.state.apps[0].installed.manifest.viewOnly=true;
  assert.equal(view.viewControl({id:1}).label,'오답노트로 보기');
  view.store.state.web=true; assert.equal(view.viewControl({id:1}),null);
  view.store.state.web=false; view.isAdmin=false; assert.equal(view.viewControl({id:1}),null);
  for (const name of ['main/main.js','main/preload.js','renderer/js/web-cloud.js','renderer/js/app.js']) assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../src',name),'utf8'), /academyFileDownload|academyFileReplace|academy:fileDownload|academy:fileReplace|academy-files/);
});

test('로그인 끊김: 보기 전용으로 켠 것만 끄고, 같은 계정으로 보통으로 켠 프로그램은 그대로', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'view-authlost-'));
  const paths = makePaths({ userData: root, localData: path.join(root, 'local') });
  const c = new Cloud({ paths, store: new Store({ paths }), version: '1', log: { warn() {} } });
  t.after(() => { c.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  c.phase = 'ready';
  c.user = { id: 'operator', role: 'admin', username: 'admin', name: '운영자' };
  c.installed = { notes: {}, other: {} };
  const running = { notes: true, other: true };
  const info = { notes: { userId: 'operator', viewOnly: true }, other: { userId: 'operator', viewOnly: false } };
  c.runner = { isRunning: (id) => running[id], runningInfo: (id) => info[id], stop: (id) => { running[id] = false; return true; } };
  c.views.set('notes', { userId: 'operator', academyId: 1 });
  c._authLost({ code: 'unauthorized', message: '다시 로그인해 주세요.' });
  for (let i = 0; i < 20 && running.notes; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(running.notes, false, '보기 전용 실행은 끔');
  assert.equal(running.other, true, '보통으로 켠 프로그램은 그대로');
  assert.equal(c.phase, 'login');
});

test('시작 정리: 로그인 전 잔여 view만 삭제, 실행 중 보기·불명 모드는 보존', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'view-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = makePaths({ userData: root, localData: path.join(root, 'local') });
  const store = new Store({ paths });
  const c = new Cloud({ paths, store, version: '1', log: { warn() {} } });
  t.after(() => c.shutdown());
  const views = ['one', 'two'].map((uid) => paths.account(uid).view(1, 'notes').root);
  const own = paths.account('one').app('notes');
  for (const dir of [...views, own.sync, own.academy]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'keep.json'), '{}'); }
  c.installer.recover = async () => {};
  c.installer.listInstalled = async () => ({ notes: {} });
  let mode = true;
  c.runner = { isRunning: () => true, runningInfo: () => mode === undefined ? {} : { viewOnly: mode } };
  store.loadSession = () => { assert.equal(c.user, null); return null; };
  await c.init();
  for (const dir of views) assert.equal(fs.existsSync(dir), true);
  mode = undefined; await c.init();
  for (const dir of views) assert.equal(fs.existsSync(dir), true);
  mode = false;
  store.loadSession = () => { for (const dir of views) assert.equal(fs.existsSync(dir), false, '로그인 정보 읽기 전에 정리'); return null; };
  await c.init();
  for (const dir of [own.sync, own.academy]) assert.equal(fs.readFileSync(path.join(dir, 'keep.json'), 'utf8'), '{}');
});
