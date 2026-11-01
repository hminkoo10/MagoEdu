'use strict';

// 동기화 엔진: 프로그램 하나(계정 하나)의 sync 폴더 ↔ 서버
//
// 파일마다 "마지막으로 맞춘 상태"(base: rev, sha)를 기억해 두고, 이번에 본 내 파일(L)과 서버 파일(R)을 비교한다.
//   - 나만 바뀜     → 올림
//   - 서버만 바뀜   → 받음
//   - 둘 다 바뀜    → 서버 것을 쓰고, 내 것은 conflicts 폴더에 보관 (아무것도 잃어버리지 않게)
//   - 서버에서 지움 → 나도 지움 (내가 그 뒤에 고쳤으면 내 것을 다시 올림)
//
// 보관 기간이 지나 서버에서만 지운 파일(evicted)은 내 컴퓨터에서 지우지 않는다. "이 컴퓨터에만 있음"으로 두었다가
// 그 묶음(group)의 파일을 다시 고치면(=다시 쓰면) 묶음 전체를 다시 올린다.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { readJson, writeJson, renameRetry, sha256File, walk, pruneEmptyDirs, insideOf } = require('./fsutil');
const { ApiError, Cancelled } = require('./api');

const STATE_VERSION = 1;

class SyncEngine {
  constructor({ api, appId, dirs, rules, log = console, concurrency = 3 }) {
    this.api = api;
    this.appId = appId;
    this.dirs = dirs; // { sync, conflicts, state }
    this.rules = rules;
    this.log = log;
    this.concurrency = concurrency;
  }

  async _loadState() {
    const s = await readJson(this.dirs.state, null);
    if (!s || s.v !== STATE_VERSION) return { v: STATE_VERSION, seq: 0, remote: {}, base: {}, cache: {} };
    return { v: STATE_VERSION, seq: s.seq || 0, remote: s.remote || {}, base: s.base || {}, cache: s.cache || {} };
  }

  async _fetchRemote(state) {
    const res = await this.api.get(`/api/sync/${encodeURIComponent(this.appId)}?since=${state.seq || 0}`, { timeout: 60000 });
    if (res.full) state.remote = {};
    for (const e of res.entries) state.remote[e.path] = e;
    state.seq = res.seq;
    return res;
  }

  async _scanLocal(state, signal) {
    await fsp.mkdir(this.dirs.sync, { recursive: true });
    const files = await walk(this.dirs.sync, (rel) => this.rules.wants(rel));
    const local = {};
    for (const f of files) {
      if (signal?.aborted) throw new Cancelled();
      const c = state.cache[f.rel];
      let sha;
      if (c && c.size === f.size && c.mtimeMs === f.mtimeMs) sha = c.sha;
      else {
        try {
          sha = await sha256File(f.abs);
        } catch {
          continue; // 쓰는 중이라 못 읽음 → 다음에
        }
      }
      local[f.rel] = { ...f, sha };
    }
    state.cache = Object.fromEntries(Object.entries(local).map(([k, v]) => [k, { size: v.size, mtimeMs: v.mtimeMs, sha: v.sha }]));
    return local;
  }

  _plan(p, L, B, R) {
    const live = R && !R.deleted;
    if (live) {
      if (!B) {
        if (!L) return R.evicted ? null : { type: 'download' };
        if (L.sha === R.sha) return { type: 'record' };
        if (R.evicted) return { type: 'upload', baseRev: R.rev };
        return { type: 'conflict' };
      }
      const remoteChanged = R.rev !== B.rev;
      const localChanged = !L || L.sha !== B.sha;
      if (!remoteChanged && !localChanged) return R.evicted && !B.evicted ? { type: 'record' } : null;
      if (!remoteChanged) return L ? { type: 'upload', baseRev: R.rev } : { type: 'deleteRemote', baseRev: R.rev };
      if (!localChanged) return R.evicted ? { type: 'record', keepLocal: true } : { type: 'download' };
      if (L && L.sha === R.sha) return { type: 'record' };
      if (R.evicted) return L ? { type: 'upload', baseRev: R.rev } : { type: 'forget' };
      if (!L) return { type: 'download' };
      return { type: 'conflict' };
    }
    if (R && R.deleted) {
      if (!B) return L ? { type: 'upload', baseRev: R.rev } : null;
      if (!L) return { type: 'forget' };
      if (L.sha === B.sha) return { type: 'deleteLocal' };
      return { type: 'upload', baseRev: R.rev };
    }
    if (L) return { type: 'upload', baseRev: B && R ? R.rev : 0 };
    if (B) return { type: 'forget' };
    return null;
  }

