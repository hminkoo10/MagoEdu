'use strict';

const fs = require('node:fs');
const path = require('node:path');

function promote(data, version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('올바른 새 버전 번호가 필요해요.');
  if (!data || !Array.isArray(data.next) || !Array.isArray(data.releases)) throw new Error('업데이트 내역 형식을 확인해 주세요.');
  if (data.next.some((n) => typeof n !== 'string' || !n.trim())) throw new Error('다음 버전 내역은 빈칸 없는 문장으로 적어 주세요.');
  const notes = data.next.map((n) => n.trim());
  if (!notes.length) return { data, markdown: '' };
  if (data.releases.some((r) => r.version === version)) throw new Error(`${version} 내역이 이미 있어요.`);
  return {
    data: { ...data, next: [], releases: [{ version, notes }, ...data.releases] },
    markdown: notes.map((n) => `- ${n}`).join('\n') + '\n',
  };
}

function promoteFile(file, version, output) {
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = promote(original, version);
  if (result.markdown) fs.writeFileSync(file, JSON.stringify(result.data, null, 2) + '\n');
  fs.writeFileSync(output, result.markdown);
  return result;
}

if (require.main === module) {
  promoteFile(path.join(__dirname, '../src/renderer/release-notes.json'), process.argv[2], process.argv[3]);
}

module.exports = { promote, promoteFile };
