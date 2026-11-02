'use strict';

const crypto = require('node:crypto');

const DAY = 24 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.status = status;
    this.code = code || 'error';
    this.extra = extra || null;
  }
}

const bad = (message, code = 'bad_request') => new HttpError(400, message, code);
const forbidden = (message = '권한이 없어요.', code = 'forbidden') => new HttpError(403, message, code);
const notFound = (message = '찾을 수 없어요.', code = 'not_found') => new HttpError(404, message, code);

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// 헷갈리는 글자(0/O, 1/I/L)는 뺀다
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomFrom(alphabet, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

function randomCode() {
  return `MAGO-${randomFrom(CODE_ALPHABET, 4)}-${randomFrom(CODE_ALPHABET, 4)}`;
}

function randomPassword() {
  // 받아 적기 쉬운 형태: 소문자 4 + 숫자 4 + 소문자 2 (예: kmtr4821pa)
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  return randomFrom(lower, 4) + randomFrom('23456789', 4) + randomFrom(lower, 2);
}

function parseVersion(v) {
  const nums = String(v || '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .slice(0, 4)
    .map(Number);
  while (nums.length < 3) nums.push(0);
  return nums;
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function intOr(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(value, max = 200) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

function normalizeUsername(value) {
  const u = String(value || '').trim().toLowerCase();
  if (!USERNAME_RE.test(u)) {
    throw bad('아이디는 영어 소문자·숫자·._- 로 3~32자여야 해요. (첫 글자는 영어나 숫자)', 'invalid_username');
  }
  return u;
}

function validatePassword(password, username) {
  const p = String(password || '');
  if (p.length < 6) throw bad('비밀번호는 6자 이상이어야 해요.', 'weak_password');
  if (p.length > 128) throw bad('비밀번호가 너무 길어요.', 'weak_password');
  if (username && p.toLowerCase() === String(username).toLowerCase()) {
    throw bad('비밀번호를 아이디와 다르게 정해 주세요.', 'weak_password');
  }
  return p;
}

function validateName(value) {
  const n = str(value, 40);
  if (!n) throw bad('이름을 입력해 주세요.', 'invalid_name');
  return n;
}

function jsonParse(text, fallback) {
  try {
    return text == null ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
}

module.exports = {
  DAY,
  HttpError,
  bad,
  forbidden,
  notFound,
  randomToken,
  sha256Hex,
  randomCode,
  randomPassword,
  parseVersion,
  compareVersions,
  intOr,
  str,
  normalizeUsername,
  validatePassword,
  validateName,
  jsonParse,
};
