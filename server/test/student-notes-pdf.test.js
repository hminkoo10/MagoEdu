'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const fontkit = require('../src/vendor/fontkit');
const { PDFDocument, PDFName, PDFArray, PDFRawStream, decodePDFRawStream, rgb, degrees } = require('../src/vendor/pdf-lib');
const { buildNotesPdf } = require('../src/notes-pdf');
const { register, createStudentNotes, requireStudent, academyFileReader } = require('../src/routes/student-notes');
const { BlobStore } = require('../src/storage');
const { Router } = require('../src/http');

const BID = 'book-0001';
const SID = 'student-0001';
const user = { role: 'student', student_id: SID, academy_id: 1 };
const rect = { page: 0, x: 0.1, y: 0.2, w: 0.4, h: 0.25 };
const item = (id, number, r = rect) => ({ id, number: String(number), num: number, page: r.page, col: 0, rects: [{ ...r }] });
const note = (extra = {}) => ({
  id: 'note-0001', kind: 'note', version: 2, title: '수학 오답노트', student: '김학생', studentId: SID,
  bookIds: [BID], selected: { [BID]: ['p1', 'p2'] }, createdBy: { id: 'teacher-1', name: '선생님' }, updatedAt: 100,
  exportOptions: { space: 'page' }, ...extra,
});
const book = (kind = 'pdf') => ({
  id: BID, name: '수학 교재',
  docs: {
    problem: { files: [{ name: `problem-1.${kind === 'pdf' ? 'pdf' : 'png'}`, kind }], pageOffset: 10, items: [item('p2', 2, { ...rect, y: 0.6 }), item('p1', 1)] },
    answer: { files: [{ name: 'answer-1.pdf', kind: 'pdf' }], items: [item('a1', 1), item('a2', 2, { ...rect, y: 0.6 })] },
  },
});

async function sourcePdf({ crop = false, rotate = 0, pages = 1, label = 'PROBLEM' } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([600, 800]);
    p.drawRectangle({ x: 0, y: 0, width: 600, height: 800, color: rgb(1, 0.95, 0.9) });
    p.drawText(`${label} ${i + 1}`, { x: 80, y: 590, size: 20 });
    p.drawRectangle({ x: 60, y: 360, width: 240, height: 280, borderWidth: 2, borderColor: rgb(1, 0, 0) });
    if (crop) p.setCropBox(20, 40, 400, 600);
    if (rotate) p.setRotation(degrees(rotate));
  }
  return doc.save();
}

