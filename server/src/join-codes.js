'use strict';

const { RateLimiter } = require('./security');
const { HttpError, sha256Hex } = require('./util');

// 조회·가입·옛 초대 주소가 같은 실패 횟수를 쓴다. 경로를 바꿔도 한도가 늘지 않는다.
function createJoinCodes(db) {
  const limit = new RateLimiter({ max: 20, windowMs: 10 * 60 * 1000 });
  return {
    check(ip) {
      const wait = limit.blocked(ip);
      if (wait) throw new HttpError(429, '너무 여러 번 시도했어요. 잠시 뒤 다시 해 주세요.', 'rate_limited', { retryAfter: wait });
    },
    invalid(ip, status = 404) {
      limit.hit(ip);
      throw new HttpError(status, '코드를 다시 확인해 주세요', 'invalid_code');
    },
    director(code) {
      const c = db.get('SELECT * FROM signup_codes WHERE code = ?', String(code || '').trim().toUpperCase());
      return c && !c.revoked && (!c.expires_at || c.expires_at >= Date.now()) && c.uses < c.max_uses ? c : null;
    },
    teacher(code) {
      return db.get(`SELECT i.*, a.name AS academy_name FROM teacher_invites i
        JOIN academies a ON a.id = i.academy_id WHERE i.code_hash = ? AND i.expires_at > ?`,
      sha256Hex(String(code || '').trim()), Date.now());
    },
    guardian(code) {
      return db.get(`SELECT i.*, a.name AS academy_name, s.name AS student_name, s.id AS student_id
        FROM guardian_invites i JOIN guardians g ON g.id = i.guardian_id AND g.academy_id = i.academy_id
        JOIN academies a ON a.id = i.academy_id JOIN students s ON s.id = g.student_id AND s.academy_id = i.academy_id
        WHERE i.code_hash = ? AND i.used_at IS NULL AND i.expires_at > ? AND g.user_id IS NULL
        AND s.deleted_at IS NULL AND s.purged_at IS NULL`, sha256Hex(String(code || '').trim()), Date.now());
    },
    student(code) {
      return db.get(`SELECT i.*, a.name AS academy_name, s.name AS student_name FROM student_invites i
        JOIN academies a ON a.id = i.academy_id JOIN students s ON s.id = i.student_id AND s.academy_id = i.academy_id
        WHERE i.code_hash = ? AND i.used_at IS NULL AND i.expires_at > ? AND s.deleted_at IS NULL AND s.purged_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM users WHERE student_id = s.id)`, sha256Hex(String(code || '').trim()), Date.now());
    },
  };
}

module.exports = { createJoinCodes };
