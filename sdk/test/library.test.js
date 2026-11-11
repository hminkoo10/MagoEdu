'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sdk = require('../node/magoedu-cloud');
test('공용 책장 SDK: 폴더·개발 환경·요청·기존 파일·시간 초과', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magoedu-library-sdk-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { MAGOEDU_DEV: '1', MAGOEDU_DEV_DIR: root, MAGOEDU_LIBRARY_DIR: path.join(root, 'library'), MAGOEDU_REQUEST_DIR: path.join(root, 'requests') };
  const session = sdk.check('notes', { packaged: false, env });
  assert.equal(session.libraryDir, env.MAGOEDU_LIBRARY_DIR);
  assert.equal(sdk.check('notes', { packaged: false, env: { ...env, MAGOEDU_LIBRARY_DIR: '' } }).libraryDir, '');
  fs.mkdirSync(session.libraryDir);
  fs.writeFileSync(path.join(session.libraryDir, 'present.pdf'), 'present');
  assert.deepEqual(await sdk.requestLibraryFiles(session, ['present.pdf']), { ok: true, missing: [] });
  assert.equal((await sdk.requestLibraryFiles({}, ['a.pdf'])).ok, false);
  const timer = setInterval(() => {
    if (!fs.existsSync(session.requestDir)) return;
    for (const n of fs.readdirSync(session.requestDir).filter((n) => /^[^.]+\.json$/.test(n))) {
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(session.requestDir, n))), { library: true, paths: ['books/a.pdf', 'missing.pdf'] });
      fs.writeFileSync(path.join(session.requestDir, n.replace('.json', '.done.json')), JSON.stringify({ ok: false, missing: ['missing.pdf'] }));
      fs.rmSync(path.join(session.requestDir, n));
    }
  }, 10);
  try { assert.deepEqual(await sdk.requestLibraryFiles(session, ['present.pdf', 'books\\a.pdf', 'books/a.pdf', 'missing.pdf']), { ok: false, missing: ['missing.pdf'] }); }
  finally { clearInterval(timer); }
  const timeout = await sdk.requestLibraryFiles(session, ['timeout.pdf'], { timeoutMs: 1 });
  assert.equal(timeout.errorCode, 'timeout');
  assert.deepEqual(timeout.missing, ['timeout.pdf']);
  const py = execFileSync('python3', ['-c', 'import magoedu_cloud as c; print(c.check("notes").library_dir)'], { encoding: 'utf8', env: { ...process.env, ...env, PYTHONPATH: path.join(__dirname, '../python') } }).trim();
  assert.equal(py, session.libraryDir);
});
