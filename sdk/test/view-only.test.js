const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sdk = require('../node/magoedu-cloud');
test('보기 전용: typ app·view만 허용, ro 무시, 학원 대조, 개발 모드', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-view-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const trust = path.join(dir, 'trust.json');
  fs.writeFileSync(trust, JSON.stringify({ keys: [{ kid: 'test', x: publicKey.export({ format: 'jwk' }).x }] }));
  const ticket = (typ, ro) => {
    const data = 'MGT1.' + Buffer.from(JSON.stringify({ kid: 'test', app: 'notes', aca: 12, typ, ro, exp: Date.now()/1000 + 3600 })).toString('base64url');
    return data + '.' + crypto.sign(null, Buffer.from(data), privateKey).toString('base64url');
  };
  const env = { MAGOEDU_TRUST_FILE: trust, MAGOEDU_DATA_DIR: path.join(dir, 'sync'), MAGOEDU_LOCAL_DIR: path.join(dir, 'local'), MAGOEDU_ACADEMY_ID: '12', MAGOEDU_VIEW_ONLY: '1' };
  const check = (extra) => sdk.check('notes', { packaged: false, env: { ...env, ...extra } });
  assert.equal(check({ MAGOEDU_TICKET: ticket('view') }).viewOnly, true);
  assert.equal(check({ MAGOEDU_TICKET: ticket('app', 1) }).viewOnly, false);
  assert.equal(check({ MAGOEDU_TICKET: ticket('view'), MAGOEDU_ACADEMY_ID: '13' }), null);
  assert.equal(check({ MAGOEDU_TICKET: ticket('other') }), null);
  assert.equal(check({ MAGOEDU_TICKET: ticket(undefined) }), null);
  assert.equal(check({ MAGOEDU_DEV: '1' }).viewOnly, true);
});