  /**
   * 한 번 맞춘다.
   * onProgress({ phase: 'scan' | 'transfer', done, total, path })
   */
  async run({ onProgress, signal } = {}) {
    const summary = { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: [], errors: [], quotaExceeded: false };
    const state = await this._loadState();
    let quota = null;
    for (let pass = 0; pass < 3; pass += 1) {
      onProgress?.({ phase: 'scan', done: 0, total: 0 });
      const remoteInfo = await this._fetchRemote(state);
      quota = { usageBytes: remoteInfo.usageBytes, quotaBytes: remoteInfo.quotaBytes };
      const local = await this._scanLocal(state, signal);

      // ---------- 계획 ----------
      const ops = new Map();
      const all = new Set([...Object.keys(local), ...Object.keys(state.remote), ...Object.keys(state.base)]);
      for (const p of all) {
        if (!this.rules.wants(p)) continue;
        const op = this._plan(p, local[p], state.base[p], state.remote[p]);
        if (op) ops.set(p, op);
      }
      // 다시 쓰기 시작한 묶음은 이 컴퓨터에만 남아 있던 파일까지 다시 올린다
      const revive = new Set();
      for (const [p, op] of ops) {
        const g = this.rules.groupOf(p);
        if (op.type === 'upload' && g) revive.add(g);
      }
      if (revive.size) {
        for (const [p, R] of Object.entries(state.remote)) {
          if (!R.evicted || R.deleted || !local[p] || !this.rules.wants(p)) continue;
          if (!revive.has(this.rules.groupOf(p))) continue;
          const cur = ops.get(p);
          if (!cur || cur.type === 'record') ops.set(p, { type: 'upload', baseRev: R.rev });
        }
      }

      // ---------- 실행 ----------
      const shaIndex = new Map(); // 서버에 이미 있는 내용 → 다시 보내지 않고 연결
      for (const R of Object.values(state.remote)) if (!R.deleted && !R.evicted && R.sha256) shaIndex.set(R.sha256, R.path);
      let rerun = false;
      const transfers = [...ops].filter(([, op]) => ['upload', 'download', 'conflict', 'deleteRemote'].includes(op.type));
      let done = 0;
      for (const [p, op] of ops) {
        if (['record', 'forget', 'deleteLocal'].includes(op.type)) await this._apply(p, op, local, state, summary);
      }
      const queue = transfers.slice();
      const worker = async () => {
        while (queue.length) {
          if (signal?.aborted) throw new Cancelled();
          const [p, op] = queue.shift();
          if (op.type === 'upload' && summary.quotaExceeded) continue;
          try {
            const again = await this._transfer(p, op, local, state, summary, shaIndex, signal);
            if (again) rerun = true;
          } catch (err) {
            if (err instanceof Cancelled) throw err;
            if (err instanceof ApiError && err.offline) throw err;
            if (err instanceof ApiError && err.status === 401) throw err;
            summary.errors.push({ path: p, message: err.message });
            this.log.warn?.(`[동기화] ${this.appId} ${p}: ${err.message}`);
          }
          done += 1;
          onProgress?.({ phase: 'transfer', done, total: transfers.length, path: p });
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.max(1, Math.min(this.concurrency, transfers.length)) }, worker));
      } finally {
        await writeJson(this.dirs.state, state);
      }
      if (!rerun) break;
    }

    // 이 컴퓨터에만 남은(서버 보관 기간이 지난) 데이터
    const localOnly = { files: 0, bytes: 0, groups: new Set() };
    for (const [p, B] of Object.entries(state.base)) {
      if (!B.evicted || !state.cache[p]) continue;
      localOnly.files += 1;
      localOnly.bytes += state.cache[p].size;
      const g = this.rules.groupOf(p);
      if (g) localOnly.groups.add(g);
    }
    return {
      ...summary,
      localOnly: { files: localOnly.files, bytes: localOnly.bytes, groups: localOnly.groups.size },
      usageBytes: quota?.usageBytes ?? null,
      quotaBytes: quota?.quotaBytes ?? null,
      seq: state.seq, // 서버에서 여기까지 받음 (실시간 알림이 이보다 작으면 이미 맞춘 것)
      at: Date.now(),
    };
  }

  async _apply(p, op, local, state, summary) {
    const L = local[p];
    const R = state.remote[p];
    if (op.type === 'record') {
      if (L) state.base[p] = { rev: R.rev, sha: L.sha, evicted: !!R.evicted };
    } else if (op.type === 'forget') {
      delete state.base[p];
    } else if (op.type === 'deleteLocal') {
      const abs = this._abs(p);
      try {
        await fsp.rm(abs, { force: true });
        await pruneEmptyDirs(this.dirs.sync, path.dirname(abs));
        summary.deletedLocal += 1;
      } catch (err) {
        summary.errors.push({ path: p, message: err.message });
        return;
      }
      delete state.base[p];
      delete state.cache[p];
    }
  }

  _abs(p) {
    const abs = path.join(this.dirs.sync, ...p.split('/'));
    if (!insideOf(this.dirs.sync, abs)) throw new Error('잘못된 경로');
    return abs;
  }

  _q(p) {
    return `/api/sync/${encodeURIComponent(this.appId)}/file?path=${encodeURIComponent(p)}`;
  }

  /** 올리기·받기·지우기. 다시 한 번 맞춰야 하면 true */
  async _transfer(p, op, local, state, summary, shaIndex, signal) {
    const L = local[p];
    const R = state.remote[p];
    try {
      if (op.type === 'upload') {
        const group = this.rules.groupOf(p);
        const qs = `${this._q(p)}&baseRev=${op.baseRev}&mtime=${L.mtimeMs}${group ? `&group=${encodeURIComponent(group)}` : ''}`;
        let res = null;
        if (shaIndex.has(L.sha)) {
          try {
            res = await this.api.request('PUT', qs, { headers: { 'x-sha256': L.sha, 'x-link': '1' }, body: '' });
          } catch (err) {
            if (!(err instanceof ApiError) || err.code !== 'no_blob') throw err;
          }
        }
        if (!res) res = await this.api.upload(qs, L.abs, { sha256: L.sha, signal });
        state.remote[p] = res.entry;
        state.base[p] = { rev: res.entry.rev, sha: L.sha, evicted: false };
        shaIndex.set(L.sha, p);
        summary.uploaded += 1;
        return false;
      }
      if (op.type === 'deleteRemote') {
        const res = await this.api.del(`${this._q(p)}&baseRev=${op.baseRev}`);
        if (res.entry) state.remote[p] = res.entry;
        delete state.base[p];
        summary.deletedRemote += 1;
        return false;
      }
      if (op.type === 'conflict' && L) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const keep = path.join(this.dirs.conflicts, stamp, ...p.split('/'));
        await fsp.mkdir(path.dirname(keep), { recursive: true });
        await fsp.copyFile(L.abs, keep);
        summary.conflicts.push(p);
      }
      // download / conflict: 옆 임시 파일에 다 받은 뒤 이름만 바꾼다 (켜져 있는 프로그램이 반쯤 받은 파일을 읽지 않게)
      const abs = this._abs(p);
      const tmp = `${abs}.magoedu-dl`;
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await this.api.download(this._q(p), tmp, { expectSha256: R.sha256, expectSize: R.size, signal, timeout: 0 });
      try {
        await renameRetry(tmp, abs);
      } catch (err) {
        await fsp.rm(tmp, { force: true });
        throw err;
      }
      const st = await fsp.stat(abs);
      state.cache[p] = { size: st.size, mtimeMs: Math.round(st.mtimeMs), sha: R.sha256 };
      state.base[p] = { rev: R.rev, sha: R.sha256, evicted: false };
      summary.downloaded += 1;
      return false;
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409 && err.extra?.entry) {
          state.remote[p] = err.extra.entry; // 그 사이 다른 컴퓨터가 바꿈 → 다시 맞춤
          return true;
        }
        if (err.status === 410 && err.extra?.entry) {
          state.remote[p] = err.extra.entry;
          return false;
        }
        if (err.status === 507) {
          summary.quotaExceeded = true;
          return false;
        }
        if (err.code === 'checksum_mismatch') return true; // 올리는 사이 파일이 바뀜
      }
      throw err;
    }
  }
}

module.exports = { SyncEngine };
