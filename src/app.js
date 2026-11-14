import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PUBLIC_DIR } from './config.js';
import { getSetting, setSetting } from './db.js';
import { mediaPath } from './media.js';
import { formatNumber } from './threads.js';
import { createDav, DAV_USER } from './dav.js';
import { createJobs } from './jobs.js';
import {
  isSetUp, setPassword, checkPassword, passwordProblem, createSession, checkSession, dropSession, dropAllSessions,
  makeLimiter, parseCookies, hashPassword,
} from './auth.js';

const COOKIE = 'ma_session';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self'; connect-src 'self'; "
  + "font-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const SPA_ROUTES = /^\/(c\/\d+|search|imports|stats|settings)?\/?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_INLINE = /^(image\/(jpeg|png|gif|webp|heic|heif|bmp)|video\/[\w.+-]+|audio\/[\w.+-]+)$/i;

export function createApp({ db, cfg, log }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  const jobs = createJobs({ db, cfg, log });
  app.locals.jobs = jobs;

  // Health first: no login, no cookie, local check only.
  app.get('/healthz', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.status(200).json({ status: 'ok', version: cfg.version });
    } catch {
      res.status(503).json({ status: 'error', version: cfg.version });
    }
  });

  // WebDAV upload endpoint, before any body parser.
  const dav = createDav({ db, cfg, log, onUploaded: (f) => jobs.uploaded(f) });
  app.use('/dav', (req, res) => dav(req, res));

  app.use((req, res, next) => {
    res.set('Content-Security-Policy', CSP);
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    next();
  });

  // --- static app shell ---
  app.get('/manifest.webmanifest', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('application/manifest+json').sendFile(path.join(PUBLIC_DIR, 'manifest.webmanifest'));
  });
  app.get('/sw.js', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.set('Service-Worker-Allowed', '/');
    res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'sw.js'));
  });
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h', setHeaders: (res, p) => { if (/\.(html)$/.test(p)) res.set('Cache-Control', 'no-cache'); } }));
  app.get(SPA_ROUTES, (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // --- API ---
  const api = express.Router();
  api.use(express.json({ limit: '64kb' }));
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.get('x-requested-with') !== 'fetch') return res.status(403).json({ error: 'missing request header' });
      const origin = req.get('origin');
      if (origin) {
        let host;
        try { host = new URL(origin).host; } catch { host = null; }
        if (host !== req.get('host')) return res.status(403).json({ error: 'cross-origin request refused' });
      }
    }
    next();
  });

  const loginLimiter = makeLimiter({ max: 8, windowMs: 15 * 60_000 });
  const setCookie = (res, token, maxAgeMs) => {
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
    if (cfg.cookieSecure) parts.push('Secure');
    parts.push(maxAgeMs ? `Max-Age=${Math.floor(maxAgeMs / 1000)}` : 'Max-Age=0');
    res.set('Set-Cookie', parts.join('; '));
  };
  const tokenOf = (req) => parseCookies(req.headers.cookie)[COOKIE];
  const authed = (req) => checkSession(db, tokenOf(req), cfg.sessionIdleMinutes);

  api.get('/auth/state', (req, res) => res.json({ setup: isSetUp(db), signedIn: isSetUp(db) && authed(req), version: cfg.version }));

  api.post('/auth/setup', (req, res) => {
    if (isSetUp(db)) return res.status(409).json({ error: 'already set up' });
    const pw = req.body?.password;
    const problem = passwordProblem(pw);
    if (problem) return res.status(400).json({ error: problem });
    setPassword(db, pw);
    setCookie(res, createSession(db), 400 * 86400_000);
    log.info('password created at first run');
    res.json({ ok: true });
  });

  api.post('/auth/login', (req, res) => {
    const ip = req.ip || 'x';
    if (loginLimiter.blocked(ip)) return res.status(429).json({ error: 'too many attempts, wait 15 minutes' });
    if (!isSetUp(db)) return res.status(409).json({ error: 'not set up' });
    if (!checkPassword(db, req.body?.password)) {
      loginLimiter.fail(ip);
      log.warn('sign-in failed', { ip });
      return res.status(401).json({ error: 'wrong password' });
    }
    loginLimiter.reset(ip);
    setCookie(res, createSession(db), 400 * 86400_000);
    log.info('signed in', { ip });
    res.json({ ok: true });
  });

  api.post('/auth/logout', (req, res) => { dropSession(db, tokenOf(req)); setCookie(res, '', 0); res.json({ ok: true }); });

  // Everything below needs a session.
  api.use((req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'sign-in required' })));

  api.post('/auth/password', (req, res) => {
    const ip = req.ip || 'x';
    if (loginLimiter.blocked(ip)) return res.status(429).json({ error: 'too many attempts, wait 15 minutes' });
    if (!checkPassword(db, req.body?.current)) { loginLimiter.fail(ip); return res.status(401).json({ error: 'current password is wrong' }); }
    const problem = passwordProblem(req.body?.next);
    if (problem) return res.status(400).json({ error: problem });
    setPassword(db, req.body.next);
    dropAllSessions(db);
    setCookie(res, createSession(db), 400 * 86400_000);
    log.info('password changed');
    res.json({ ok: true });
  });

  const nameMap = () => new Map(db.prepare('SELECT address, name FROM contacts').all().map((r) => [r.address, r.name]));
  const nameOf = (names, a) => (a ? names.get(a) || formatNumber(a) : null);

  api.get('/conversations', (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const like = `%${q.replace(/[%_]/g, '')}%`;
    const digits = q.replace(/\D/g, '');
    const rows = db.prepare(`SELECT id, title, participants, is_group, first_date, last_date, message_count, media_count, media_bytes, last_snippet
      FROM conversations WHERE (? = '' OR title LIKE ? OR (? <> '' AND participants LIKE ?)) ORDER BY last_date DESC LIMIT ? OFFSET ?`)
      .all(q, like, digits, `%${digits}%`, limit, offset)
      .map((r) => ({ ...r, participants: JSON.parse(r.participants) }));
    const total = db.prepare('SELECT COUNT(*) n FROM conversations').get().n;
    res.json({ conversations: rows, total });
  });

  api.get('/conversations/:id', (req, res) => {
    const r = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(req.params.id));
    if (!r) return res.status(404).json({ error: 'not found' });
    const names = nameMap();
    const participants = JSON.parse(r.participants).map((a) => ({ address: a, name: nameOf(names, a) }));
    res.json({ ...r, participants });
  });

  const partsFor = db.prepare('SELECT id, message_id, seq, ct, name, media_sha256, media_size, missing FROM parts WHERE message_id = ? AND (media_sha256 IS NOT NULL OR missing = 1) ORDER BY seq, id');
  function shapeMessages(rows) {
    const names = nameMap();
    return rows.map((m) => ({
      id: m.id, kind: m.kind, date: m.date, box: m.box, sender: m.sender, senderName: nameOf(names, m.sender), body: m.body,
      restricted: !!m.restricted, mediaMissing: m.media_missing,
      parts: m.media_count ? partsFor.all(m.id).map((p) => ({ id: p.id, ct: p.ct, name: p.name, sha: p.media_sha256, size: p.media_size, missing: !!p.missing })) : [],
    }));
  }

  api.get('/conversations/:id/messages', (req, res) => {
    const cid = Number(req.params.id);
    const limit = Math.min(Math.max(Number(req.query.limit) || 80, 1), 500);
    const cols = 'id, kind, date, box, sender, body, restricted, media_count, media_missing';
    let rows, hasOlder, hasNewer;
    const older = db.prepare(`SELECT ${cols} FROM messages WHERE conversation_id = ? AND (date < ? OR (date = ? AND id < ?)) ORDER BY date DESC, id DESC LIMIT ?`);
    const newer = db.prepare(`SELECT ${cols} FROM messages WHERE conversation_id = ? AND (date > ? OR (date = ? AND id > ?)) ORDER BY date ASC, id ASC LIMIT ?`);
    if (req.query.around || req.query.aroundDate) {
      let anchor;
      if (req.query.around) anchor = db.prepare('SELECT id, date FROM messages WHERE id = ? AND conversation_id = ?').get(Number(req.query.around), cid);
      if (!anchor) {
        const d = Number(req.query.aroundDate) || 0;
        anchor = db.prepare('SELECT id, date FROM messages WHERE conversation_id = ? AND date >= ? ORDER BY date, id LIMIT 1').get(cid, d)
          || db.prepare('SELECT id, date FROM messages WHERE conversation_id = ? ORDER BY date DESC, id DESC LIMIT 1').get(cid);
      }
      if (!anchor) return res.json({ messages: [], hasOlder: false, hasNewer: false });
      const half = Math.floor(limit / 2);
      const before = older.all(cid, anchor.date, anchor.date, anchor.id, half + 1);
      const after = newer.all(cid, anchor.date, anchor.date, anchor.id - 1, half + 1);
      hasOlder = before.length > half;
      hasNewer = after.length > half;
      rows = [...before.slice(0, half).reverse(), ...after.slice(0, half)];
      return res.json({ messages: shapeMessages(rows), hasOlder, hasNewer, anchor: anchor.id });
    }
    if (req.query.afterDate !== undefined) {
      rows = newer.all(cid, Number(req.query.afterDate), Number(req.query.afterDate), Number(req.query.afterId) || 0, limit + 1);
      hasNewer = rows.length > limit;
      return res.json({ messages: shapeMessages(rows.slice(0, limit)), hasNewer });
    }
    const bd = req.query.beforeDate !== undefined ? Number(req.query.beforeDate) : Number.MAX_SAFE_INTEGER;
    const bi = req.query.beforeId !== undefined ? Number(req.query.beforeId) : Number.MAX_SAFE_INTEGER;
    rows = older.all(cid, bd, bd, bi, limit + 1);
    hasOlder = rows.length > limit;
    res.json({ messages: shapeMessages(rows.slice(0, limit).reverse()), hasOlder, hasNewer: req.query.beforeDate !== undefined });
  });

  api.get('/search', (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 200);
    const tokens = (q.match(/[\p{L}\p{N}]+/gu) || []).slice(0, 12);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const where = [];
    const args = [];
    if (req.query.conversation) { where.push('m.conversation_id = ?'); args.push(Number(req.query.conversation)); }
    if (req.query.from) { where.push('m.date >= ?'); args.push(Number(req.query.from)); }
    if (req.query.to) { where.push('m.date < ?'); args.push(Number(req.query.to)); }
    if (req.query.media === '1') where.push('m.media_count > 0');
    if (!tokens.length && !where.length) return res.json({ results: [], total: 0, tokens: [] });
    let from = 'messages m';
    if (tokens.length) {
      const match = tokens.map((t, i) => `"${t.replace(/"/g, '')}"${i === tokens.length - 1 ? '*' : ''}`).join(' ');
      from = 'messages_fts f JOIN messages m ON m.id = f.rowid';
      where.unshift('messages_fts MATCH ?');
      args.unshift(match);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    let total, rows;
    try {
      total = db.prepare(`SELECT COUNT(*) n FROM ${from} ${w}`).get(...args).n;
      rows = db.prepare(`SELECT m.id, m.conversation_id, m.date, m.box, m.sender, m.body, m.media_count, c.title FROM ${from} JOIN conversations c ON c.id = m.conversation_id ${w} ORDER BY m.date DESC, m.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    } catch (e) {
      return res.status(400).json({ error: 'search could not be run', detail: e.message });
    }
    const names = nameMap();
    res.json({
      total, tokens,
      results: rows.map((r) => ({ id: r.id, conversationId: r.conversation_id, title: r.title, date: r.date, box: r.box, senderName: nameOf(names, r.sender), mediaCount: r.media_count, snippet: snippet(r.body || '', tokens) })),
    });
  });

  api.get('/media/:sha', (req, res) => {
    const sha = String(req.params.sha);
    if (!HEX64.test(sha)) return res.status(400).end();
    const row = db.prepare('SELECT size, ct FROM media WHERE sha256 = ?').get(sha);
    if (!row) return res.status(404).end();
    const file = mediaPath(cfg.filesDir, sha);
    if (!fs.existsSync(file)) return res.status(404).end();
    const inline = row.ct && SAFE_INLINE.test(row.ct) && req.query.download === undefined;
    const name = String(req.query.name || sha).replace(/[^\w.\- ]/g, '_').slice(0, 120);
    res.set('Content-Security-Policy', "sandbox; default-src 'none'");
    res.sendFile(file, {
      headers: {
        'Content-Type': inline ? row.ct : 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  });

  api.get('/stats', (_req, res) => {
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    const cutoff = Date.now() - cfg.cutoffDays * 86400_000;
    const keep = Date.now() - cfg.keepRecentDays * 86400_000;
    const before = Math.min(cutoff, keep);
    res.json({
      totals: {
        messages: one('SELECT COUNT(*) n FROM messages').n,
        sms: one("SELECT COUNT(*) n FROM messages WHERE kind = 'sms'").n,
        mms: one("SELECT COUNT(*) n FROM messages WHERE kind = 'mms'").n,
        conversations: one('SELECT COUNT(*) n FROM conversations').n,
        mediaFiles: one('SELECT COUNT(*) n FROM media').n,
        mediaBytes: one('SELECT COALESCE(SUM(size),0) n FROM media').n,
        mediaMissing: one('SELECT COUNT(*) n FROM parts WHERE missing = 1').n,
        restricted: one('SELECT COUNT(*) n FROM messages WHERE restricted = 1').n,
        oldest: one('SELECT MIN(date) n FROM messages').n,
        newest: one('SELECT MAX(date) n FROM messages').n,
        selfAddresses: db.prepare('SELECT address FROM self_addresses').all().map((r) => r.address),
      },
      byYear: db.prepare(`SELECT strftime('%Y', date / 1000, 'unixepoch') AS year, COUNT(*) AS messages,
          SUM(CASE WHEN kind = 'mms' THEN 1 ELSE 0 END) AS mms,
          (SELECT COALESCE(SUM(p.media_size),0) FROM parts p JOIN messages m2 ON m2.id = p.message_id WHERE strftime('%Y', m2.date / 1000, 'unixepoch') = strftime('%Y', messages.date / 1000, 'unixepoch')) AS media_bytes
        FROM messages GROUP BY year ORDER BY year`).all(),
      cutoff: {
        days: cfg.cutoffDays, keepRecentDays: cfg.keepRecentDays, before,
        messages: one('SELECT COUNT(*) n FROM messages WHERE date < ?', before).n,
        mediaParts: one('SELECT COUNT(*) n FROM parts p JOIN messages m ON m.id = p.message_id WHERE m.date < ? AND p.media_sha256 IS NOT NULL', before).n,
        mediaBytes: one('SELECT COALESCE(SUM(p.media_size),0) n FROM parts p JOIN messages m ON m.id = p.message_id WHERE m.date < ?', before).n,
      },
    });
  });

  api.get('/imports', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = db.prepare(`SELECT id, source, file_name, file_size, status, started_at, finished_at, backup_date, backup_type, count_attr, parsed,
      parsed_sms, parsed_mms, new_messages, existing_messages, upgraded_messages, media_parts, media_new, media_new_bytes, media_missing, restricted, message
      FROM imports ORDER BY id DESC LIMIT ?`).all(limit);
    res.json({ imports: rows, jobs: jobs.status(), inbox: { scanIntervalMinutes: cfg.scanIntervalMinutes, settleSeconds: cfg.settleSeconds } });
  });
  api.post('/imports/scan', (_req, res) => { jobs.scan({ force: false }); res.json({ ok: true, jobs: jobs.status() }); });
  api.post('/imports/:id/retry', (req, res) => {
    const row = db.prepare('SELECT * FROM imports WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'not found' });
    if (!row.file_path || !fs.existsSync(row.file_path)) return res.status(410).json({ error: 'the file is no longer in the inbox' });
    jobs.retry(row);
    res.json({ ok: true });
  });
  api.post('/media/verify', (_req, res) => { jobs.verifyMedia(); res.json({ ok: true, jobs: jobs.status() }); });
  api.get('/jobs', (_req, res) => res.json(jobs.status()));

  api.get('/settings', (req, res) => res.json({
    version: cfg.version,
    dav: { enabled: !!getSetting(db, 'dav_password_hash'), user: DAV_USER, path: '/dav/' },
    cutoffDays: cfg.cutoffDays, keepRecentDays: cfg.keepRecentDays, countryCode: cfg.countryCode,
    selfAddresses: db.prepare('SELECT address, source FROM self_addresses ORDER BY address').all(),
  }));
  api.post('/settings/dav-password', (req, res) => {
    if (req.body?.disable) { db.prepare("DELETE FROM settings WHERE key = 'dav_password_hash'").run(); log.info('webdav disabled'); return res.json({ ok: true, enabled: false }); }
    const pw = req.body?.generate ? crypto.randomBytes(15).toString('base64url') : req.body?.password;
    const problem = passwordProblem(pw);
    if (problem) return res.status(400).json({ error: problem });
    setSetting(db, 'dav_password_hash', hashPassword(pw));
    log.info('webdav password set');
    res.json({ ok: true, enabled: true, password: req.body?.generate ? pw : undefined });
  });

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
  app.use((_req, res) => res.status(404).type('text/plain').send('not found'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    log.error('request failed', { err: err.message });
    if (!res.headersSent) res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.status === 400 ? 'bad request' : 'server error' });
  });
  return app;
}

// Short excerpt around the first match, as segments the browser renders as text (no HTML).
// Matching ignores case and accents, like the search index (unicode61 remove_diacritics 2).
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function foldMap(s) {
  let out = '';
  const map = [];
  for (let i = 0; i < s.length; i++) { const f = fold(s[i]); out += f; for (let k = 0; k < f.length; k++) map.push(i); }
  return { out, map };
}
const isLow = (s, i) => { const c = s.charCodeAt(i); return c >= 0xdc00 && c <= 0xdfff; };
export function snippet(body, tokens, width = 160) {
  if (!body) return [];
  const ft = tokens.map(fold).filter(Boolean);
  const all = foldMap(body);
  let first = -1;
  for (const t of ft) { const i = all.out.indexOf(t); if (i >= 0 && (first < 0 || i < first)) first = i; }
  let start = first < 0 ? 0 : Math.max(0, all.map[first] - Math.floor(width / 3));
  if (start > 0 && isLow(body, start)) start--;
  let end = Math.min(body.length, start + width);
  if (end < body.length && isLow(body, end)) end++;
  const piece = body.slice(start, end);
  const pm = foldMap(piece);
  const marks = new Array(piece.length).fill(false);
  for (const t of ft) {
    let i = pm.out.indexOf(t);
    while (i >= 0) { for (let k = i; k < i + t.length; k++) marks[pm.map[k]] = true; i = pm.out.indexOf(t, i + t.length); }
  }
  const segs = [];
  for (let i = 0; i < piece.length; i++) {
    const last = segs[segs.length - 1];
    if (last && last.h === marks[i]) last.t += piece[i];
    else segs.push({ t: piece[i], h: marks[i] });
  }
  if (start > 0) segs.unshift({ t: '…', h: false });
  if (end < body.length) segs.push({ t: '…', h: false });
  return segs;
}
