'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 1), 'utf8');
  await fsp.rename(tmp, file);
}

function writeJsonSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 이름 바꾸기. Windows 에서는 켜져 있는 프로그램이 그 파일을 잠깐 읽고 있으면 바꾸지 못해서(EPERM·EBUSY)
 * 조금 기다렸다가 다시 한다 (모두 합쳐 1.5초쯤).
 */
async function renameRetry(from, to, tries = 6) {
  for (let i = 0; ; i += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (i >= tries - 1 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 50 * 2 ** i));
    }
  }
}

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

/** 폴더 안 파일을 모두 찾는다 → [{ rel: 'a/b.txt', abs, size, mtimeMs }] */
async function walk(root, filter) {
  const out = [];
  async function visit(dir, relDir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await visit(abs, rel);
      } else if (e.isFile()) {
        if (filter && !filter(rel)) continue;
        try {
          const st = await fsp.stat(abs);
          out.push({ rel, abs, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
        } catch {
          /* 그 사이 지워짐 */
        }
      }
    }
  }
  await visit(root, '');
  return out;
}

async function dirSize(root) {
  let files = 0;
  let bytes = 0;
  for (const f of await walk(root)) {
    files += 1;
    bytes += f.size;
  }
  return { files, bytes };
}

/** 지운 파일 위로 빈 폴더를 정리 (root 는 남김) */
async function pruneEmptyDirs(root, startDir) {
  let dir = startDir;
  const top = path.resolve(root);
  while (path.resolve(dir).startsWith(top + path.sep)) {
    try {
      const left = await fsp.readdir(dir);
      if (left.length) return;
      await fsp.rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

function insideOf(base, target) {
  const b = path.resolve(base) + path.sep;
  return path.resolve(target).startsWith(b);
}

function formatBytes(n) {
  if (!n) return '0B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

module.exports = { readJson, readJsonSync, writeJson, writeJsonSync, renameRetry, sha256File, walk, dirSize, pruneEmptyDirs, insideOf, formatBytes };
