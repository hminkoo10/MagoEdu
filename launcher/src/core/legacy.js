'use strict';

// 예전 데이터 가져오기
//   통합 클라우드 전에 따로 설치해 쓰던 프로그램의 데이터(예: %APPDATA%\OhdapNote\data)를 내 계정 폴더로 복사한다.
//   어디서 어디로 옮길지는 각 프로그램의 magoedu-app.json "legacy" 에 적는다. 이미 있는 파일은 덮어쓰지 않는다.
//   복사가 끝나면 다음 동기화 때 서버로 올라간다. (예전 폴더는 그대로 둔다)

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { walk, readJson, writeJson, insideOf } = require('./fsutil');
const { globToRegExp } = require('./rules');

function expandPath(template, env = process.env) {
  const home = os.homedir();
  const vars = {
    APPDATA: env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
    HOME: home,
    DOCUMENTS: path.join(home, 'Documents'),
  };
  const out = String(template).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return path.normalize(out.replace(/[\\/]+/g, path.sep));
}

/** to: "sync/..." 또는 "local/..." → 계정 프로그램 폴더 안의 실제 경로 */
function resolveTarget(appDirs, to) {
  const parts = String(to).replace(/\\/g, '/').split('/').filter(Boolean);
  const base = { sync: appDirs.sync, local: appDirs.local }[parts[0]];
  if (!base) throw new Error(`legacy.to 는 sync/ 또는 local/ 로 시작해야 해요: ${to}`);
  const target = path.join(base, ...parts.slice(1));
  if (target !== base && !insideOf(base, target)) throw new Error('legacy.to 경로가 올바르지 않아요.');
  return target;
}

/** 이 컴퓨터에 예전 데이터가 있는지 → [{ id, label, from, files, bytes, importedBy, importedAt }] */
async function detectLegacy(manifest, { appDirs, pcMarkerFile, env } = {}) {
  const pcMarks = (await readJson(pcMarkerFile, {})) || {};
  const accMarks = appDirs ? (await readJson(appDirs.legacy, {})) || {} : {};
  const found = [];
  for (const l of manifest.legacy || []) {
    const from = expandPath(l.from, env);
    let st;
    try {
      st = await fsp.stat(from);
    } catch {
      continue;
    }
    const ex = (l.exclude || []).map(globToRegExp);
    let files = 0;
    let bytes = 0;
    if (st.isDirectory()) {
      for (const f of await walk(from, (rel) => !ex.some((r) => r.test(rel)))) {
        files += 1;
        bytes += f.size;
      }
    } else {
      files = 1;
      bytes = st.size;
    }
    if (!files) continue;
    const key = `${manifest.id}:${l.id}`;
    found.push({
      id: l.id,
      label: l.label,
      from,
      files,
      bytes,
      importedHere: !!accMarks[l.id],
      importedBy: pcMarks[key]?.by || null,
      importedAt: pcMarks[key]?.at || accMarks[l.id]?.at || null,
    });
  }
  return found;
}

async function importLegacy(manifest, legacyId, { appDirs, pcMarkerFile, accountLabel, env, onProgress } = {}) {
  const l = (manifest.legacy || []).find((x) => x.id === legacyId);
  if (!l) throw new Error('가져올 데이터를 찾지 못했어요.');
  const from = expandPath(l.from, env);
  const target = resolveTarget(appDirs, l.to);
  const ex = (l.exclude || []).map(globToRegExp);
  const st = await fsp.stat(from);
  let copied = 0;
  let skipped = 0;
  let bytes = 0;
  if (st.isDirectory()) {
    const list = await walk(from, (rel) => !ex.some((r) => r.test(rel)));
    for (let i = 0; i < list.length; i += 1) {
      const f = list[i];
      const dst = path.join(target, ...f.rel.split('/'));
      if (fs.existsSync(dst)) {
        skipped += 1;
      } else {
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.copyFile(f.abs, dst);
        copied += 1;
        bytes += f.size;
      }
      onProgress?.(i + 1, list.length);
    }
  } else if (fs.existsSync(target)) {
    skipped = 1;
  } else {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(from, target);
    copied = 1;
    bytes = st.size;
  }
  const at = Date.now();
  const accMarks = (await readJson(appDirs.legacy, {})) || {};
  accMarks[l.id] = { at, from, copied };
  await writeJson(appDirs.legacy, accMarks);
  if (pcMarkerFile) {
    const pcMarks = (await readJson(pcMarkerFile, {})) || {};
    pcMarks[`${manifest.id}:${l.id}`] = { by: accountLabel || null, at };
    await writeJson(pcMarkerFile, pcMarks);
  }
  return { copied, skipped, bytes };
}

module.exports = { detectLegacy, importLegacy, expandPath, resolveTarget };
