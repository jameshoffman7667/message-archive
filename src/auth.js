import crypto from 'node:crypto';
import { getSetting, setSetting } from './db.js';

// scrypt from Node's standard library: no native add-on to build on Alpine.
const N = 1 << 15, R = 8, P = 1, KEYLEN = 32, MAXMEM = 64 * 1024 * 1024;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  if (!stored || typeof pw !== 'string') return false;
  const [kind, n, r, p, salt, key] = stored.split('$');
  if (kind !== 'scrypt') return false;
  const want = Buffer.from(key, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
  return crypto.timingSafeEqual(want, got);
}

export const PASSWORD_MIN = 10;
export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return `password must be at least ${PASSWORD_MIN} characters`;
  if (pw.length > 256) return 'password is too long';
  return null;
}

const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function createSession(db) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, created_at, last_seen) VALUES (?, ?, ?)').run(tokenHash(token), now, now);
  return token;
}

export function checkSession(db, token, idleMinutes) {
  if (!token) return false;
  const h = tokenHash(token);
  const row = db.prepare('SELECT last_seen FROM sessions WHERE token_hash = ?').get(h);
  if (!row) return false;
  const now = Date.now();
  if (now - row.last_seen > idleMinutes * 60_000) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h); return false; }
  if (now - row.last_seen > 60_000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, h);
  return true;
}

export function dropSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}
export function dropAllSessions(db) { db.prepare('DELETE FROM sessions').run(); }

export const isSetUp = (db) => !!getSetting(db, 'password_hash');
export function setPassword(db, pw) { setSetting(db, 'password_hash', hashPassword(pw)); }
export function checkPassword(db, pw) { return verifyPassword(pw, getSetting(db, 'password_hash')); }

// Fixed-window limiter per key (IP), in memory.
export function makeLimiter({ max, windowMs }) {
  const hits = new Map();
  return {
    blocked(key) {
      const h = hits.get(key);
      if (!h) return false;
      if (Date.now() - h.start > windowMs) { hits.delete(key); return false; }
      return h.n >= max;
    },
    fail(key) {
      const h = hits.get(key);
      if (!h || Date.now() - h.start > windowMs) hits.set(key, { start: Date.now(), n: 1 });
      else h.n++;
    },
    reset(key) { hits.delete(key); },
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
