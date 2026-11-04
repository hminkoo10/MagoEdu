'use strict';

// 과목내비와 같은 나이스 학교 코드. 학원 명단에는 초·중·고를 모두 포함한다.
const { HttpError, bad } = require('./util');
const { RateLimiter } = require('./security');

const KINDS = new Set(['초등학교', '중학교', '고등학교']);
const regionOf = (office) => /\(([^()]+)\)\s*$/.exec(office)?.[1].trim() || office.replace(/(특별자치|특별|광역)?(시|도)?교육청$/, '').trim();

async function searchSchools(q, key, fetchImpl = fetch) {
  const params = new URLSearchParams({ Type: 'json', pIndex: '1', pSize: '10', SCHUL_NM: q });
  if (key) params.set('KEY', key);
  const res = await fetchImpl(`https://open.neis.go.kr/hub/schoolInfo?${params}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`neis ${res.status}`);
  const data = await res.json();
  // 나이스는 실패도 HTTP 200으로 보낸다. 자료 없음만 빈 결과로 기억한다.
  if (data?.RESULT?.CODE === 'INFO-200') return [];
  if (data?.RESULT) throw new Error('neis result');
  const head = data?.schoolInfo?.[0]?.head;
  if (Array.isArray(head) && head.some((h) => h.RESULT && h.RESULT.CODE !== 'INFO-000')) throw new Error('neis result');
  const rows = data?.schoolInfo?.[1]?.row;
  if (!Array.isArray(rows)) throw new Error('neis rows');
  const text = (v) => typeof v === 'string' ? v : '';
  return rows.filter((r) => r && KINDS.has(r.SCHUL_KND_SC_NM)
    && /^[A-Z][0-9]{2}$/.test(text(r.ATPT_OFCDC_SC_CODE)) && /^[0-9]{7}$/.test(text(r.SD_SCHUL_CODE)) && text(r.SCHUL_NM).trim())
    .slice(0, 10).map((r) => ({
      office: r.ATPT_OFCDC_SC_CODE,
      code: r.SD_SCHUL_CODE,
      name: r.SCHUL_NM,
      kind: r.SCHUL_KND_SC_NM,
      region: regionOf(text(r.ATPT_OFCDC_SC_NM)),
      address: text(r.ORG_RDNMA),
    }));
}

function createSchoolSearch({ key, fetchImpl = fetch, now = Date.now, cacheSize = 300, cacheTtlMs = 24 * 3600_000 } = {}) {
  const cache = new Map();
  const limiter = new RateLimiter({ max: 40, windowMs: 60_000 });
  return async (userId, query) => {
    const q = typeof query === 'string' ? query.trim() : '';
    if (q.length < 2 || q.length > 20 || !/^[가-힣A-Za-z0-9 ]+$/.test(q)) throw bad('학교 이름을 2~20자로 적어 주세요.');
    const at = now();
    // 캐시를 읽어도 사용자당 요청 수는 센다. 여러 기기도 같은 계정 한도를 공유한다.
    if (limiter.blocked(userId, at)) throw new HttpError(429, '잠시 뒤 다시 검색해 주세요.', 'rate_limited');
    limiter.hit(userId, at);
    const cached = cache.get(q);
    cache.delete(q);
    if (cached && cached.until > at) {
      cache.set(q, cached);
      return { schools: cached.schools };
    }
    let schools;
    try {
      schools = await searchSchools(q, key, fetchImpl);
    } catch {
      throw new HttpError(502, '학교 검색 서버에 연결하지 못했어요.');
    }
    cache.set(q, { schools, until: now() + cacheTtlMs });
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    return { schools };
  };
}

module.exports = { searchSchools, createSchoolSearch };
