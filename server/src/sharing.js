'use strict';

// 학원 공간: 같은 학원 사람들이 프로그램 하나의 파일을 함께 쓴다 (예: 오답노트 교재)
//
// 누가 보고 누가 쓰는지는 경로로 정한다 (어느 프로그램이든 같음).
//   members/<계정 uid>/...  그 사람과 원장만 봄, 그 사람만 씀           (예: 선생님마다 만든 오답노트)
//                           uid 는 프로그램이 받는 MAGOEDU_USER_ID 와 같다
//   <폴더>/<이름>[/...]     모두 봄, 처음 올린 사람(주인)과 원장만 씀   (예: books/<교재 ID>/book.json)
//                           주인은 앞의 두 단계(<폴더>/<이름>, '묶음')마다 정해진다
//   <파일>                  모두 봄, 원장만 씀                          (예: academy.json 학원 공용 설정)
// 운영자는 원장과 같다 (학원이 있을 때).

const MEMBERS = 'members';

const isManager = (user) => user.role === 'director' || user.role === 'admin';

/** 경로 → { kind: 'member' | 'item' | 'top', uid?, item? }. members/<uid>/... 꼴이 아니면 null (쓸 수 없는 경로) */
function classify(p) {
  const seg = p.split('/');
  if (seg[0] === MEMBERS) {
    if (seg.length < 3 || !/^[A-Za-z0-9-]{1,64}$/.test(seg[1])) return null;
    return { kind: 'member', uid: seg[1] };
  }
  if (seg.length === 1) return { kind: 'top' };
  return { kind: 'item', item: `${seg[0]}/${seg[1]}` };
}

function canRead(user, p) {
  const c = classify(p);
  if (!c) return false;
  return c.kind !== 'member' || c.uid === user.uid || isManager(user);
}

/** owner: 그 묶음의 주인 계정 ID (users.id, 아직 없으면 null) */
function canWrite(user, p, owner) {
  const c = classify(p);
  if (!c) return false;
  if (c.kind === 'member') return c.uid === user.uid;
  if (c.kind === 'top') return isManager(user);
  return owner == null || owner === user.id || isManager(user);
}

module.exports = { classify, canRead, canWrite, isManager, MEMBERS };
