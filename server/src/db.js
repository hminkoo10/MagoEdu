'use strict';

// SQLite (Node 기본 내장 node:sqlite) - 따로 설치할 것이 없다.
const { DatabaseSync } = require('node:sqlite');

// 2·3번 고침에서 넣는 항목 (작은따옴표가 없어야 SQL 안에 그대로 넣을 수 있음)
const TAJONG_ANDROID = {
  icon: 'https://raw.githubusercontent.com/hminkoo10/Mapl-Tajong/main/android/app/src/main/res/drawable-nodpi/app_icon.png',
  description: '휴대폰에서 종을 울리고, PC와 시간표·종소리를 함께 맞추는 마고 타종 안드로이드 앱',
  source: { type: 'github', repo: 'hminkoo10/Mapl-Tajong', asset: '^MaplTajong-(\\d+\\.\\d+\\.\\d+)\\.apk$' },
};

// 5번 고침에서 넣는 항목: 마고 과목내비 (웹 + PC 창)
const MAGO_NAVI = {
  id: 'mago-navi',
  name: '마고 과목내비',
  description: '학생마다 희망 학과·대학에 맞춰 고교 선택과목을 짜 주는 웹 프로그램',
  color: '#0F9D8A',
  icon: 'https://raw.githubusercontent.com/hminkoo10/mago-navi/main/desktop/build/icon.png',
  source: { type: 'web', url: 'https://magonavi.milky.kr' },
};
const MAGO_NAVI_PC = {
  id: 'mago-navi-pc',
  name: '마고 과목내비',
  description: '마고 과목내비를 PC 프로그램 창으로 (통합 클라우드 계정으로 자동 로그인)',
  exe: 'MagoNavi.exe',
  source: { type: 'github', repo: 'hminkoo10/mago-navi', asset: '^MagoNavi-(\\d+\\.\\d+\\.\\d+)-win-x64\\.zip$' },
};

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

  // 2: 프로그램마다 플랫폼(windows | android), 마고 타종 안드로이드 내려받기 항목
  //    (처음 설치하는 서버는 비어 있으니 catalog.default.json 에서 넣고, 이미 쓰던 서버에만 여기서 넣음)
  `
  ALTER TABLE apps ADD COLUMN platform TEXT NOT NULL DEFAULT 'windows';

  INSERT INTO apps(id, name, description, sort, enabled, source, icon_url, exe, color, cold_enabled, cold_days,
                   auto_launch_default, platform, created_at, updated_at)
  SELECT 'tajong-android', '마고 타종 (안드로이드)', '${TAJONG_ANDROID.description}',
         COALESCE((SELECT sort FROM apps WHERE id = 'tajong'), (SELECT MAX(sort) + 1 FROM apps)), 1,
         '${JSON.stringify(TAJONG_ANDROID.source)}', (SELECT icon_url FROM apps WHERE id = 'tajong'), '', '#F76B15', 0, 30, 0,
         'android', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  WHERE EXISTS (SELECT 1 FROM apps) AND NOT EXISTS (SELECT 1 FROM apps WHERE id = 'tajong-android');
  `,

  // 3: 마고 타종 안드로이드는 PC(주황)와 다른 보라색 아이콘. PC 아이콘 주소를 그대로 쓰던 서버만 바꾼다 (운영자가 바꾼 주소는 그대로)
  `
  UPDATE apps SET icon_url = '${TAJONG_ANDROID.icon}'
  WHERE id = 'tajong-android' AND icon_url = (SELECT icon_url FROM apps WHERE id = 'tajong');
  `,

  // 4: 학원 공간 — 같은 학원 사람들이 함께 쓰는 파일 (routes/shared.js, 누가 쓰는지는 sharing.js)
  //    shared_items: 묶음(앞의 두 단계 경로, 예: books/<교재 ID>)마다 처음 올린 사람 = 주인
  `
  CREATE TABLE shared_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    academy_id INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL,
    path TEXT NOT NULL,
    rev INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    sha256 TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    mtime INTEGER,
    deleted INTEGER NOT NULL DEFAULT 0,
    device_id TEXT,
    updated_by TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE (academy_id, app_id, path)
  );
  CREATE INDEX shared_files_seq ON shared_files(academy_id, app_id, seq);
  CREATE INDEX shared_files_sha ON shared_files(sha256);

  CREATE TABLE shared_items (
    academy_id INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL,
    item TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (academy_id, app_id, item)
  );
  `,

  // 5: 학원 공간 용량 (NULL = 서버 설정의 기본 학원 용량, 0 = 제한 없음)
  `
  ALTER TABLE academies ADD COLUMN quota_mb INTEGER;
  `,

  // 6: 학원 학생 명단 (학원 사람 누구나 고치고 지우고 되살림. 지우고 오래 두면 purged_at — 행은 남겨서 프로그램이 알 수 있게)
  //    학원 공용 AI (app_id '' = 기본, 프로그램마다 따로 정할 수 있음. 설정은 서버 비밀값으로 암호화)
  //    웹 프로그램: source.type 'web' + 앱 비밀값(SSO 코드 교환), 그 프로그램 전용 로그인 세션(sessions.app_id)
  //    마고 과목내비(웹·PC) 항목은 꺼 둔 채로 넣는다 (배포한 뒤 운영자가 켬)
  `
  CREATE TABLE students (
    id TEXT PRIMARY KEY,
    academy_id INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    school TEXT NOT NULL DEFAULT '',
    grade TEXT NOT NULL DEFAULT '',
    teacher_uid TEXT,
    memo TEXT NOT NULL DEFAULT '',
    rev INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    updated_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    deleted_by TEXT,
    purged_at INTEGER
  );
  CREATE INDEX students_academy ON students(academy_id);

  CREATE TABLE academy_ai (
    academy_id INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL DEFAULT '',
    config_enc TEXT NOT NULL,
    updated_by TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (academy_id, app_id)
  );

  ALTER TABLE apps ADD COLUMN client_secret_hash TEXT;
  ALTER TABLE sessions ADD COLUMN app_id TEXT;

  INSERT INTO apps(id, name, description, sort, enabled, source, icon_url, exe, color, cold_enabled, cold_days,
                   auto_launch_default, platform, created_at, updated_at)
  SELECT '${MAGO_NAVI.id}', '${MAGO_NAVI.name}', '${MAGO_NAVI.description}', (SELECT COALESCE(MAX(sort), 0) + 1 FROM apps), 0,
         '${JSON.stringify(MAGO_NAVI.source)}', '${MAGO_NAVI.icon}', '', '${MAGO_NAVI.color}', 0, 30, 0, 'web',
         CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  WHERE EXISTS (SELECT 1 FROM apps) AND NOT EXISTS (SELECT 1 FROM apps WHERE id = '${MAGO_NAVI.id}');

  INSERT INTO apps(id, name, description, sort, enabled, source, icon_url, exe, color, cold_enabled, cold_days,
                   auto_launch_default, platform, created_at, updated_at)
  SELECT '${MAGO_NAVI_PC.id}', '${MAGO_NAVI_PC.name}', '${MAGO_NAVI_PC.description}', (SELECT COALESCE(MAX(sort), 0) + 1 FROM apps), 0,
         '${JSON.stringify(MAGO_NAVI_PC.source)}', '${MAGO_NAVI.icon}', '${MAGO_NAVI_PC.exe}', '${MAGO_NAVI.color}', 0, 30, 0, 'windows',
         CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  WHERE EXISTS (SELECT 1 FROM apps) AND NOT EXISTS (SELECT 1 FROM apps WHERE id = '${MAGO_NAVI_PC.id}');
  `,

  // 7: 명단에 연결한 학생 계정과 일회용 초대 코드
  `
  CREATE TABLE users_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'director', 'teacher', 'student')),
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
    password_changed_at INTEGER,
    student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
    ai_mode TEXT DEFAULT 'academy' CHECK (ai_mode IN ('academy', 'teacher')),
    CHECK ((role = 'student' AND student_id IS NOT NULL AND academy_id IS NOT NULL AND ai_mode IS NOT NULL)
        OR (role != 'student' AND student_id IS NULL))
  );
  INSERT INTO users_new(id, uid, username, name, role, academy_id, password_hash, must_change_password,
                        status, suspended_reason, allowed_apps, quota_mb, created_by, created_at, updated_at,
                        last_login_at, password_changed_at, ai_mode)
  SELECT id, uid, username, name, role, academy_id, password_hash, must_change_password,
         status, suspended_reason, allowed_apps, quota_mb, created_by, created_at, updated_at,
         last_login_at, password_changed_at, NULL FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;
  CREATE INDEX users_academy ON users(academy_id);
  CREATE UNIQUE INDEX users_student ON users(student_id) WHERE student_id IS NOT NULL;

  ALTER TABLE academies ADD COLUMN code TEXT;
  CREATE UNIQUE INDEX academies_code ON academies(code) WHERE code IS NOT NULL;

  CREATE TABLE student_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash TEXT NOT NULL UNIQUE,
    academy_id INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
    student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX student_invites_student ON student_invites(student_id);
  `,

  // 8: 학생 학교의 나이스 코드 + PC 과목내비 기본 이름 (운영자가 정한 이름은 보존)
  `
  ALTER TABLE students ADD COLUMN school_office TEXT NOT NULL DEFAULT '';
  ALTER TABLE students ADD COLUMN school_code TEXT NOT NULL DEFAULT '';
  UPDATE apps SET name = '마고 과목내비'
  WHERE id = 'mago-navi-pc' AND name = '마고 과목내비 (PC)';
  `,

  // 9: 학원 계약 과목 (기존 학원·원장 가입 코드는 수학)
  `
  ALTER TABLE academies ADD COLUMN subjects TEXT NOT NULL DEFAULT '["math"]';
  ALTER TABLE signup_codes ADD COLUMN subjects TEXT NOT NULL DEFAULT '["math"]';
  `,

  // 10: 과목내비 웹·PC 목록의 옛 초록 로고 → 실제 PC 앱 로고 (운영자 지정 주소는 보존)
  `
  UPDATE apps SET icon_url = '${MAGO_NAVI.icon}'
  WHERE id IN ('mago-navi', 'mago-navi-pc')
    AND icon_url = 'https://raw.githubusercontent.com/hminkoo10/mago-navi/main/public/icon-512.png';
  `,
  // 11: Keep only scoped sync tombstones, not student personal information.
  `UPDATE students SET name = '', school = '', school_office = '', school_code = '', grade = '', memo = '',
    teacher_uid = NULL, created_by = NULL, updated_by = NULL, deleted_by = NULL,
    created_at = 0, updated_at = 0, deleted_at = NULL, rev = 0 WHERE purged_at IS NOT NULL;`,

  // 12: Single-use teacher invitations; only the code hash is retained.
  `CREATE TABLE teacher_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash TEXT NOT NULL UNIQUE,
    academy_id INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    allowed_apps TEXT,
    created_by INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX teacher_invites_creator ON teacher_invites(created_by);`,
  // 13: Private support conversations and independently retained photos.
  `CREATE TABLE inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    academy_id INTEGER REFERENCES academies(id) ON DELETE SET NULL,
    role TEXT NOT NULL, title TEXT NOT NULL, client TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_message_at INTEGER NOT NULL,
    closed_at INTEGER, owner_seen_at INTEGER, admin_seen_at INTEGER
  );
  CREATE INDEX inquiries_owner ON inquiries(user_id, last_message_at);
  CREATE TABLE inquiry_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inquiry_id INTEGER NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
    author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    from_admin INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL,
    photo_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX inquiry_messages_thread ON inquiry_messages(inquiry_id, id);
  CREATE INDEX inquiry_messages_rate ON inquiry_messages(author_id, created_at);
  CREATE TABLE inquiry_photos (
    id TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    inquiry_id INTEGER REFERENCES inquiries(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES inquiry_messages(id) ON DELETE CASCADE,
    mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX inquiry_photos_owner ON inquiry_photos(user_id, created_at);`,
  // 14: 보호자 계정·연락처·동의. 기존 사용자와 연결 보존.
  `  CREATE TABLE users_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'director', 'teacher', 'student', 'guardian')),
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
    password_changed_at INTEGER,
    student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
    ai_mode TEXT DEFAULT 'academy' CHECK (ai_mode IN ('academy', 'teacher')),
    CHECK ((role = 'student' AND student_id IS NOT NULL AND academy_id IS NOT NULL AND ai_mode IS NOT NULL)
        OR (role != 'student' AND student_id IS NULL AND (role != 'guardian' OR academy_id IS NOT NULL)))
  );
  INSERT INTO users_new SELECT * FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;
  CREATE INDEX users_academy ON users(academy_id);
  CREATE UNIQUE INDEX users_student ON users(student_id) WHERE student_id IS NOT NULL;

  ALTER TABLE apps ADD COLUMN guardian_enabled INTEGER NOT NULL DEFAULT 0 CHECK (guardian_enabled IN (0,1));
  CREATE TABLE guardians (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    academy_id INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
    student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    name TEXT NOT NULL, relation TEXT NOT NULL DEFAULT '', phone_enc TEXT NOT NULL,
    notify INTEGER NOT NULL DEFAULT 0 CHECK (notify IN (0,1)),
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 1,
    UNIQUE(student_id, user_id)
  );
  CREATE TRIGGER guardians_scope_insert BEFORE INSERT ON guardians BEGIN
    SELECT RAISE(ABORT, 'guardian_scope') WHERE NOT EXISTS (SELECT 1 FROM students WHERE id=NEW.student_id AND academy_id=NEW.academy_id)
      OR (NEW.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND role='guardian' AND academy_id=NEW.academy_id));
  END;
  CREATE TRIGGER guardians_scope_update BEFORE UPDATE OF user_id,student_id,academy_id ON guardians BEGIN
    SELECT RAISE(ABORT, 'guardian_scope') WHERE NOT EXISTS (SELECT 1 FROM students WHERE id=NEW.student_id AND academy_id=NEW.academy_id)
      OR (NEW.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND role='guardian' AND academy_id=NEW.academy_id));
  END;
  CREATE UNIQUE INDEX guardians_primary ON guardians(student_id) WHERE is_primary = 1;
  CREATE TABLE guardian_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code_hash TEXT NOT NULL UNIQUE,
    academy_id INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
    guardian_id INTEGER NOT NULL UNIQUE REFERENCES guardians(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
  );
  CREATE TABLE guardian_consents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    academy_id INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
    student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    guardian_id INTEGER NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
    item TEXT NOT NULL CHECK (item IN ('collect','messaging','overseas_ai','marketing')),
    version TEXT NOT NULL, method TEXT NOT NULL CHECK (method IN ('paper','online')),
    agreed_at INTEGER NOT NULL, withdrawn_at INTEGER,
    recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL, sms_confirmed_at INTEGER
  );
  CREATE INDEX guardian_consents_guardian ON guardian_consents(guardian_id);
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
    const rebuildUsers = v === 6 || v === 13;
    const schema = rebuildUsers ? db.prepare("SELECT name, sql FROM sqlite_schema WHERE tbl_name = 'users' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all() : [];
    const sequence = rebuildUsers ? db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get()?.seq : null;
    // 트랜잭션 안에서 foreign_keys 를 끄면 적용되지 않고, DROP TABLE 이 기존 세션까지 지워 버린다.
    if (rebuildUsers) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      if (rebuildUsers) {
        for (const item of schema) {
          if (!db.prepare('SELECT 1 FROM sqlite_schema WHERE name = ?').get(item.name)) db.exec(item.sql);
        }
        if (sequence != null) db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'users'").run(sequence);
        if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('학생 계정 고침 뒤 외래 키가 맞지 않아요.');
      }
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      if (rebuildUsers) db.exec('PRAGMA foreign_keys = ON');
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

module.exports = { openDb, MIGRATIONS };
