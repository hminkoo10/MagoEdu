'use strict';

// 오답노트의 exporter.js·store.js 형식과 배치 규칙을 서버에서도 쓴다.
const fs = require('node:fs');
const path = require('node:path');
const fontkit = require('./vendor/fontkit');
const {
  PDFDocument, PDFContext, PDFPageEmbedder, rgb, degrees,
  pushGraphicsState, popGraphicsState, rectangle, clip, endPath,
} = require('./vendor/pdf-lib');

// 글꼴 바이트는 시작할 때 한 번만 읽고, 문서마다 필요한 글자만 넣는다.
const FONT_BYTES = {
  regular: fs.readFileSync(path.join(__dirname, 'vendor/fonts/Pretendard-Regular.ttf')),
  bold: fs.readFileSync(path.join(__dirname, 'vendor/fonts/Pretendard-Bold.ttf')),
};

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = { top: 46, bottom: 42, left: 38, right: 38 };
const COL_GAP = 22;
const BLOCK_GAP = 16;
const SEG_GAP = 4;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const UNAVAILABLE = '이 문항은 원본을 열 수 없어 넣지 못했어요';
const NO_ANSWER = '(답지에서 짝이 되는 해설을 찾지 못했어요)';
const DEFAULT_OPTIONS = { columns: 1, space: 'small', labels: true, bothOrder: 'append', renumber: true };
const GRAY = (v) => rgb(v, v, v);

function sortItems(items) {
  const pos = (a, b) => {
    const r = a.rects?.[0] || { x: 0, y: 0 };
    const s = b.rects?.[0] || { x: 0, y: 0 };
    return Math.abs(r.y - s.y) < 0.008 ? r.x - s.x : r.y - s.y;
  };
  return [...items].sort((a, b) => a.page - b.page || (a.zone ?? 0) - (b.zone ?? 0) || (a.col ?? 0) - (b.col ?? 0) || pos(a, b));
}

async function textWriter(out) {
  out.registerFontkit(fontkit);
  const regular = await out.embedFont(FONT_BYTES.regular, { subset: true });
  const bold = await out.embedFont(FONT_BYTES.bold, { subset: true });
  return (page, value, x, top, size = 9, maxWidth = A4.w, gray = 0.2, heading = false) => {
    const font = heading ? bold : regular;
    let text = String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[\uD800-\uDFFF]/g, '?');
    if (font.widthOfTextAtSize(text, size) > maxWidth) {
      while (text.length && font.widthOfTextAtSize(`${text}…`, size) > maxWidth) text = text.slice(0, -1);
      text += '…';
    }
    page.drawText(text, { x, y: top - size, size, font, color: GRAY(gray) });
    return font.widthOfTextAtSize(text, size);
  };
}

async function readBook(note, id, readFile) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const dirs = [`books/${id}`];
  for (const uid of [note.createdBy?.id, note.updatedBy?.id]) {
    if (typeof uid === 'string' && ID_RE.test(uid)) dirs.push(`members/${uid}/books/${id}`);
  }
  const fallback = await readFile.findBook?.(id);
  if (fallback) dirs.push(fallback);
  for (const dir of new Set(dirs)) {
    try {
      const book = JSON.parse(await readFile(`${dir}/book.json`));
      if (book?.id === id && book.docs) return { book, dir };
    } catch (err) {
      if (!(err instanceof SyntaxError) && err.status !== 404 && err.code !== 'ENOENT') throw err;
    }
  }
  return null;
}

function validRect(r) {
  return r && Number.isInteger(r.page) && r.page >= 0 && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(r[k])) &&
    r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= 1.000001 && r.y + r.h <= 1.000001;
}