function png() {
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const v of buf) {
      c ^= v;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const content = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    content.copy(out, 4);
    out.writeUInt32BE(crc(content), out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(40, 0); header.writeUInt32BE(80, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(80 * 121);
  for (let y = 0; y < 80; y++) for (let x = 0; x < 40; x++) {
    const at = y * 121 + 1 + x * 3;
    pixels[at] = x < 20 ? 220 : 20;
    pixels[at + 1] = x < 20 ? 30 : 180;
    pixels[at + 2] = 40;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function fixture(kind = 'pdf', options = {}) {
  const b = book(kind);
  const root = options.private ? 'members/teacher-1/books' : 'books';
  const files = new Map([
    [`${root}/${BID}/book.json`, Buffer.from(JSON.stringify(b))],
    [`${root}/${BID}/${b.docs.problem.files[0].name}`, kind === 'pdf' ? await sourcePdf(options) : png()],
    [`${root}/${BID}/answer-1.pdf`, await sourcePdf({ label: 'ANSWER' })],
  ]);
  const reads = [];
  const read = async (p) => {
    reads.push(p);
    if (!files.has(p)) throw Object.assign(new Error('파일이 없어요.'), { status: 404 });
    return files.get(p);
  };
  const saveBook = () => files.set(`${root}/${BID}/book.json`, Buffer.from(JSON.stringify(b)));
  return { b, files, read, reads, saveBook };
}

function content(doc, page) {
  const raw = page.node.lookup(PDFName.of('Contents'));
  const streams = raw instanceof PDFArray ? raw.asArray().map((r) => doc.context.lookup(r)) : [raw];
  return streams.map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString()).join('\n');
}

function forms(doc) {
  return doc.context.enumerateIndirectObjects().map(([, o]) => o).filter((o) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Form');
}

function textRuns(doc, page) {
  const fonts = page.node.Resources().lookup(PDFName.of('Font'));
  const maps = new Map();
  for (const [key, ref] of fonts.entries()) {
    const font = doc.context.lookup(ref);
    const cmap = Buffer.from(decodePDFRawStream(font.lookup(PDFName.of('ToUnicode'))).decode()).toString();
    const unicode = new Map();
    for (const [, block] of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const [, code, value] of block.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) {
        unicode.set(code.toLowerCase(), Buffer.from(value, 'hex').swap16().toString('utf16le'));
      }
    }
    const descendant = font.lookup(PDFName.of('DescendantFonts')).lookup(0);
    const widths = descendant.lookup(PDFName.of('W')).asArray();
    const byCode = new Map();
    for (let i = 0; i < widths.length; i += 2) {
      widths[i + 1].asArray().forEach((w, offset) => byCode.set(widths[i].asNumber() + offset, w.asNumber()));
    }
    maps.set(key.toString().slice(1), { font: font.lookup(PDFName.of('BaseFont')).toString(), unicode, byCode });
  }
  let current;
  let size;
  const runs = [];
  for (const [, key, fontSize, hex] of content(doc, page).matchAll(/\/([^\s/]+)\s+([\d.]+)\s+Tf|<([0-9a-f]+)>\s*Tj/gi)) {
    if (key) { current = maps.get(key); size = Number(fontSize); continue; }
    const codes = hex.toLowerCase().match(/.{4}/g);
    runs.push({
      text: codes.map((code) => current.unicode.get(code) ?? '\uFFFD').join(''),
      font: current.font, size,
      width: codes.reduce((sum, code) => sum + current.byCode.get(parseInt(code, 16)), 0) * size / 1000,
    });
  }
  return runs;
}

const pageText = (doc, page) => textRuns(doc, page).map((run) => run.text).join('\n');
const placeholder = '이 문항은 원본을 열 수 없어 넣지 못했어요';

test('학생 PDF: 한글 서브셋을 내장하고 모든 쪽에서 재사용하며 ToUnicode로 글자를 읽어요', async () => {
  const f = await fixture();
  const n = note({ academy: '마고학원', teacher: '김선생', student: '홍길동', answersForStudent: true });
  const bytes = await buildNotesPdf(n, f.read);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 3);
  assert.ok(bytes.length < 100 * 1024, `서브셋 PDF 크기: ${bytes.length}바이트`);
  const refs = new Set(doc.getPages().flatMap((p) => p.node.Resources().lookup(PDFName.of('Font')).values().map((ref) => ref.toString())));
  assert.equal(refs.size, 2, 'Regular·Bold는 쪽마다 다시 넣지 않음');
  for (const ref of refs) {
    const font = doc.context.enumerateIndirectObjects().find(([key]) => key.toString() === ref)[1];
    const descendant = font.lookup(PDFName.of('DescendantFonts')).lookup(0);
    const descriptor = descendant.lookup(PDFName.of('FontDescriptor'));
    const embedded = descriptor.lookup(PDFName.of('FontFile2'));
    assert.ok(embedded instanceof PDFRawStream, 'TrueType 글꼴 프로그램 내장');
    const data = Buffer.from(decodePDFRawStream(embedded).decode());
    assert.ok([0x00010000, 0x74727565].includes(data.readUInt32BE(0)), '유효한 TrueType 헤더');
    assert.ok(data.length > 100 && data.length < 100 * 1024, '전체 글꼴 대신 서브셋 내장');
    const weight = font.lookup(PDFName.of('BaseFont')).toString().includes('Bold') ? 'Bold' : 'Regular';
    const original = fontkit.create(fs.readFileSync(path.join(__dirname, `../src/vendor/fonts/Pretendard-${weight}.ttf`)));
    const subset = fontkit.create(data);
    const cmap = Buffer.from(decodePDFRawStream(font.lookup(PDFName.of('ToUnicode'))).decode()).toString();
    for (const [, code, value] of cmap.matchAll(/<([0-9a-f]{4})>\s*<([0-9a-f]{4})>/gi)) {
      const ch = String.fromCharCode(parseInt(value, 16));
      if (!/^[가-힣]$/.test(ch)) continue;
      assert.deepEqual(subset.getGlyph(parseInt(code, 16)).path.commands, original.glyphForCodePoint(ch.charCodeAt(0)).path.commands, `${weight} ${ch}: 서브셋에도 실제 한글 윤곽이 남음`);
    }
  }
  const first = textRuns(doc, doc.getPage(0));
  for (const value of [n.title, '학원', n.academy, '선생님', n.teacher, '학생', n.student]) {
    const run = first.find((r) => r.text === value);
    assert.ok(run, `ToUnicode 한글 추출: ${value}`);
    assert.match(run.font, value === n.title ? /Pretendard-Bold/ : /Pretendard-Regular/);
  }
  const heading = textRuns(doc, doc.getPage(2)).find((r) => r.text === '정답 및 해설');
  assert.ok(heading);
  assert.match(heading.font, /Pretendard-Bold/);
});

test('학생 PDF: 한글·영문 제목과 학생 이름을 실제 글꼴 폭에 맞춰 줄여요', async () => {
  const f = await fixture();
  const title = 'WWW 수학 오답노트 '.repeat(12);
  const student = 'WWW 김학생 '.repeat(8);
  const doc = await PDFDocument.load(await buildNotesPdf(note({ title, student, selected: {} }), f.read));
  const runs = textRuns(doc, doc.getPage(0));
  for (const [value, size, maxWidth] of [[title, 22, 595.28 - 38 * 2 - 16], [student, 8, (595.28 - 38 * 2) / 4 - 48]]) {
    const run = runs.find((r) => r.size === size && r.text.endsWith('…') && value.startsWith(r.text.slice(0, -1)));
    assert.ok(run, '긴 글은 줄임표로 표시');
    assert.ok(run.width <= maxWidth, `칸 너비 ${maxWidth}, 글자 너비 ${run.width}`);
    assert.match(run.font, size === 22 ? /Pretendard-Bold/ : /Pretendard-Regular/);
  }
});

test('학생 PDF: PDF 원본의 CropBox 기준으로 문항을 벡터로 자르고 쪽마다 배치해요', async () => {
  const f = await fixture('pdf', { crop: true });
  const n = note();
  const before = structuredClone(n);
  const doc = await PDFDocument.load(await buildNotesPdf(n, f.read));
  assert.deepEqual(n, before, '노트는 바꾸지 않음');
  assert.equal(doc.getPageCount(), 2, '마지막에 빈 쪽을 붙이지 않음');
  assert.equal(doc.getTitle(), n.title);
  assert.deepEqual(doc.getPage(0).getSize(), { width: 595.28, height: 841.89 });
  const boxes = forms(doc).map((s) => s.dict.lookup(PDFName.of('BBox')).asArray().map((v) => v.asNumber()));
  assert.deepEqual(boxes, [[60, 370, 220, 520], [60, 130, 220, 280]]);
  assert.ok(!f.reads.some((p) => p.endsWith('answer-1.pdf')), '답지 원본은 아예 읽지 않음');
});

test('학생 PDF: 답지는 true일 때만, 뒤에 모으기·번갈아 싣기와 직접 고친 짝을 반영해요', async () => {
  for (const value of [undefined, false, 'true', 1]) {
    const f = await fixture();
    const doc = await PDFDocument.load(await buildNotesPdf(note({ answersForStudent: value }), f.read));
    assert.equal(doc.getPageCount(), 2);
    assert.equal(forms(doc).length, 2);
    assert.ok(!f.reads.some((p) => p.endsWith('answer-1.pdf')));
  }
  const f = await fixture();
  f.b.answerOverrides = { p1: 'a2', p2: '' };
  f.saveBook();
  const doc = await PDFDocument.load(await buildNotesPdf(note({ answersForStudent: true }), f.read));
  assert.equal(doc.getPageCount(), 3);
  assert.equal(forms(doc).length, 3, '문제 2개 + 허용한 해설 1개');
  assert.ok(pageText(doc, doc.getPage(2)).includes('정답 및 해설'));
  assert.ok(pageText(doc, doc.getPage(2)).includes('(답지에서 짝이 되는 해설을 찾지 못했어요)'));
  const answerBox = forms(doc)[2].dict.lookup(PDFName.of('BBox')).asArray().map((v) => v.asNumber());
  assert.deepEqual(answerBox.map(Math.round), [60, 120, 300, 320]);
  const inline = await PDFDocument.load(await buildNotesPdf(note({ answersForStudent: true, exportOptions: { space: 'page', bothOrder: 'interleave' } }), f.read));
  assert.equal(inline.getPageCount(), 2);
});

test('학생 PDF: 그림 원본은 영역 밖을 클리핑하고 선생님 개인 교재도 읽어요', async () => {
  const f = await fixture('image', { private: true });
  const doc = await PDFDocument.load(await buildNotesPdf(note({ selected: { [BID]: ['p1'] } }), f.read));
  assert.equal(doc.getPageCount(), 1);
  const stream = content(doc, doc.getPage(0));
  assert.match(stream, /238\.112[^\n]*297\.64[^\n]*re\nW\nn/);
  assert.ok(f.reads.includes(`members/teacher-1/books/${BID}/problem-1.png`));
  assert.ok(!pageText(doc, doc.getPage(0)).includes(placeholder));
});

test('학생 PDF: 공통 지문·여러 PDF 파일의 쪽·회전을 반영해요', async () => {
  const f = await fixture('pdf', { pages: 2 });
  f.files.set(`books/${BID}/problem-2.pdf`, await sourcePdf({ rotate: 90 }));
  f.b.docs.problem.files.push({ name: 'problem-2.pdf', kind: 'pdf' });
  f.b.docs.problem.items = [item('p1', 1, { ...rect, page: 2 })];
  f.b.docs.problem.items[0].stem = [{ ...rect, page: 1, h: 0.1 }];
  f.saveBook();
  const doc = await PDFDocument.load(await buildNotesPdf(note({ selected: { [BID]: ['p1'] } }), f.read));
  assert.equal(doc.getPageCount(), 1);
  const boxes = forms(doc).map((s) => s.dict.lookup(PDFName.of('BBox')).asArray().map((v) => Math.round(v.asNumber())));
  assert.deepEqual(boxes, [[60, 560, 300, 640], [120, 80, 270, 400]]);
  assert.match(content(doc, doc.getPage(0)), /-1 1 [0-9.]+ 0 0 cm/);
});

test('학생 PDF: JPEG도 넣고 지원하지 않는 그림은 자리 표시해요', async () => {
  const f = await fixture('image');
  const jpg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCABQACgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAUG/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AnwG0QgAAAAAAAAAAAAAAAAAAAAAAAAAAAH//2Q==';
  f.b.docs.problem.files[0].name = 'problem-1.jpg';
  f.saveBook();
  f.files.set(`books/${BID}/problem-1.jpg`, Buffer.from(jpg, 'base64'));
  let doc = await PDFDocument.load(await buildNotesPdf(note(), f.read));
  assert.equal(doc.getPageCount(), 2);
  assert.ok(!pageText(doc, doc.getPage(0)).includes(placeholder));
  const images = doc.context.enumerateIndirectObjects().map(([, o]) => o).filter((o) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Filter'))?.toString() === '/DCTDecode');
  assert.equal(images.length, 1, '같은 그림은 한 번만 넣음');
  f.files.set(`books/${BID}/problem-1.jpg`, Buffer.from('지원하지 않는 그림'));
  doc = await PDFDocument.load(await buildNotesPdf(note(), f.read));
  assert.ok(pageText(doc, doc.getPage(0)).includes(placeholder));
});

test('학생 PDF: 한 PDF 파일을 못 열어도 뒤의 정상 파일 쪽 번호는 유지해요', async () => {
  const f = await fixture();
  f.b.docs.problem.pageCount = 3;
  f.b.docs.problem.files.push({ name: 'problem-2.pdf', kind: 'pdf' });
  f.b.docs.problem.items = [item('p1', 1), item('p2', 2, { ...rect, page: 2 })];
  f.saveBook();
  f.files.delete(`books/${BID}/problem-1.pdf`);
  f.files.set(`books/${BID}/problem-2.pdf`, await sourcePdf());
  const doc = await PDFDocument.load(await buildNotesPdf(note(), f.read));
  assert.equal(doc.getPageCount(), 2);
  assert.ok(pageText(doc, doc.getPage(0)).includes(placeholder));
  assert.ok(!pageText(doc, doc.getPage(1)).includes(placeholder));
  assert.equal(forms(doc).length, 1);
});

test('학생 PDF: 열 수 없는 원본·없는 책·잘못된 영역은 문항 자리만 표시해요', async () => {
  for (const failure of ['missing', 'broken', 'encrypted', 'stream', 'book', 'rect', 'path']) {
    const f = await fixture();
    if (failure === 'missing') f.files.delete(`books/${BID}/problem-1.pdf`);
    if (failure === 'broken') f.files.set(`books/${BID}/problem-1.pdf`, Buffer.from('잘못된 PDF'));
    if (failure === 'encrypted') {
      const pdf = await PDFDocument.load(await sourcePdf());
      pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: 'Standard', V: 1, R: 2 }));
      f.files.set(`books/${BID}/problem-1.pdf`, await pdf.save());
    }
    if (failure === 'stream') {
      const pdf = await PDFDocument.load(await sourcePdf());
      const broken = pdf.context.register(pdf.context.stream('broken', { Filter: 'UnknownFilter' }));
      pdf.getPage(0).node.set(PDFName.of('Contents'), pdf.context.obj([broken]));
      f.files.set(`books/${BID}/problem-1.pdf`, await pdf.save());
    }
    if (failure === 'book') f.files.delete(`books/${BID}/book.json`);
    if (failure === 'rect') { f.b.docs.problem.items[1].rects[0].w = 2; f.saveBook(); }
    if (failure === 'path') { f.b.docs.problem.files[0].name = '../../students/other/notes/n.json'; f.saveBook(); }
    const doc = await PDFDocument.load(await buildNotesPdf(note(), f.read));
    assert.equal(doc.getPageCount(), 2, failure);
    assert.ok(pageText(doc, doc.getPage(0)).includes(placeholder), failure);
    if (failure === 'rect') assert.ok(!pageText(doc, doc.getPage(1)).includes(placeholder), '다음 정상 문항은 그대로');
    assert.ok(!f.reads.some((p) => p.includes('..')));
  }
});

