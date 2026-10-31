'use strict';

// 동기화 규칙: 어떤 파일을 올릴지(include/exclude), 어떤 폴더를 한 묶음(group)으로 볼지
//   "*"  : 폴더 구분(/)을 넘지 않는 아무 글자
//   "**" : 폴더를 넘어 아무 글자
//   "?"  : 아무 글자 하나

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" 는 폴더가 없어도 맞음
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

// 언제나 빼는 것: 통합 클라우드가 쓰는 임시 파일, 운영체제가 만드는 파일
const ALWAYS_EXCLUDE = ['**/*.magoedu-dl', '**/*.magoedu-dl.part', '**/.magoedu*', '**/Thumbs.db', '**/desktop.ini', '**/.DS_Store', '**/~$*'];

function compileRules(sync = {}) {
  const include = (sync.include && sync.include.length ? sync.include : ['**']).map(globToRegExp);
  const exclude = [...ALWAYS_EXCLUDE, ...(sync.exclude || [])].map(globToRegExp);
  const groups = (sync.groups || []).map((g) => {
    const pattern = String(g.pattern || '').replace(/\/+$/, '');
    return { pattern, depth: pattern.split('/').length, re: globToRegExp(pattern), cold: !!g.cold };
  });
  return {
    wants(rel) {
      return include.some((r) => r.test(rel)) && !exclude.some((r) => r.test(rel));
    },
    /** 파일이 속한 묶음 경로 (없으면 '') */
    groupOf(rel) {
      const parts = rel.split('/');
      for (const g of groups) {
        if (parts.length <= g.depth) continue; // 묶음 폴더 "안"에 있어야 함
        const prefix = parts.slice(0, g.depth).join('/');
        if (g.re.test(prefix)) return prefix;
      }
      return '';
    },
  };
}

module.exports = { globToRegExp, compileRules, ALWAYS_EXCLUDE };
