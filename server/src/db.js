'use strict';

// SQLite (Node 기본 내장 node:sqlite) - 따로 설치할 것이 없다.
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  // 1: 처음 구조
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE academies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'director', 'teacher')),
    academy_id INTEGER REFERENCES academies(id) ON DELETE SET NULL,
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    suspended_reason TEXT,
    allowed_apps TEXT,
    quota_mb INTEGER,
    created_by INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_login_at INTEGER,
    password_changed_at INTEGER
  );
  CREATE INDEX users_academy ON users(academy_id);

  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    device_name TEXT,
    platform TEXT,
    client_version TEXT,
    ip TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE signup_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'director',
    academy_name TEXT,
    memo TEXT,
    max_uses INTEGER NOT NULL DEFAULT 1,
    uses INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor_id INTEGER,
    actor TEXT,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    ip TEXT,
    academy_id INTEGER
  );
  CREATE INDEX audit_at ON audit(at);

  CREATE TABLE notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER,
    author_name TEXT,
    academy_id INTEGER REFERENCES academies(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER
  );

  CREATE TABLE apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL,
    icon_url TEXT,
    exe TEXT,
    color TEXT,
    cold_enabled INTEGER NOT NULL DEFAULT 0,
    cold_days INTEGER NOT NULL DEFAULT 30,
    auto_launch_default INTEGER NOT NULL DEFAULT 0,
    release TEXT,
    release_checked_at INTEGER,
    release_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL,
    path TEXT NOT NULL,
    grp TEXT NOT NULL DEFAULT '',
    rev INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    sha256 TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    mtime INTEGER,
    deleted INTEGER NOT NULL DEFAULT 0,
    evicted INTEGER NOT NULL DEFAULT 0,
    device_id TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, app_id, path)
  );
  CREATE INDEX files_seq ON files(user_id, app_id, seq);
  CREATE INDEX files_sha ON files(sha256);
  CREATE INDEX files_grp ON files(app_id, user_id, grp);

  CREATE TABLE group_activity (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL,
    grp TEXT NOT NULL,
    last_used_at INTEGER NOT NULL,
    evicted_at INTEGER,
    PRIMARY KEY (user_id, app_id, grp)
  );
  `,
];

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return wrap(db);
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** 자주 쓰는 형태로 감싼다: db.get(sql, ...args) / db.all / db.run / db.tx(fn) */
function wrap(raw) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  let depth = 0;
  return {
    raw,
    get: (sql, ...args) => stmt(sql).get(...args),
    all: (sql, ...args) => stmt(sql).all(...args),
    run: (sql, ...args) => stmt(sql).run(...args),
    exec: (sql) => raw.exec(sql),
    tx(fn) {
      if (depth > 0) return fn();
      depth += 1;
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      } finally {
        depth -= 1;
      }
    },
    close: () => raw.close(),
  };
}

module.exports = { openDb };
