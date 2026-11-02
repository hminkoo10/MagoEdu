'use strict';

// zip 풀기 (yauzl). 폴더 밖으로 나가는 경로는 막는다.

// Electron 안에서는 .asar 파일을 폴더처럼 다루는 fs 대신 원래 fs (Electron 으로 만든 프로그램에는 app.asar 가 들어 있음)
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

function listEntries(zip) {
  return new Promise((resolve, reject) => {
    const entries = [];
    zip.on('entry', (e) => {
      entries.push(e);
      zip.readEntry();
    });
    zip.on('end', () => resolve(entries));
    zip.on('error', reject);
    zip.readEntry();
  });
}

function openStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, s) => (err ? reject(err) : resolve(s)));
  });
}

/**
 * zip 을 dest 폴더에 푼다.
 * 모든 파일이 폴더 하나 안에 들어 있으면(예: "Mataf/...") 그 폴더는 벗겨 낸다.
 */
async function extractZip(file, dest, { onProgress, signal } = {}) {
  const zip = await openZip(file);
  try {
    const entries = await listEntries(zip);
    const names = entries.map((e) => e.fileName.replace(/\\/g, '/'));
    let strip = '';
    const tops = new Set(names.map((n) => n.split('/')[0]));
    if (tops.size === 1 && names.every((n) => n.includes('/')) && !names.includes('magoedu-app.json')) {
      strip = `${[...tops][0]}/`;
    }
    const total = entries.reduce((s, e) => s + e.uncompressedSize, 0);
    let done = 0;
    const root = path.resolve(dest);
    await fsp.mkdir(root, { recursive: true });
    for (let i = 0; i < entries.length; i += 1) {
      if (signal?.aborted) throw Object.assign(new Error('취소했어요.'), { cancelled: true });
      const e = entries[i];
      let rel = names[i];
      if (strip) rel = rel.slice(strip.length);
      if (!rel) continue;
      const target = path.resolve(root, rel);
      if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`잘못된 경로가 들어 있어요: ${names[i]}`);
      if (rel.endsWith('/')) {
        await fsp.mkdir(target, { recursive: true });
        continue;
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const rs = await openStream(zip, e);
      await pipeline(rs, fs.createWriteStream(target));
      done += e.uncompressedSize;
      onProgress?.(done, total);
    }
    return { files: entries.length, bytes: total };
  } finally {
    zip.close();
  }
}

module.exports = { extractZip };
