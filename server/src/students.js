'use strict';

// 학원 학생 명단과 학원 공용 AI
//
// 학생은 학원에 속한다. 담당 선생님은 바뀔 수 있어서, 학원 사람(원장·선생님) 누구나 추가·수정·삭제·되살리기를 한다.
// 삭제는 숨김(deleted_at)이고, 정한 날짜(기본 30일) 안에 아무도 되살리지 않으면 완전히 지운다(purged_at):
// 그 학생의 학원 공간 자료(students/<학생 ID>/..., 모든 프로그램)를 삭제 표시해서 PC 에서도 지워지게 한다.
// 행은 남겨서 프로그램(예: 마고 과목내비 서버)이 "완전히 지워진 학생"을 알 수 있게 한다.
//
// 학원 공용 AI: 학원마다 기본 AI 하나(app_id '')와 프로그램마다 따로 정한 AI. 원장·운영자만 고친다.
// 프로그램은 자기 것(없으면 기본)을 받는다. 키는 서버 비밀값으로 암호화해서 저장한다 (DB 만 새어 나가도 안전하게).
//
// 예전 오답노트(0.3) 데이터:
//   - 학원 공간의 students/<id>.json → 같은 ID 로 명단에 넣는다 (없을 때만, 원래 파일은 그대로)
//   - academy.json 의 AI 키 → 그 학원의 기본 AI 가 없을 때만 넣는다
//   - members/<선생님>/notes/<id>.json → 오답노트 0.4 가 배포되면 studentId(없으면 이름이 하나만 맞는 학생)로
//     students/<학생 ID>/notes/<id>.json 으로 옮긴다 (같은 내용, 다시 올리지 않음)

const fs = require('node:fs');
const crypto = require('node:crypto');
const { DAY, HttpError, bad, notFound, str, intOr, jsonParse, compareVersions } = require('./util');
const { seal, unseal } = require('./security');

const OHDAP = 'ohdapnote';
const NOTES_FROM = '0.4.0'; // 이 버전부터 오답노트가 학생별 노트를 읽는다
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const PROVIDERS = ['gemini', 'openai', 'anthropic'];
const LEGACY_STUDENT_RE = /^students\/([A-Za-z0-9-]{8,64})\.json$/;
const LEGACY_SETTINGS = 'academy.json'; // 예전 오답노트(0.3)의 학원 공용 설정 (학원 AI 키가 들어 있음)
const LEGACY_NOTE_RE = /^members\/([A-Za-z0-9-]{1,64})\/notes\/([A-Za-z0-9-]{8,64})\.json$/;
const LEGACY_MAX_BYTES = 4 * 1024 * 1024; // 예전 학생·노트 파일을 읽을 때 (서버 메모리 보호)

function schoolFields(body, cur = null) {
  const out = {};
  if (body.school !== undefined) out.school = str(body.school, 60);
  if (body.schoolOffice !== undefined || body.schoolCode !== undefined) {
    const office = body.schoolOffice, code = body.schoolCode;
    if (typeof office !== 'string' || typeof code !== 'string'
      || !((office === '' && code === '') || (office.length === 3 && code.length === 7 && /^[A-Z][0-9]{2}$/.test(office) && /^[0-9]{7}$/.test(code)))) {
      throw bad('학교 교육청 코드와 학교 코드를 함께 올바르게 입력해 주세요.', 'invalid_school');
    }
    out.school_office = office;
    out.school_code = code;
  } else if (out.school !== undefined && out.school !== cur?.school) {
    // 이름만 직접 고친 옛 클라이언트도 다른 학교의 코드를 남기지 않는다.
    out.school_office = out.school_code = '';
  }
  if (Object.keys(out).length && !(out.school ?? cur?.school ?? '')) out.school_office = out.school_code = '';
  return out;
}