test('학생 PDF: 두 단·빈 노트·읽는 순서·해설의 반복 번호를 처리해요', async () => {
  const f = await fixture();
  f.b.docs.problem.items = [item('p2', 1, { ...rect, page: 1 }), item('p1', 1)];
  f.b.docs.answer.items = [item('a1', 1), item('a2', 1, { ...rect, y: 0.6 })];
  f.files.set(`books/${BID}/problem-1.pdf`, await sourcePdf({ pages: 2 }));
  f.saveBook();
  const doc = await PDFDocument.load(await buildNotesPdf(note({ answersForStudent: true, exportOptions: { columns: 2, space: 'none' } }), f.read));
  assert.equal(doc.getPageCount(), 2);
  assert.equal(forms(doc).length, 4, '반복 번호도 각 해설과 짝지음');
  const empty = await PDFDocument.load(await buildNotesPdf(note({ selected: {} }), f.read));
  assert.equal(empty.getPageCount(), 1);
});

function store(t) {
  const tempDir = require('node:os').tmpdir();
  const dir = fs.mkdtempSync(path.join(tempDir, '.student-notes-'));
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE shared_files (academy_id INTEGER, app_id TEXT, path TEXT, sha256 TEXT, updated_at INTEGER, deleted INTEGER DEFAULT 0)');
  const db = { get: (q, ...args) => sql.prepare(q).get(...args), all: (q, ...args) => sql.prepare(q).all(...args) };
  const blobs = new BlobStore(dir, db, { info() {} });
  t.after(() => {
    blobs.close(); sql.close();
    assert.ok(path.resolve(dir).startsWith(path.resolve(tempDir) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const put = (p, value, { academy = 1, app = 'ohdapnote', deleted = 0, updated = 20 } = {}) => {
    const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array ? value : Buffer.from(JSON.stringify(value));
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.mkdirSync(path.dirname(blobs.pathFor(sha)), { recursive: true });
    fs.writeFileSync(blobs.pathFor(sha), bytes);
    sql.prepare('INSERT INTO shared_files VALUES (?, ?, ?, ?, ?, ?)').run(academy, app, p, sha, updated, deleted);
  };
  return { db, blobs, put };
}

test('학생 목록: 내 학원·내 폴더만, 지운 노트·중첩 경로·깨진 JSON 제외해요', async (t) => {
  const s = store(t);
  s.put(`students/${SID}/notes/note-0001.json`, note({ answersForStudent: true }));
  s.put(`students/${SID}/notes/note-0002.json`, note({ id: 'note-0002', studentId: '', updatedAt: 200, selected: { [BID]: ['p1'], extra: null } }));
  s.put(`students/${SID}/notes/deleted.json`, note({ id: 'deleted' }), { deleted: 1 });
  s.put(`students/${SID}/notes/hidden.json`, note({ id: 'hidden', deletedAt: 12 }));
  s.put(`students/${SID}/notes/broken.json`, Buffer.from('{'));
  s.put(`students/${SID}/notes/deep/note-0003.json`, note({ id: 'note-0003' }));
  s.put('students/student-0002/notes/other.json', note({ id: 'other', studentId: SID }));
  s.put(`students/${SID}/notes/other-aca.json`, note({ id: 'other-aca' }), { academy: 2 });
  s.put(`students/${SID}/notes/other-app.json`, note({ id: 'other-app' }), { app: 'other' });
  s.put(`members/teacher-1/notes/private.json`, note({ id: 'private' }));
  const notes = createStudentNotes(s, user);
  assert.deepEqual(await notes.list(), [
    { id: 'note-0002', title: '수학 오답노트', updatedAt: 200, problemCount: 1, answersAllowed: false },
    { id: 'note-0001', title: '수학 오답노트', updatedAt: 100, problemCount: 2, answersAllowed: true },
  ]);
  assert.equal((await notes.get('note-0002')).studentId, '', '예전 노트는 폴더가 학생을 정함');
  for (const id of ['other', 'other-aca', 'other-app', 'private', 'deleted', '../student-0002/notes/other', '%2e%2e', 'note-0001.json']) {
    await assert.rejects(notes.get(id), { status: 404 });
  }
  const other = createStudentNotes(s, { ...user, student_id: 'student-0002' });
  await assert.rejects(other.get('note-0001'), { status: 404 });
  assert.deepEqual(await createStudentNotes(s, { ...user, academy_id: 3 }).list(), []);
  await assert.rejects(academyFileReader(s, 1)('../secret'), { status: 400 });
});

test('학생 경로: 계정 확인·목록 계약·PDF inline 응답과 한글 파일 이름을 확인해요', async (t) => {
  for (const account of [null, {}, { role: 'teacher', student_id: SID }, { role: 'student' }]) {
    assert.throws(() => requireStudent(account), { status: 403, code: 'student_only' });
  }
  const s = store(t);
  s.put(`students/${SID}/notes/note-0001.json`, note({ title: '수학 "복습"\r\n시험', selected: {} }));
  let account = user;
  const router = new Router();
  register(router, { ...s, svc: { authenticate: () => ({ user: account }) } });
  const invoke = async (url, method = 'GET') => {
    const route = router.match(method, url);
    const response = {};
    const result = await route.handler({ params: route.params, req: { method }, res: {
      writeHead(status, headers) { Object.assign(response, { status, headers }); },
      end(bytes) { response.bytes = bytes; },
    } });
    return { ...response, result };
  };
  assert.equal((await invoke('/api/me/notes')).result.length, 1);
  const pdf = await invoke('/api/me/notes/note-0001/pdf');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal(pdf.headers['cache-control'], 'no-store');
  assert.match(pdf.headers['content-disposition'], /^inline; filename="note.pdf"; filename\*=UTF-8''/);
  assert.ok(!/[\r\n]/.test(pdf.headers['content-disposition']));
  assert.match(decodeURIComponent(pdf.headers['content-disposition']), /수학 _복습___시험.pdf$/);
  assert.equal(pdf.headers['content-length'], pdf.bytes.length);
  assert.equal((await PDFDocument.load(pdf.bytes)).getPageCount(), 1);
  assert.equal((await invoke('/api/me/notes/note-0001/pdf', 'HEAD')).bytes, undefined);
  await assert.rejects(invoke('/api/me/notes/other/pdf'), { status: 404 });
  account = { role: 'teacher' };
  await assert.rejects(invoke('/api/me/notes'), { status: 403, code: 'student_only' });
  await assert.rejects(invoke('/api/me/notes/note-0001/pdf'), { status: 403, code: 'student_only' });
});

test('학생 PDF 저장소: 옮긴 개인 교재를 찾되 다른 학원 원본·모호한 복사본은 읽지 않아요', async (t) => {
  const s = store(t);
  const b = book();
  const src = await sourcePdf();
  const n = note({ selected: { [BID]: ['p1'] } });
  s.put(`members/new-teacher/books/${BID}/book.json`, b);
  s.put(`members/new-teacher/books/${BID}/problem-1.pdf`, src);
  s.put(`books/${BID}/book.json`, b, { academy: 2 });
  s.put(`books/${BID}/problem-1.pdf`, src, { academy: 2 });
  const read = academyFileReader(s, 1);
  let doc = await PDFDocument.load(await buildNotesPdf(n, read));
  assert.equal(forms(doc).length, 1, '노트 작성자가 아닌 새 주인의 폴더도 찾음');
  s.put(`members/another-teacher/books/${BID}/book.json`, b);
  doc = await PDFDocument.load(await buildNotesPdf(n, read));
  assert.equal(forms(doc).length, 0, '같은 ID가 겹치면 임의로 고르지 않음');
  assert.ok(pageText(doc, doc.getPage(0)).includes(placeholder));
  const other = await PDFDocument.load(await buildNotesPdf(n, academyFileReader(s, 3)));
  assert.equal(forms(other).length, 0, '다른 학원에만 있는 원본은 읽지 않음');
});