function sourceReader(out, readFile) {
  const files = new Map();
  const sources = new Map();
  const checkedPages = new WeakMap();
  async function openFile(dir, file) {
    if (!file || typeof file.name !== 'string' || !/^(problem|answer)-[^/\\\x00-\x1f]+$/.test(file.name) || file.name.includes('..')) throw new Error(UNAVAILABLE);
    const path = `${dir}/${file.name}`;
    if (!files.has(path)) files.set(path, (async () => {
      const bytes = new Uint8Array(await readFile(path));
      if (file.kind === 'pdf') return { pdf: await PDFDocument.load(bytes, { updateMetadata: false }) };
      const image = bytes[0] === 137 ? await out.embedPng(bytes) : await out.embedJpg(bytes);
      return { image };
    })());
    return files.get(path);
  }
  async function pagesOf(entry, role) {
    const key = `${entry.dir}/${role}`;
    if (!sources.has(key)) sources.set(key, (async () => {
      const doc = entry.book.docs[role];
      const parts = [];
      for (const file of doc?.files || []) {
        try {
          const source = await openFile(entry.dir, file);
          parts.push(source.pdf ? source.pdf.getPages().map((page) => ({ page })) : [source]);
        } catch {
          parts.push(file.kind !== 'pdf' ? [null] : Number.isInteger(file.pageCount) && file.pageCount > 0 ? Array(file.pageCount).fill(null) : null);
        }
      }
      const missing = parts.filter((p) => p === null).length;
      const known = parts.reduce((n, p) => n + (p?.length || 0), 0);
      const remaining = Number.isInteger(doc?.pageCount) ? doc.pageCount - known : 0;
      const pages = [];
      for (const part of parts) {
        if (part) pages.push(...part);
        else if (missing === 1 && remaining > 0) pages.push(...Array(remaining).fill(null));
        // 쪽 수를 모르면 뒤의 쪽을 앞당겨 잘못된 문항을 싣지 않는다.
        else break;
      }
      return pages;
    })());
    return sources.get(key);
  }
  return async (entry, role, item) => {
    try {
      const rects = [...(role === 'problem' ? item?.stem || [] : []), ...(item?.rects || [])];
      if (!rects.length || !rects.every(validRect)) throw new Error(UNAVAILABLE);
      const pages = await pagesOf(entry, role);
      const segments = [];
      for (const r of rects) {
        const source = pages[r.page];
        if (!source) throw new Error(UNAVAILABLE);
        if (source.page) {
          const page = source.page;
          // 실패한 embed가 출력 문서에 남으면 save 때 다시 실패하므로 먼저 따로 확인한다.
          if (!checkedPages.has(page)) checkedPages.set(page, (async () => {
            const embedder = await PDFPageEmbedder.for(page.node);
            await embedder.embedIntoContext(PDFContext.create());
          })());
          await checkedPages.get(page);
          const crop = page.getCropBox();
          const angle = ((page.getRotation().angle % 360) + 360) % 360;
          if (![0, 90, 180, 270].includes(angle)) throw new Error(UNAVAILABLE);
          const viewW = angle % 180 ? crop.height : crop.width;
          const viewH = angle % 180 ? crop.width : crop.height;
          const point = (x, y) => {
            if (angle === 90) return [crop.x + y * crop.width, crop.y + x * crop.height];
            if (angle === 180) return [crop.x + (1 - x) * crop.width, crop.y + y * crop.height];
            if (angle === 270) return [crop.x + (1 - y) * crop.width, crop.y + (1 - x) * crop.height];
            return [crop.x + x * crop.width, crop.y + (1 - y) * crop.height];
          };
          const p = point(r.x, r.y);
          const q = point(r.x + r.w, r.y + r.h);
          const embedded = await out.embedPage(page, { left: Math.min(p[0], q[0]), bottom: Math.min(p[1], q[1]), right: Math.max(p[0], q[0]), top: Math.max(p[1], q[1]) });
          await embedded.embed(); // 깨진 스트림도 저장 때가 아니라 이 문항에서 처리
          const unit = viewW > 1000 || viewW < 300 ? A4.w / viewW : 1;
          segments.push({ embedded, angle, w: r.w * viewW * unit, h: r.h * viewH * unit, rect: r });
        } else {
          const h = A4.w * source.image.height / source.image.width;
          segments.push({ image: source.image, w: r.w * A4.w, h: r.h * h, rect: r });
        }
      }
      return { segments };
    } catch {
      return { segments: [], text: UNAVAILABLE };
    }
  };
}

