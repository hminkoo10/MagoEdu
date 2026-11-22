'use strict';

// 프로그램 묶음 파일(zip) 안의 magoedu-app.json 읽기
//   docs/INTEGRATION.md 에 형식을 적어 두었다.

const fs = require('node:fs');
const path = require('node:path');

const MANIFEST = 'magoedu-app.json';
const RESTART_EXIT_CODE = 75; // 프로그램이 이 값으로 끝나면 바로 다시 켠다 (새 버전 적용 등)
const APP_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

function cleanList(v) {
  return Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 100) : [];
}

function normalizeSpace(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    include: cleanList(value.include).length ? cleanList(value.include) : ['**'],
    exclude: cleanList(value.exclude),
    lazy: cleanList(value.lazy),
  };
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
    // 잘못된 종료 인수는 일부만 전달하지 않고 통째로 무시한다 (일반 실행으로 오인하지 않게).
    stopArgs: Array.isArray(m.stopArgs) && m.stopArgs.length > 0 && m.stopArgs.length <= 8
      && m.stopArgs.every((arg) => typeof arg === 'string' && arg.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(arg)) ? [...m.stopArgs] : null,
    sync: {
      include: cleanList(sync.include).length ? cleanList(sync.include) : ['**'],
      exclude: cleanList(sync.exclude),
      groups: (Array.isArray(sync.groups) ? sync.groups : [])
        .filter((g) => g && g.pattern)
        .map((g) => ({ pattern: String(g.pattern), cold: !!g.cold })),
    },
    // 학원 공간 (같은 학원 사람들이 함께 쓰는 파일). 없으면 쓰지 않음
    shared: normalizeSpace(m.shared),
    library: normalizeSpace(m.library),
    legacy: (Array.isArray(m.legacy) ? m.legacy : [])
      .filter((l) => l && l.from && l.to)
      .map((l, i) => ({
        id: String(l.id || `legacy-${i + 1}`),
        label: String(l.label || '예전에 쓰던 데이터'),
        from: String(l.from),
        to: String(l.to),
        exclude: cleanList(l.exclude),
      })),
    // 설정 파일 서명 키(MAGOEDU_DATA_KEY)를 받음 — 손으로 고친 설정 파일을 프로그램이 거부할 수 있게
    dataSigning: m.dataSigning === true,
    // 학원 학생 명단·학원 AI 를 파일(academy-info.json)로 받는지
    academyInfo: m.academyInfo === true,
    // 켤 때 이 웹 프로그램(카탈로그 ID)에 로그인할 일회용 코드를 받는지 (예: 마고 과목내비 PC → "mago-navi")
    sso: typeof m.sso === 'string' && APP_ID_RE.test(m.sso) ? m.sso : null,
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
