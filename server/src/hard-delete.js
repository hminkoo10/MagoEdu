'use strict';

// Call inside db.tx; remove blobs only after the transaction commits.
function userFiles(db, u) {
  const prefix = `members/${u.uid}/`;
  return db.all(`SELECT sha256 FROM files WHERE user_id = ? UNION ALL
    SELECT sha256 FROM shared_files WHERE academy_id = ? AND substr(path, 1, ?) = ?`,
  u.id, u.academy_id, prefix.length, prefix);
}

function deleteUser(db, u, nextSeq) {
  const touched = new Map();
  const prefix = `members/${u.uid}/`;
  for (const f of db.all('SELECT id, app_id FROM shared_files WHERE academy_id = ? AND substr(path, 1, ?) = ?', u.academy_id, prefix.length, prefix)) {
    const seq = nextSeq();
    db.run('UPDATE shared_files SET rev = rev + 1, seq = ?, sha256 = NULL, size = 0, mtime = NULL, deleted = 1, device_id = NULL, updated_by = NULL, updated_at = ? WHERE id = ?', seq, Date.now(), f.id);
    touched.set(f.app_id, seq);
  }
  db.run('DELETE FROM shared_items WHERE academy_id = ? AND owner_id = ?', u.academy_id, u.id);
  db.run('UPDATE students SET teacher_uid = NULL WHERE academy_id = ? AND teacher_uid = ?', u.academy_id, u.uid);
  for (const col of ['created_by', 'updated_by', 'deleted_by']) db.run(`UPDATE students SET ${col} = NULL WHERE ${col} = ? AND academy_id IS ?`, u.uid, u.academy_id);
  db.run('UPDATE academy_ai SET updated_by = NULL WHERE updated_by = ? AND academy_id IS ?', u.uid, u.academy_id);
  db.run('UPDATE shared_files SET updated_by = NULL WHERE updated_by = ? AND academy_id IS ?', u.uid, u.academy_id);
  db.run('UPDATE notices SET author_id = NULL, author_name = NULL WHERE author_id = ? AND academy_id IS ?', u.id, u.academy_id);
  db.run('UPDATE users SET created_by = NULL WHERE created_by = ?', u.id);
  db.run('DELETE FROM teacher_invites WHERE created_by = ?', u.id);
  db.run('UPDATE signup_codes SET created_by = NULL WHERE created_by = ?', u.id);
  db.run("DELETE FROM audit WHERE (actor_id = ? AND action IN ('login', 'logout', 'session.revoke', 'session.revoke_others')) OR (action = 'login.failed' AND target = ?)", u.id, `${u.name} (${u.username})`);
  db.run('DELETE FROM inquiry_photos WHERE user_id = ? AND inquiry_id IS NULL', u.id);
  db.run('DELETE FROM users WHERE id = ?', u.id);
  return touched;
}

module.exports = { userFiles, deleteUser };