/** 노트와 학원 공간 파일 읽기 함수만 받아 PDF 바이트를 만든다. 입력 객체는 바꾸지 않는다. */
async function buildNotesPdf(note, readFile) {
  const out = await PDFDocument.create();
  out.setTitle(note.title || '오답노트');
  out.setCreator('오답노트');
  out.setProducer('오답노트 (pdf-lib)');
  const text = await textWriter(out);
  const options = { ...DEFAULT_OPTIONS, ...note.exportOptions };
  const allowed = note.answersForStudent === true;
  const inline = allowed && options.bothOrder === 'interleave';
  const segment = sourceReader(out, readFile);
  const problems = [];
  const answers = [];
  let num = 0;
  for (const id of Array.isArray(note.bookIds) ? note.bookIds : []) {
    const selected = new Set(Array.isArray(note.selected?.[id]) ? note.selected[id] : []);
    if (!selected.size) continue;
    const entry = await readBook(note, id, readFile);
    if (!entry) {
      for (let i = 0; i < selected.size; i++) {
        num++;
        problems.push({ num, source: '', segments: [], text: UNAVAILABLE });
        if (allowed) answers.push({ num, source: '해설', segments: [], text: UNAVAILABLE });
      }
      continue;
    }
    const items = sortItems(entry.book.docs.problem?.items || []);
    const answerItems = allowed ? sortItems(entry.book.docs.answer?.items || []) : [];
    const matches = allowed ? matchItems(items, answerItems) : new Map();
    const answerById = new Map(answerItems.map((item) => [item.id, item]));
    for (const item of items.filter((it) => selected.has(it.id))) {
      num++;
      const where = options.labels ? [note.bookIds.length > 1 ? entry.book.name : '', `p.${item.page + 1 + (entry.book.docs.problem.pageOffset || 0)}`, item.prefix ? `${item.prefix} ${item.number}` : `${item.number}번`].filter(Boolean).join(' ') : '';
      problems.push({ num, source: where, ...await segment(entry, 'problem', item) });
      if (allowed) {
        const overrides = entry.book.answerOverrides || {};
        const aid = Object.hasOwn(overrides, item.id) ? overrides[item.id] : matches.get(item.id);
        const answer = answerById.get(aid);
        answers.push({ num, source: `해설${where ? ` · ${where}` : ''}`, ...answer ? await segment(entry, 'answer', answer) : { segments: [], text: NO_ANSWER } });
      }
    }
  }

  const blocks = inline ? problems.flatMap((p, i) => [p, { ...answers[i], answer: true }, ...(options.space === 'page' ? [{ pagebreak: true }] : [])]) : [
    ...problems.map((p) => ({ ...p, addSpace: true })),
    ...(allowed && answers.length ? [{ section: true }, ...answers.map((a) => ({ ...a, answer: true }))] : []),
  ];
  const cols = options.columns === 2 ? 2 : 1;
  const contentW = A4.w - MARGIN.left - MARGIN.right;
  const colW = (contentW - COL_GAP * (cols - 1)) / cols;
  const fullH = A4.h - MARGIN.top - MARGIN.bottom;
  let page;
  let col = 0;
  let used = 0;
  let headH = 0;
  let available = 0;
  const newPage = () => {
    const first = !page;
    page = out.addPage([A4.w, A4.h]);
    col = 0;
    used = 0;
    headH = first ? 100 : 0;
    available = fullH - headH;
    if (first) {
      text(page, note.academy || '', MARGIN.left, A4.h - 34, 9, contentW * 0.65);
      text(page, note.examDate || '', A4.w - MARGIN.right - 95, A4.h - 34, 9, 95);
      const title = note.title || '오답노트';
      text(page, title, MARGIN.left + 8, A4.h - 54, 22, contentW - 16, 0.05, true);
      text(page, `문제 ${problems.length}문항${allowed ? ' · 정답 및 해설' : ''}`, MARGIN.left + 8, A4.h - 83, 9.5, contentW - 16, 0.4);
      page.drawLine({ start: { x: MARGIN.left, y: A4.h - 104 }, end: { x: A4.w - MARGIN.right, y: A4.h - 104 }, thickness: 1.8, color: GRAY(0.1) });
      const cells = [['학원', note.academy], ['선생님', note.teacher], ['학생', note.student], ['점수', '']];
      cells.forEach(([label, value], i) => {
        const x = MARGIN.left + i * contentW / 4;
        page.drawRectangle({ x, y: A4.h - 132, width: contentW / 4, height: 21, borderWidth: 0.6, borderColor: GRAY(0.55) });
        text(page, label, x + 4, A4.h - 115, 8, 38);
        text(page, value || '', x + 44, A4.h - 115, 8, contentW / 4 - 48);
      });
    } else {
      text(page, [note.academy, note.title || '오답노트'].filter(Boolean).join(' · '), MARGIN.left, A4.h - 26, 7.8, contentW * 0.7, 0.45, true);
      text(page, note.student || '', A4.w - MARGIN.right - contentW * 0.28, A4.h - 26, 7.8, contentW * 0.28, 0.35);
      page.drawLine({ start: { x: MARGIN.left, y: A4.h - 37 }, end: { x: A4.w - MARGIN.right, y: A4.h - 37 }, thickness: 0.6, color: GRAY(0.25) });
    }
    if (cols === 2) page.drawLine({ start: { x: A4.w / 2, y: A4.h - MARGIN.top - headH }, end: { x: A4.w / 2, y: MARGIN.bottom }, thickness: 0.5, color: GRAY(0.72) });
  };
  const nextColumn = () => {
    if (col + 1 < cols) { col++; used = 0; }
    else newPage();
  };
  newPage();
  let pagebreak = false;
  for (const block of blocks) {
    if (block.pagebreak) { pagebreak = true; continue; }
    if (pagebreak || block.section) {
      if (used > 0 || col > 0) newPage();
      pagebreak = false;
    }
    if (block.section) {
      text(page, '정답 및 해설', MARGIN.left, A4.h - MARGIN.top - headH, 14, colW, 0.05, true);
      used += 36;
      continue;
    }
    if (used >= available) nextColumn();
    const labelH = options.renumber || block.source ? 18 : 0;
    const noteH = block.text ? 14 : 0;
    const gaps = SEG_GAP * Math.max(0, block.segments.length - 1);
    const rawH = block.segments.reduce((n, s) => n + s.h, 0);
    let scale = Math.min(1, colW / Math.max(1, ...block.segments.map((s) => s.w)));
    const limit = used > 0 ? fullH : available;
    scale = Math.min(scale, Math.max(0, limit - labelH - noteH - gaps) / Math.max(1, rawH));
    let blockH = labelH + noteH + gaps + rawH * scale;
    if (used > 0 && used + blockH > available) nextColumn();
    if (blockH > available) {
      scale = Math.max(0, available - labelH - noteH - gaps) / Math.max(1, rawH);
      blockH = labelH + noteH + gaps + rawH * scale;
    }
    const x = MARGIN.left + col * (colW + COL_GAP);
    let top = A4.h - MARGIN.top - headH - used;
    if (labelH) {
      const n = options.renumber ? `${block.num}. ` : '';
      text(page, `${n}${block.source}`, x, top, 9, colW, block.answer ? 0.3 : 0.1);
      top -= labelH;
    }
    if (block.text) { text(page, block.text, x + 4, top, 9, colW - 8, 0.5); top -= noteH; }
    for (const s of block.segments) {
      const w = s.w * scale;
      const h = s.h * scale;
      const y = top - h;
      if (s.embedded) {
        const rotated = s.angle % 180 !== 0;
        page.drawPage(s.embedded, {
          x: x + (s.angle === 180 || s.angle === 270 ? w : 0),
          y: y + (s.angle === 90 || s.angle === 180 ? h : 0),
          width: rotated ? h : w, height: rotated ? w : h, rotate: degrees(-s.angle),
        });
      } else {
        const fullW = w / s.rect.w;
        const fullImageH = h / s.rect.h;
        page.pushOperators(pushGraphicsState(), rectangle(x, y, w, h), clip(), endPath());
        page.drawImage(s.image, { x: x - s.rect.x * fullW, y: top - (1 - s.rect.y) * fullImageH, width: fullW, height: fullImageH });
        page.pushOperators(popGraphicsState());
      }
      top -= h + SEG_GAP;
    }
    used += blockH + BLOCK_GAP;
    if (block.addSpace) {
      if (options.space === 'page') pagebreak = true;
      else used += ({ small: 85, large: 227 })[options.space] || 0;
    }
  }
  out.getPages().forEach((p, i, pages) => {
    text(p, `- ${i + 1} -`, A4.w / 2 - 12, 31, 9, 40, 0.35);
    text(p, `${i + 1} / ${pages.length}`, A4.w - MARGIN.right - 36, 29, 7, 36, 0.6);
  });
  return out.save();
}