function createStudents({ inquiries, db, svc, blobs, events, catalog, nextSeq, log, aiKey, purgeDays = 30 }) {
  // ---------------- 명단 ----------------
  function stateOf(row) {
    if (!row) return null;
    if (row.purged_at) return 'purged';
    return row.deleted_at ? 'deleted' : 'active';
  }

  /** 학원의 그 학생 상태: 'active' | 'deleted' | 'purged' | null (명단에 없음) */
  function state(aca, sid) {
    return stateOf(db.get('SELECT deleted_at, purged_at FROM students WHERE id = ? AND academy_id = ?', String(sid), aca));
  }

  /** 학생 ID → 상태 (목록에서 한꺼번에) */
  function stateMap(aca) {
    return new Map(db.all('SELECT id, deleted_at, purged_at FROM students WHERE academy_id = ?', aca).map((r) => [r.id, stateOf(r)]));
  }

  function names(aca) {
    return new Map(db.all('SELECT uid, name FROM users WHERE academy_id = ? OR role = ?', aca, 'admin').map((u) => [u.uid, u.name]));
  }

  function who(map, uid) {
    return uid ? { id: uid, name: map.get(uid) || '알 수 없음' } : null;
  }

  function publicStudent(r, map = names(r.academy_id)) {
    return {
      id: r.id,
      name: r.name,
      school: r.school,
      schoolOffice: r.school_office,
      schoolCode: r.school_code,
      grade: r.grade,
      teacher: who(map, r.teacher_uid),
      memo: r.memo,
      rev: r.rev,
      createdBy: who(map, r.created_by),
      updatedBy: who(map, r.updated_by),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at || null,
      deletedBy: who(map, r.deleted_by),
      purgeAt: r.deleted_at ? r.deleted_at + purgeDays * DAY : null,
    };
  }

  function list(aca) {
    const map = names(aca);
    const rows = db.all('SELECT * FROM students WHERE academy_id = ? ORDER BY name COLLATE NOCASE, created_at', aca);
    return {
      academyId: aca,
      purgeDays,
      students: rows.filter((r) => !r.purged_at).map((r) => publicStudent(r, map)),
      purged: rows.filter((r) => r.purged_at).map((r) => r.id),
    };
  }

  function row(aca, id) {
    const r = db.get('SELECT * FROM students WHERE id = ? AND academy_id = ?', String(id), aca);
    if (!r || r.purged_at) throw notFound('학생을 찾을 수 없어요.', 'no_student');
    return r;
  }

  /** 학원 사람(활성 계정) — 담당 선생님 고르기 */
  function members(aca) {
    return db
      .all("SELECT uid, name, role FROM users WHERE academy_id = ? AND role NOT IN ('student', 'guardian') AND status = 'active' ORDER BY role = 'teacher', name COLLATE NOCASE", aca)
      .map((u) => ({ id: u.uid, name: u.name, role: u.role, roleLabel: svc.ROLE_LABEL[u.role] }));
  }

  function fields(aca, body, cur = null) {
    const out = {};
    if (body.name !== undefined || !cur) {
      out.name = str(body.name, 40);
      if (!out.name) throw bad('학생 이름을 입력해 주세요.', 'invalid_name');
    }
    Object.assign(out, schoolFields(body, cur));
    if (body.grade !== undefined) out.grade = str(body.grade, 20);
    if (body.memo !== undefined) out.memo = str(body.memo, 500);
    const t = body.teacherId !== undefined ? body.teacherId : body.teacher?.id;
    if (t !== undefined) {
      if (t === null || t === '') out.teacher_uid = null;
      else {
        const u = db.get("SELECT uid FROM users WHERE uid = ? AND academy_id = ? AND role NOT IN ('student', 'guardian')", String(t), aca);
        if (!u) throw bad('담당 선생님은 이 학원 사람 중에서 골라 주세요.', 'invalid_teacher');
        out.teacher_uid = u.uid;
      }
    }
    return out;
  }

  function create(user, aca, body) {
    const want = typeof body.id === 'string' && ID_RE.test(body.id) ? body.id : null;
    if (want) {
      const ex = db.get('SELECT * FROM students WHERE id = ?', want);
      if (ex && ex.academy_id === aca && !ex.purged_at) return { student: publicStudent(ex), existed: true };
      if (ex) throw new HttpError(409, '이미 쓰고 있는 학생 ID예요.', 'id_taken');
    }
    const f = fields(aca, body);
    const now = Date.now();
    const id = want || crypto.randomUUID();
    db.run(
      `INSERT INTO students(id, academy_id, name, school, school_office, school_code, grade, teacher_uid, memo, rev, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      id,
      aca,
      f.name,
      f.school ?? '',
      f.school_office ?? '',
      f.school_code ?? '',
      f.grade ?? '',
      f.teacher_uid ?? null,
      f.memo ?? '',
      user.uid,
      user.uid,
      now,
      now,
    );
    notify(aca, 'students');
    return { student: publicStudent(row(aca, id)), existed: false };
  }

  function conflict(r) {
    return new HttpError(409, '다른 사람이 먼저 고쳤어요. 새로 불러온 뒤 다시 고쳐 주세요.', 'conflict', { student: publicStudent(r) });
  }

  function update(user, aca, id, body) {
    const cur = row(aca, id);
    if (body.baseRev !== undefined && intOr(body.baseRev, -1) !== cur.rev) throw conflict(cur);
    if (cur.deleted_at) throw new HttpError(409, '지운 학생이에요. 먼저 되살려 주세요.', 'student_deleted');
    const f = fields(aca, body, cur);
    const keys = Object.keys(f);
    if (keys.length) {
      db.run(
        `UPDATE students SET ${keys.map((k) => `${k} = ?`).join(', ')}, rev = rev + 1, updated_by = ?, updated_at = ? WHERE id = ?`,
        ...keys.map((k) => f[k]),
        user.uid,
        Date.now(),
        cur.id,
      );
      notify(aca, 'students');
    }
    return publicStudent(row(aca, id));
  }

  function remove(user, aca, id) {
    const cur = row(aca, id);
    if (!cur.deleted_at) {
      const now = Date.now();
      db.run('UPDATE students SET deleted_at = ?, deleted_by = ?, rev = rev + 1, updated_by = ?, updated_at = ? WHERE id = ?', now, user.uid, user.uid, now, cur.id);
      notify(aca, 'students');
    }
    return publicStudent(row(aca, id));
  }

  function restore(user, aca, id) {
    const cur = row(aca, id);
    if (cur.deleted_at) {
      db.run('UPDATE students SET deleted_at = NULL, deleted_by = NULL, rev = rev + 1, updated_by = ?, updated_at = ? WHERE id = ?', user.uid, Date.now(), cur.id);
      notify(aca, 'students');
    }
    return publicStudent(row(aca, id));
  }

  /** 학원 사람들의 통합 클라우드에 "명단·AI 를 다시 받으세요" 알림 */
  function notify(aca, kind) {
    events?.publishAcademyInfo?.(aca, kind);
  }

  // ---------------- 완전 삭제 (주기 작업) ----------------
  function purgeTargets(aca, ids) {
    const rows = ids == null
      ? db.all('SELECT * FROM students WHERE academy_id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL', aca)
      : [...new Set(ids)].map((id) => row(aca, id));
    if (rows.some((s) => !s.deleted_at)) throw bad('먼저 학생을 삭제하세요.', 'student_active');
    return rows;
  }

  function purgeFiles(s) {
    return db.all("SELECT * FROM shared_files WHERE academy_id = ? AND ((path >= ? AND path < ?) OR path = ?)",
      s.academy_id, `students/${s.id}/`, `students/${s.id}0`, `students/${s.id}.json`);
  }

  function purgePreview(aca, ids) {
    const rows = purgeTargets(aca, ids);
    let files = 0, accounts = 0;
    for (const s of rows) {
      files += purgeFiles(s).filter((f) => !f.deleted).length;
      for (const u of db.all('SELECT * FROM users WHERE student_id = ? AND academy_id = ?', s.id, aca)) {
        accounts += 1;
        files += db.get('SELECT COUNT(*) AS n FROM files WHERE user_id = ? AND deleted = 0', u.id).n;
        const prefix = `members/${u.uid}/`;
        files += db.get('SELECT COUNT(*) AS n FROM shared_files WHERE academy_id = ? AND deleted = 0 AND substr(path, 1, ?) = ?', aca, prefix.length, prefix).n;
      }
    }
    return { students: rows.length, accounts, files };
  }

  function purge(aca, ids, ctx = { actorLabel: '서버' }, manual = true, now = Date.now()) {
    const { userFiles, deleteUser } = require('./hard-delete');
    const rows = purgeTargets(aca, ids), candidates = [], touched = new Map();
    const inquiryPhotos = [];
    const counts = purgePreview(aca, ids);
    db.tx(() => {
      for (const s of rows) {
        const single = purgePreview(aca, [s.id]);
        for (const u of db.all('SELECT * FROM users WHERE student_id = ? AND academy_id = ?', s.id, aca)) {
          inquiryPhotos.push(...(inquiries?.userPhotos(u) || []));
          candidates.push(...userFiles(db, u));
          for (const [app, seq] of deleteUser(db, u, nextSeq)) touched.set(app, seq);
        }
        db.run('DELETE FROM guardians WHERE student_id = ? AND academy_id = ?', s.id, aca);
        db.run('DELETE FROM student_invites WHERE student_id = ? AND academy_id = ?', s.id, aca);
        for (const f of purgeFiles(s)) {
          candidates.push(f);
          const seq = nextSeq();
          db.run('UPDATE shared_files SET rev = rev + 1, seq = ?, sha256 = NULL, size = 0, mtime = NULL, deleted = 1, device_id = NULL, updated_by = NULL, updated_at = ? WHERE id = ?', seq, now, f.id);
          touched.set(f.app_id, seq);
        }
        db.run("DELETE FROM shared_items WHERE academy_id = ? AND (item = ? OR substr(item, 1, ?) = ?)", aca, `students/${s.id}`, `students/${s.id}/`.length, `students/${s.id}/`);
        db.run("UPDATE students SET name = '', school = '', school_office = '', school_code = '', grade = '', memo = '', teacher_uid = NULL, created_by = NULL, updated_by = NULL, deleted_by = NULL, created_at = 0, updated_at = 0, deleted_at = NULL, rev = 0, purged_at = ? WHERE id = ? AND academy_id = ?", now, s.id, aca);
        svc.audit(ctx, 'student.purge', s.name, { id: s.id, manual, ...single }, aca);
      }
    });
    inquiries?.removeFiles(inquiryPhotos);
    const blobsRemoved = blobs.removeUnreferenced(candidates);
    for (const [appId, seq] of touched) events?.publishAcademy(aca, appId, seq, null);
    if (rows.length) notify(aca, 'students');
    return { ...counts, blobs: blobsRemoved };
  }

  function purgeExpired(now = Date.now()) {
    const due = db.all('SELECT id, academy_id FROM students WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND deleted_at < ?', now - purgeDays * DAY);
    let files = 0;
    for (const s of due) files += purge(s.academy_id, [s.id], undefined, false, now).files;
    return { students: due.length, files };
  }

  // ---------------- 예전 오답노트 데이터 ----------------
  function readBlobJson(sha) {
    if (!sha || !blobs.has(sha)) return null;
    try {
      const file = blobs.pathFor(sha);
      if (fs.statSync(file).size > LEGACY_MAX_BYTES) return null; // 학생·노트 JSON 이 아님
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  /** 학원 공간에 올라온 예전 학생 파일 하나 → 명단 (없을 때만) */
  function importLegacyStudent(aca, p, sha) {
    const m = LEGACY_STUDENT_RE.exec(p);
    if (!m || db.get('SELECT 1 FROM students WHERE id = ?', m[1])) return false;
    const s = readBlobJson(sha);
    const name = str(s?.name, 40);
    if (!name) return false;
    const by = typeof s.createdBy?.id === 'string' && db.get('SELECT uid FROM users WHERE uid = ? AND academy_id = ?', s.createdBy.id, aca) ? s.createdBy.id : null;
    const at = Number.isFinite(s.createdAt) ? s.createdAt : Date.now();
    let school;
    try { school = schoolFields(s); } catch { return false; }
    db.run(
      `INSERT INTO students(id, academy_id, name, school, school_office, school_code, grade, teacher_uid, memo, rev, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      m[1],
      aca,
      name,
      school.school ?? '',
      school.school_office ?? '',
      school.school_code ?? '',
      str(s.grade, 20),
      by,
      str(s.memo, 500),
      by,
      by,
      at,
      Number.isFinite(s.updatedAt) ? s.updatedAt : at,
    );
    return true;
  }

  /** 예전 오답노트 academy.json 의 AI 키 → 그 학원의 기본 AI (이미 있으면 그대로) */
  function importLegacyAi(aca, sha) {
    if (db.get("SELECT 1 FROM academy_ai WHERE academy_id = ? AND app_id = ''", aca)) return false;
    const keys = readBlobJson(sha)?.ai || {};
    const config = keys.geminiApiKey
      ? { provider: 'gemini', apiKey: keys.geminiApiKey }
      : keys.anthropicApiKey
        ? { provider: 'anthropic', apiKey: keys.anthropicApiKey }
        : null;
    if (!config) return false;
    writeAi(aca, '', config, null);
    notify(aca, 'ai');
    return true;
  }

  /** 서버를 켤 때: 모든 학원의 예전 학생 파일과 academy.json 의 AI 키 */
  function importLegacy() {
    let students = 0;
    let ai = 0;
    const touched = new Set();
    const rows = db.all(
      "SELECT academy_id, path, sha256 FROM shared_files WHERE app_id = ? AND deleted = 0 AND path GLOB 'students/*.json' AND path NOT GLOB 'students/*/*'",
      OHDAP,
    );
    db.tx(() => {
      for (const f of rows) {
        if (importLegacyStudent(f.academy_id, f.path, f.sha256)) {
          students += 1;
          touched.add(f.academy_id);
        }
      }
    });
    for (const f of db.all("SELECT academy_id, sha256 FROM shared_files WHERE app_id = ? AND path = 'academy.json' AND deleted = 0", OHDAP)) {
      if (importLegacyAi(f.academy_id, f.sha256)) ai += 1;
    }
    for (const aca of touched) notify(aca, 'students');
    if (students || ai) log.info(`[학생 명단] 예전 오답노트에서 학생 ${students}명, 학원 AI ${ai}곳을 가져왔어요.`);
    return { students, ai };
  }

  /** 학원 공간에 파일이 올라온 뒤 (routes/shared.js): 0.3 이 새로 만든 학생·원장이 넣은 학원 AI 키도 */
  function onSharedPut(aca, appId, p, sha) {
    if (appId !== OHDAP) return;
    try {
      if (LEGACY_STUDENT_RE.test(p) && importLegacyStudent(aca, p, sha)) notify(aca, 'students');
      if (p === LEGACY_SETTINGS) importLegacyAi(aca, sha);
    } catch (err) {
      log.warn('[학생 명단] 예전 오답노트 데이터를 가져오지 못했어요', err.message);
    }
  }

  /**
   * 오답노트 0.4 가 배포된 뒤(카탈로그의 최신 버전으로 판단): 선생님 폴더의 노트를 학생 폴더로 옮긴다.
   * 0.4 를 열지 않은 선생님·그만둔 선생님의 노트도 옮겨진다. 학생을 못 찾은 노트는 그대로 (학생 미지정).
   */
  function moveLegacyNotes({ force = false } = {}) {
    const ver = catalog?.get(OHDAP)?.release?.version;
    if (!force && !(ver && compareVersions(ver, NOTES_FROM) >= 0)) return { moved: 0, skipped: true };
    let moved = 0;
    const touched = new Map(); // 학원 → 마지막 seq
    const rows = db.all("SELECT * FROM shared_files WHERE app_id = ? AND deleted = 0 AND path GLOB 'members/*/notes/*.json'", OHDAP);
    for (const f of rows) {
      const m = LEGACY_NOTE_RE.exec(f.path);
      if (!m) continue;
      const note = readBlobJson(f.sha256);
      if (!note) continue;
      const sid = findStudent(f.academy_id, note);
      if (!sid) continue;
      const to = `students/${sid}/notes/${m[2]}.json`;
      db.tx(() => {
        const src = db.get('SELECT * FROM shared_files WHERE id = ?', f.id);
        if (!src || src.deleted || src.rev !== f.rev) return; // 그사이 바뀜 → 다음에
        const dst = db.get('SELECT * FROM shared_files WHERE academy_id = ? AND app_id = ? AND path = ?', f.academy_id, OHDAP, to);
        if (dst && !dst.deleted) return; // 이미 있음 (다른 PC 에서 먼저 옮김)
        const now = Date.now();
        const s1 = nextSeq();
        if (dst) {
          db.run(
            'UPDATE shared_files SET rev = rev + 1, seq = ?, sha256 = ?, size = ?, mtime = ?, deleted = 0, device_id = NULL, updated_by = ?, updated_at = ? WHERE id = ?',
            s1, src.sha256, src.size, src.mtime, src.updated_by, now, dst.id,
          );
        } else {
          db.run(
            `INSERT INTO shared_files(academy_id, app_id, path, rev, seq, sha256, size, mtime, deleted, device_id, updated_by, updated_at)
             VALUES (?, ?, ?, 1, ?, ?, ?, ?, 0, NULL, ?, ?)`,
            f.academy_id, OHDAP, to, s1, src.sha256, src.size, src.mtime, src.updated_by, now,
          );
        }
        const s2 = nextSeq();
        db.run('UPDATE shared_files SET rev = rev + 1, seq = ?, sha256 = NULL, size = 0, deleted = 1, device_id = NULL, updated_at = ? WHERE id = ?', s2, now, src.id);
        touched.set(f.academy_id, s2);
        moved += 1;
      });
    }
    for (const [aca, seq] of touched) events?.publishAcademy(aca, OHDAP, seq, null);
    if (moved) {
      log.info(`[오답노트] 선생님 폴더의 노트 ${moved}개를 학생별 폴더로 옮겼어요.`);
      svc.audit({ actorLabel: '서버' }, 'ohdapnote.move_notes', '', { moved });
    }
    return { moved, skipped: false };
  }

  /** 노트의 학생: studentId 가 명단에 있으면 그 학생, 아니면 이름이 정확히 하나 맞는 학생 (지운 학생 포함, 완전히 지운 학생 제외) */
  function findStudent(aca, note) {
    if (typeof note.studentId === 'string' && note.studentId) {
      const r = db.get('SELECT id FROM students WHERE id = ? AND academy_id = ? AND purged_at IS NULL', note.studentId, aca);
      if (r) return r.id;
    }
    const name = str(note.student, 40);
    if (!name) return null;
    const same = db.all('SELECT id FROM students WHERE academy_id = ? AND name = ? AND purged_at IS NULL', aca, name);
    return same.length === 1 ? same[0].id : null;
  }

  // ---------------- 학원 공용 AI ----------------
  function readAi(aca, appId) {
    const r = db.get('SELECT * FROM academy_ai WHERE academy_id = ? AND app_id = ?', aca, appId);
    if (!r) return null;
    const c = jsonParse(unseal(aiKey, r.config_enc), null);
    return c ? { ...c, updatedBy: r.updated_by || null, updatedAt: r.updated_at } : null;
  }

  function writeAi(aca, appId, config, user) {
    if (!config) {
      db.run('DELETE FROM academy_ai WHERE academy_id = ? AND app_id = ?', aca, appId);
      return;
    }
    db.run(
      `INSERT INTO academy_ai(academy_id, app_id, config_enc, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(academy_id, app_id) DO UPDATE SET config_enc = excluded.config_enc, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      aca,
      appId,
      seal(aiKey, JSON.stringify(config)),
      user ? user.uid : null,
      Date.now(),
    );
  }

  const clean = ({ provider, apiKey, model, model2, baseUrl, rpm }) => ({ provider, apiKey, model, model2, baseUrl, rpm });

  /** 프로그램이 쓸 AI: 그 프로그램 것 → 기본 (없으면 null) */
  function aiFor(aca, appId) {
    const own = appId ? readAi(aca, appId) : null;
    if (own) return { ...clean(own), source: 'app' };
    const def = readAi(aca, '');
    return def ? { ...clean(def), source: 'default' } : null;
  }

  function mask(c) {
    if (!c) return null;
    const k = String(c.apiKey || '');
    return { ...clean(c), apiKey: undefined, keyHint: k ? `••••${k.slice(-4)}` : '', updatedAt: c.updatedAt };
  }

  function aiAll(aca) {
    const out = { default: mask(readAi(aca, '')), apps: {} };
    for (const r of db.all("SELECT app_id FROM academy_ai WHERE academy_id = ? AND app_id != ''", aca)) out.apps[r.app_id] = mask(readAi(aca, r.app_id));
    return out;
  }

  function parseAi(body, cur) {
    const provider = String(body.provider || '');
    if (!PROVIDERS.includes(provider)) throw bad('AI 종류를 골라 주세요. (Gemini · OpenAI 호환 · Claude)', 'invalid_provider');
    let apiKey = body.apiKey === undefined ? (cur?.provider === provider ? cur.apiKey : '') : str(body.apiKey, 300);
    const baseUrl = str(body.baseUrl, 300);
    if (baseUrl && !/^https?:\/\/[^\s]+$/i.test(baseUrl)) throw bad('주소는 http:// 또는 https:// 로 시작해야 해요.', 'invalid_url');
    if (!apiKey && provider !== 'openai') throw bad('API 키를 입력해 주세요.', 'invalid_key');
    if (provider === 'openai' && !baseUrl && !apiKey) throw bad('OpenAI 호환은 주소나 API 키가 있어야 해요.', 'invalid_key');
    apiKey = apiKey || '';
    return {
      provider,
      apiKey,
      model: str(body.model, 100),
      model2: str(body.model2, 100),
      baseUrl,
      rpm: body.rpm === undefined || body.rpm === '' || body.rpm === null ? null : intOr(body.rpm, null, 1, 1000),
    };
  }

  function setAi(user, aca, appId, body) {
    const id = String(appId || '');
    if (id && !db.get('SELECT 1 FROM apps WHERE id = ?', id)) throw notFound('프로그램을 찾을 수 없어요.');
    const config = body === null ? null : parseAi(body, readAi(aca, id));
    writeAi(aca, id, config, user);
    notify(aca, 'ai');
    return aiAll(aca);
  }

  return {
    state,
    stateMap,
    list,
    members,
    create,
    update,
    remove,
    restore,
    publicStudent,
    purgeExpired,
    purge,
    purgePreview,
    importLegacy,
    onSharedPut,
    moveLegacyNotes,
    aiFor,
    aiAll,
    setAi,
    purgeDays,
  };
}

module.exports = { createStudents, PROVIDERS, OHDAP, LEGACY_SETTINGS };
