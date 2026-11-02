'use strict';

// 프로그램 묶음 파일(zip) 안의 magoedu-app.json 읽기
//   docs/INTEGRATION.md 에 형식을 적어 두었다.

const fs = require('node:fs');
const path = require('node:path');

const MANIFEST = 'magoedu-app.json';
const RESTART_EXIT_CODE = 75; // 프로그램이 이 값으로 끝나면 바로 다시 켠다 (새 버전 적용 등)

function cleanList(v) {
  return Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 100) : [];
}

function normalizeManifest(raw, fallback = {}) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const exe = String(m.exe || fallback.exe || '').replace(/\\/g, '/');
  if (exe && (path.isAbsolute(exe) || exe.split('/').includes('..'))) throw new Error('magoedu-app.json 의 exe 경로가 올바르지 않아요.');
  const sync = m.sync && typeof m.sync === 'object' ? m.sync : {};
  return {
    format: Number(m.format) || 1,
    id: String(m.id || fallback.id || ''),
    version: String(m.version || fallback.version || ''),
    exe,
    args: cleanList(m.args),
    sync: {
      include: cleanList(sync.include).length ? cleanList(sync.include) : ['**'],
      exclude: cleanList(sync.exclude),
      groups: (Array.isArray(sync.groups) ? sync.groups : [])
        .filter((g) => g && g.pattern)
        .map((g) => ({ pattern: String(g.pattern), cold: !!g.cold })),
    },
    legacy: (Array.isArray(m.legacy) ? m.legacy : [])
      .filter((l) => l && l.from && l.to)
      .map((l, i) => ({
        id: String(l.id || `legacy-${i + 1}`),
        label: String(l.label || '예전에 쓰던 데이터'),
        from: String(l.from),
        to: String(l.to),
        exclude: cleanList(l.exclude),
      })),
    restartExitCode: Number.isInteger(m.restartExitCode) ? m.restartExitCode : RESTART_EXIT_CODE,
    singleInstance: m.singleInstance !== false,
  };
}

function readManifest(dir, fallback) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`${MANIFEST} 을 읽지 못했어요: ${err.message}`);
  }
  return normalizeManifest(raw, fallback);
}

module.exports = { readManifest, normalizeManifest, MANIFEST, RESTART_EXIT_CODE };