module.exports = { buildNotesPdf };

// 문제 ↔ 답지(해설) 짝 맞추기
// 두 문서의 번호 순서열을 "최장 공통 부분수열(LCS)"로 정렬합니다.
//  - 책 전체 연번(0001, 0002 …)이면 번호가 그대로 맞춰지고
//  - 단원마다 1번부터 다시 시작해도 "등장 순서"가 맞춰지며
//  - 한쪽에서 빠지거나 더 있는 번호가 있어도 나머지는 올바르게 맞춰집니다.
// 짝의 개수가 같으면(동점) 모양이 같은 짝을 고릅니다:
//  말머리(예제/유제)가 같고, 0 채움(01 / 1)이 같고, 해설 영역이 큰 것(빠른 정답표 칸보다 실제 해설)

const keyOf = (item) => item.num ?? parseInt(item.number, 10);
const paddedOf = (item) => {
  const d = String(item.number ?? '');
  return d.length >= 2 && d[0] === '0' ? d.length : 0;
};
const areaOf = (item) => (item.rects || []).reduce((s, r) => s + (r.w || 0) * (r.h || 0), 0);

/** 짝 하나의 "모양 일치" 점수 (정수, 0 ~ 19) */
function pairBonus(p, a, areaRank) {
  let b = 0;
  if ((p.prefix || '') === (a.prefix || '')) b += 10;
  if (paddedOf(p) === paddedOf(a)) b += 5;
  b += Math.round(4 * areaRank); // 0~4
  return b;
}

