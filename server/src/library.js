'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validPath } = require('./routes/sync');

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]+$/;
const emptyIndex = (appId) => ({ format: 1, appId, seq: 0, updatedAt: null, entries: [] });

function validateIndex(index, appId) {
  if (index.format !== 1 || index.appId !== appId || !Number.isSafeInteger(index.seq) || index.seq < 0 || !Array.isArray(index.entries)) throw new Error('invalid index');
  const paths = new Set();
  for (const e of index.entries) {
    validPath(e.path);
    if (!ID.test(e.book) || !e.path.startsWith(`books/${e.book}/`) || paths.has(e.path)
      || typeof e.subject !== 'string' || !ID.test(e.subject)
      || !Number.isSafeInteger(e.rev) || e.rev < 1 || !Number.isSafeInteger(e.seq) || e.seq < 1 || e.seq > index.seq
      || !Number.isSafeInteger(e.size) || e.size < 0 || !Number.isFinite(e.mtime) || e.mtime < 0
      || typeof e.deleted !== 'boolean' || (e.deleted ? e.sha256 !== null || e.size !== 0 : !SHA.test(e.sha256))) throw new Error('invalid entry');
    paths.add(e.path);
  }
  return index;
}

class Library {
  constructor(dir, log) { this.dir = dir; this.log = log; this.cache = new Map(); }
  index(appId) {
    if (!ID.test(appId)) return emptyIndex(appId);
    const file = path.join(this.dir, appId, 'index.json');
    let key = 'missing';
    let index;
    try {
      const stat = fs.statSync(file);
      key = `${stat.mtimeMs}:${stat.size}`;
      if (this.cache.get(appId)?.key === key) return this.cache.get(appId).index;
      index = validateIndex(JSON.parse(fs.readFileSync(file, 'utf8')), appId);
    } catch {
      if (this.cache.get(appId)?.key === key) return this.cache.get(appId).index;
      this.log.warn('[공용 책장] 색인을 읽을 수 없어 빈 책장을 사용합니다.');
      index = emptyIndex(appId);
    }
    this.cache.set(appId, { key, index });
    return index;
  }
  blob(sha) {
    if (!SHA.test(sha)) throw new Error('invalid sha256');
    return path.join(this.dir, 'blobs', sha);
  }
}

module.exports = { Library, SHA, ID, emptyIndex, validateIndex };
