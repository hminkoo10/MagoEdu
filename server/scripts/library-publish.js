'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ID, emptyIndex, validateIndex } = require('../src/library');
const { validPath } = require('../src/routes/sync');

function mkdir(dir) {
  if (fs.existsSync(dir)) return;
  mkdir(path.dirname(dir));
  // 위 폴더의 setgid(그룹 물려받기)는 지키고 나머지는 0750: 서버 계정이 그룹으로 읽는다.
  try { fs.mkdirSync(dir, { mode: 0o750 }); fs.chmodSync(dir, 0o750 | (fs.statSync(path.dirname(dir)).mode & 0o2000)); }
  catch (err) { if (err.code !== 'EEXIST') throw err; }
}

function atomic(file, bytes) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o640 });
    fs.chmodSync(tmp, 0o640);
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

function bookId(exam) {
  if (!exam || typeof exam !== 'object' || Array.isArray(exam)) throw new Error('invalid exam');
  const keys = ['exam', 'year', 'schoolYear', 'month', 'grade', 'subject', 'selection', 'form'];
  const identity = keys.map((key) => {
    const value = exam[key] ?? null;
    if (value !== null && !['string', 'number'].includes(typeof value)) throw new Error('invalid exam field');
    return value;
  });
  if (!exam.exam || !exam.year || typeof exam.subject !== 'string' || !ID.test(exam.subject)) throw new Error('incomplete exam');
  return 'exam-' + crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16);
}

function readBook(root, id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('invalid book id');
  const dir = path.join(root, 'books', id);
  if (fs.lstatSync(path.join(root, 'books')).isSymbolicLink() || fs.lstatSync(dir).isSymbolicLink()) throw new Error('symlink book');
  const meta = path.join(dir, 'book.json');
  if (!fs.lstatSync(meta).isFile() || fs.lstatSync(meta).isSymbolicLink()) throw new Error('invalid book.json');
  const book = JSON.parse(fs.readFileSync(meta, 'utf8'));
  const publicId = bookId(book.exam);
  book.id = publicId;
  book.createdBy = { id: 'mago-library', name: '마고 공용 책장' };
  const files = [];
  function walk(folder, prefix = '') {
    for (const item of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + item.name;
      const file = path.join(folder, item.name);
      if (item.isSymbolicLink()) throw new Error('symlink file');
      if (item.isDirectory()) walk(file, relative + '/');
      else if (item.isFile()) {
        const p = validPath(`books/${publicId}/${relative}`);
        const bytes = relative === 'book.json' ? Buffer.from(JSON.stringify(book, null, 2) + '\n') : fs.readFileSync(file);
        files.push({ path: p, bytes, mtime: Math.trunc(fs.statSync(file).mtimeMs) });
      } else throw new Error('unsupported file');
    }
  }
  walk(dir);
  return { id: publicId, subject: book.exam.subject, files };
}

function parseArgs(args) {
  const options = { roots: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--library', '--app', '--remove'].includes(arg)) {
      const key = arg.slice(2);
      if (options[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('invalid option');
      options[key] = args[++i];
    } else if (arg.startsWith('--')) throw new Error('unknown option');
    else options.roots.push(arg);
  }
  if (!options.library || !ID.test(options.app || '') || options.app === 'blobs'
    || (options.remove ? !ID.test(options.remove) || options.roots.length : !options.roots.length)) throw new Error('invalid arguments');
  return options;
}

function main(args = process.argv.slice(2)) {
  const result = { books: 0, changed: 0, deleted: 0, seq: 0 };
  let lock;
  let locked = false;
  let exit = 0;
  try {
    const options = parseArgs(args);
    const root = path.resolve(options.library);
    const appDir = path.join(root, options.app);
    mkdir(appDir);
    mkdir(path.join(root, 'blobs'));
    lock = path.join(appDir, '.lock');
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o640); }
    catch (err) { if (err.code === 'EEXIST') { exit = 3; return exit; } throw err; }
    locked = true;
    try { fs.fchmodSync(fd, 0o640); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }) + '\n'); }
    finally { fs.closeSync(fd); }
    const indexFile = path.join(appDir, 'index.json');
    const index = fs.existsSync(indexFile) ? validateIndex(JSON.parse(fs.readFileSync(indexFile, 'utf8')), options.app) : emptyIndex(options.app);
    result.seq = index.seq;
    const entries = new Map(index.entries.map((e) => [e.path, e]));
    const remove = (e) => {
      if (e.deleted) return;
      entries.set(e.path, { ...e, rev: e.rev + 1, seq: ++index.seq, deleted: true, sha256: null, size: 0, mtime: Date.now() });
      result.deleted++;
    };
    if (options.remove) {
      for (const e of entries.values()) if (e.book === options.remove) remove(e);
    } else {
      for (const folder of options.roots) {
        let exams;
        try {
          // 처리기(오답노트 --exam-out)의 summary.json: { exams: [{ name, bookId, done, error, ... }] }
          const summary = JSON.parse(fs.readFileSync(path.join(folder, 'summary.json'), 'utf8'));
          if (!Array.isArray(summary.exams)) throw new Error('exams 목록이 없어요');
          exams = summary.exams;
        } catch (err) { exit = 1; console.error(`결과 요약을 읽지 못해 건너뜁니다: ${folder} (${err.message})`); continue; }
        for (const item of exams) {
          if (!item || item.error || item.done !== true) continue;
          try {
            const book = readBook(folder, item.bookId);
            // 모든 입력과 blob을 준비한 뒤에만 이 책의 색인을 바꾼다.
            for (const f of book.files) {
              f.sha256 = crypto.createHash('sha256').update(f.bytes).digest('hex');
              const blob = path.join(root, 'blobs', f.sha256);
              if (!fs.existsSync(blob)) atomic(blob, f.bytes);
            }
            const present = new Set();
            for (const f of book.files) {
              present.add(f.path);
              const previous = entries.get(f.path);
              if (previous && !previous.deleted && previous.sha256 === f.sha256) continue;
              entries.set(f.path, { path: f.path, rev: (previous?.rev || 0) + 1, seq: ++index.seq,
                sha256: f.sha256, size: f.bytes.length, mtime: f.mtime, deleted: false, subject: book.subject, book: book.id });
              result.changed++;
            }
            for (const e of entries.values()) if (e.book === book.id && !present.has(e.path)) remove(e);
            result.books++;
          } catch (err) { exit = 1; console.error(`완료된 책을 읽거나 올리지 못해 건너뜁니다: ${item.name || item.bookId} (${err.message})`); }
        }
      }
    }
    if (index.seq !== result.seq) {
      index.entries = [...entries.values()].sort((a, b) => a.seq - b.seq);
      index.updatedAt = Date.now();
      atomic(indexFile, JSON.stringify(index, null, 2) + '\n');
    }
    result.seq = index.seq;
  } catch (err) { exit = 2; console.error(`공용 책장 올리기를 시작하거나 색인을 저장하지 못했습니다: ${err.message}`); }
  finally {
    if (locked) fs.rmSync(lock, { force: true });
    console.log(JSON.stringify(result));
  }
  return exit;
}

if (require.main === module) process.exitCode = main();
module.exports = { main, bookId };