/**
 * @param {{id:string,num:number,number?:string,prefix?:string,rects?:object[]}[]} problems  읽는 순서
 * @param {{id:string,num:number,number?:string,prefix?:string,rects?:object[]}[]} answers   읽는 순서
 * @returns {Map<string,string>} 문제 id → 답지 id
 */
function matchItems(problems, answers) {
  const result = new Map();
  const n = problems.length;
  const m = answers.length;
  if (!n || !m) return result;

  if (n * m > 12_000_000) return matchByOccurrence(problems, answers);

  const a = problems.map(keyOf);
  const b = answers.map(keyOf);
  // 답지 항목 크기 순위(0~1)
  const areas = answers.map(areaOf);
  const sorted = [...areas].sort((x, y) => x - y);
  const rank = areas.map((v) => (m > 1 ? sorted.indexOf(v) / (m - 1) : 1));

  // L[i][j], B[i][j] = a[i..], b[j..] 에서 (짝 개수, 모양 점수) 최댓값
  const W = m + 1;
  const L = new Uint16Array((n + 1) * W);
  const B = new Uint32Array((n + 1) * W);
  const better = (l1, b1, l2, b2) => l1 > l2 || (l1 === l2 && b1 > b2);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * W;
    const below = (i + 1) * W;
    for (let j = m - 1; j >= 0; j--) {
      // i 건너뛰기
      let l = L[below + j];
      let s = B[below + j];
      // j 건너뛰기
      if (better(L[row + j + 1], B[row + j + 1], l, s)) {
        l = L[row + j + 1];
        s = B[row + j + 1];
      }
      // 짝짓기
      if (a[i] === b[j]) {
        const lm = L[below + j + 1] + 1;
        const sm = B[below + j + 1] + pairBonus(problems[i], answers[j], rank[j]);
        if (!better(l, s, lm, sm)) {
          l = lm;
          s = sm;
        }
      }
      L[row + j] = l;
      B[row + j] = s;
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const cur = i * W + j;
    if (a[i] === b[j]) {
      const lm = L[(i + 1) * W + j + 1] + 1;
      const sm = B[(i + 1) * W + j + 1] + pairBonus(problems[i], answers[j], rank[j]);
      if (lm === L[cur] && sm === B[cur]) {
        result.set(problems[i].id, answers[j].id);
        i++;
        j++;
        continue;
      }
    }
    const down = (i + 1) * W + j;
    if (L[down] === L[cur] && B[down] === B[cur]) i++;
    else j++;
  }
  return result;
}

/** 아주 큰 문서용: k번째로 나온 (말머리, 번호) ↔ 답지에서 k번째로 나온 (말머리, 번호) */
function matchByOccurrence(problems, answers) {
  const result = new Map();
  const pool = new Map();
  const k = (it) => `${it.prefix || ''}|${keyOf(it)}`;
  for (const ans of answers) {
    if (!pool.has(k(ans))) pool.set(k(ans), []);
    pool.get(k(ans)).push(ans.id);
  }
  const used = new Map();
  for (const p of problems) {
    const list = pool.get(k(p));
    if (!list) continue;
    const u = used.get(k(p)) || 0;
    if (u < list.length) {
      result.set(p.id, list[u]);
      used.set(k(p), u + 1);
    }
  }
  return result;
}
