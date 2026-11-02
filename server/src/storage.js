'use strict';

// 파일 내용 저장소: SHA-256 이름으로 저장해 같은 내용은 한 번만 보관한다.
//   data/blobs/ab/cd/abcdef....

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { HttpError } = require('./util');

const SHA_RE = /^[0-9a-f]{64}$/;

class BlobStore {
  constructor(dir, db, log) {
    this.dir = path.join(dir, 'blobs');
    this.tmp = path.join(dir, 'tmp');
    this.db = db;
    this.log = log;
    this._gcTimer = null;
    this.pending = new Map(); // 올리는 중인 내용 (정리하면 안 됨)
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.tmp, { recursive: true });
  }

  pathFor(sha) {
    if (!SHA_RE.test(sha)) throw new Error('bad sha');
    return path.join(this.dir, sha.slice(0, 2), sha.slice(2, 4), sha);
  }

  has(sha) {
    try {
      return fs.statSync(this.pathFor(sha)).isFile();
    } catch {
      return false;
    }
  }

  /** 요청 본문을 임시 파일로 받으면서 SHA-256 과 크기를 잰다 */
  async receive(req, maxBytes) {
    const file = path.join(this.tmp, `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.part`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) {
          cb(new HttpError(413, '파일이 너무 커요.', 'too_large'));
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, meter, fs.createWriteStream(file));
    } catch (err) {
      await fsp.rm(file, { force: true });
      throw err instanceof HttpError ? err : new HttpError(400, '파일을 받다가 끊겼어요.', 'upload_failed');
    }
    return { file, sha256: hash.digest('hex'), size };
  }

  /** 받은 임시 파일을 저장소에 넣는다 (이미 있으면 임시 파일만 지움) */
  async commit(tmpFile, sha) {
    const dst = this.pathFor(sha);
    if (this.has(sha)) {
      await fsp.rm(tmpFile, { force: true });
      return;
    }
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.rename(tmpFile, dst);
  }

  async discard(tmpFile) {
    await fsp.rm(tmpFile, { force: true });
  }

  protect(sha) {
    this.pending.set(sha, (this.pending.get(sha) || 0) + 1);
  }

  unprotect(sha) {
    const n = (this.pending.get(sha) || 0) - 1;
    if (n > 0) this.pending.set(sha, n);
    else this.pending.delete(sha);
  }

  createReadStream(sha) {
    return fs.createReadStream(this.pathFor(sha));
  }

  /** 어떤 파일도 쓰지 않는 내용을 지운다 */
  gc() {
    const used = new Set(
      this.db
        .all(
          `SELECT sha256 FROM files WHERE deleted = 0 AND evicted = 0 AND sha256 IS NOT NULL
           UNION SELECT sha256 FROM shared_files WHERE deleted = 0 AND sha256 IS NOT NULL`,
        )
        .map((r) => r.sha256),
    );
    let removed = 0;
    let bytes = 0;
    for (const a of safeReaddir(this.dir)) {
      for (const b of safeReaddir(path.join(this.dir, a))) {
        const sub = path.join(this.dir, a, b);
        for (const name of safeReaddir(sub)) {
          if (!SHA_RE.test(name) || used.has(name) || this.pending.has(name)) continue;
          const f = path.join(sub, name);
          try {
            bytes += fs.statSync(f).size;
            fs.rmSync(f, { force: true });
            removed += 1;
          } catch {
            /* 무시 */
          }
        }
      }
    }
    // 오래된 임시 파일 정리 (하루 넘게 남은 것)
    for (const name of safeReaddir(this.tmp)) {
      const f = path.join(this.tmp, name);
      try {
        if (Date.now() - fs.statSync(f).mtimeMs > 24 * 60 * 60 * 1000) fs.rmSync(f, { force: true });
      } catch {
        /* 무시 */
      }
    }
    if (removed) this.log.info(`[저장소] 쓰지 않는 파일 ${removed}개 정리 (${(bytes / 1024 / 1024).toFixed(1)}MB)`);
    return { removed, bytes };
  }

  scheduleGc(delayMs = 2000) {
    if (this._gcTimer) return;
    this._gcTimer = setTimeout(() => {
      this._gcTimer = null;
      try {
        this.gc();
      } catch (err) {
        this.log.warn('[저장소] 정리 실패', err.message);
      }
    }, delayMs);
    this._gcTimer.unref?.();
  }

  diskUsage() {
    let bytes = 0;
    for (const a of safeReaddir(this.dir)) {
      for (const b of safeReaddir(path.join(this.dir, a))) {
        for (const name of safeReaddir(path.join(this.dir, a, b))) {
          try {
            bytes += fs.statSync(path.join(this.dir, a, b, name)).size;
          } catch {
            /* 무시 */
          }
        }
      }
    }
    return bytes;
  }

  close() {
    if (this._gcTimer) clearTimeout(this._gcTimer);
    this._gcTimer = null;
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

module.exports = { BlobStore, SHA_RE };
