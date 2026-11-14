import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { getSetting } from './db.js';
import { verifyPassword, makeLimiter } from './auth.js';

// Minimal WebDAV (class 1, plus no-op locks) so SMS Backup & Restore can upload its backups
// straight into the inbox. Basic auth, user "archive", password set in Settings.
export const DAV_USER = 'archive';
const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n';
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export function createDav({ db, cfg, log, onUploaded = () => {} }) {
  const root = cfg.inboxDir;
  const limiter = makeLimiter({ max: 10, windowMs: 15 * 60_000 });
  const okCache = new Map(); // sha256(header) -> expiry; avoids an scrypt per request

  function authorized(req) {
    const stored = getSetting(db, 'dav_password_hash');
    if (!stored) return 'disabled';
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return false;
    const key = crypto.createHash('sha256').update(h + stored).digest('hex');
    const exp = okCache.get(key);
    if (exp && exp > Date.now()) return true;
    const ip = req.ip || 'x';
    if (limiter.blocked(ip)) return 'limited';
    const raw = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const i = raw.indexOf(':');
    const user = raw.slice(0, i), pw = raw.slice(i + 1);
    if (i > 0 && user === DAV_USER && verifyPassword(pw, stored)) {
      okCache.set(key, Date.now() + 10 * 60_000);
      limiter.reset(ip);
      return true;
    }
    limiter.fail(ip);
    log.warn('webdav sign-in failed', { ip });
    return false;
  }

  // Map a request path to a file inside the inbox, refusing anything that escapes it.
  function resolve(urlPath) {
    let rel;
    try { rel = urlPath.split('/').filter(Boolean).map((s) => decodeURIComponent(s)); } catch { return null; }
    if (rel.some((s) => s === '..' || s === '.' || s.startsWith('.') || s.includes('/') || s.includes('\\') || s.includes('\0'))) return null;
    const full = path.resolve(root, ...rel);
    if (full !== root && !full.startsWith(root + path.sep)) return null;
    return { full, rel };
  }
  const hrefOf = (rel, dir) => '/dav/' + rel.map(encodeURIComponent).join('/') + (dir && rel.length ? '/' : '');

  function propEntry(rel, st) {
    const dir = st.isDirectory();
    const name = rel.length ? rel[rel.length - 1] : '';
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    return `<d:response><d:href>${esc(hrefOf(rel, dir))}</d:href><d:propstat><d:prop>`
      + `<d:displayname>${esc(name)}</d:displayname>`
      + `<d:resourcetype>${dir ? '<d:collection/>' : ''}</d:resourcetype>`
      + `<d:creationdate>${new Date(st.birthtimeMs || st.mtimeMs).toISOString()}</d:creationdate>`
      + `<d:getlastmodified>${new Date(st.mtimeMs).toUTCString()}</d:getlastmodified>`
      + (dir ? '' : `<d:getcontentlength>${st.size}</d:getcontentlength><d:getcontenttype>${/\.zip$/i.test(name) ? 'application/zip' : 'application/xml'}</d:getcontenttype><d:getetag>${etag}</d:getetag>`)
      + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
  }

  const drain = (req) => new Promise((r) => { req.resume(); req.on('end', r); req.on('error', r); });
  const exists = (p) => { try { return fs.statSync(p); } catch { return null; } };

  return async function dav(req, res) {
    res.set('DAV', '1, 2');
    res.set('MS-Author-Via', 'DAV');
    const auth = authorized(req);
    if (auth !== true) {
      await drain(req);
      if (auth === 'disabled') return res.status(503).type('text/plain').send('WebDAV upload is off: set a WebDAV password in Message Archive settings');
      if (auth === 'limited') return res.status(429).type('text/plain').send('too many failed sign-ins, try again later');
      res.set('WWW-Authenticate', 'Basic realm="message-archive", charset="UTF-8"');
      return res.status(401).type('text/plain').send('sign-in required');
    }
    const target = resolve(req.path);
    if (!target) { await drain(req); return res.status(403).type('text/plain').send('path not allowed'); }
    const { full, rel } = target;
    const st = exists(full);
    try {
      switch (req.method) {
        case 'OPTIONS':
          await drain(req);
          res.set('Allow', 'OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK');
          return res.status(200).end();
        case 'PROPFIND': {
          await drain(req);
          if (!st) return res.status(404).end();
          const depth = String(req.headers.depth ?? '1');
          let body = propEntry(rel, st);
          if (st.isDirectory() && depth !== '0') {
            for (const e of fs.readdirSync(full, { withFileTypes: true })) {
              if (e.name.startsWith('.')) continue;
              const cst = exists(path.join(full, e.name));
              if (cst) body += propEntry([...rel, e.name], cst);
            }
          }
          return res.status(207).type('application/xml; charset=utf-8').send(`${XML_HEAD}<d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`);
        }
        case 'PROPPATCH':
          await drain(req);
          if (!st) return res.status(404).end();
          return res.status(207).type('application/xml; charset=utf-8').send(`${XML_HEAD}<d:multistatus xmlns:d="DAV:"><d:response><d:href>${esc(hrefOf(rel, st.isDirectory()))}</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
        case 'GET':
        case 'HEAD':
          if (!st) return res.status(404).end();
          if (st.isDirectory()) {
            const names = fs.readdirSync(full).filter((n) => !n.startsWith('.'));
            return res.type('text/plain').send(names.join('\n') + '\n');
          }
          res.set('Content-Length', String(st.size));
          res.type(/\.zip$/i.test(full) ? 'application/zip' : 'application/xml');
          if (req.method === 'HEAD') return res.status(200).end();
          return fs.createReadStream(full).pipe(res);
        case 'PUT': {
          if (!rel.length || (st && st.isDirectory())) { await drain(req); return res.status(405).end(); }
          const parent = path.dirname(full);
          if (!exists(parent)?.isDirectory()) { await drain(req); return res.status(409).type('text/plain').send('parent folder does not exist'); }
          const max = cfg.davMaxGb * 1024 ** 3;
          if (Number(req.headers['content-length'] || 0) > max) { await drain(req); return res.status(413).end(); }
          const tmp = path.join(parent, `.upload-${crypto.randomBytes(6).toString('hex')}-${path.basename(full)}`);
          let n = 0;
          const limit = new Transform({ transform(chunk, _e, cb) { n += chunk.length; cb(n > max ? new Error('upload too large') : null, chunk); } });
          try {
            await pipeline(req, limit, fs.createWriteStream(tmp));
            fs.renameSync(tmp, full);
          } catch (e) {
            fs.rmSync(tmp, { force: true });
            throw e;
          }
          log.info('webdav upload', { file: rel.join('/'), bytes: n });
          res.status(st ? 204 : 201).end();
          onUploaded(full);
          return;
        }
        case 'DELETE':
          await drain(req);
          if (!st || !rel.length) return res.status(st ? 403 : 404).end();
          if (st.isDirectory()) {
            if (fs.readdirSync(full).length) return res.status(403).type('text/plain').send('folder is not empty');
            fs.rmdirSync(full);
          } else fs.unlinkSync(full);
          log.info('webdav delete', { file: rel.join('/') });
          return res.status(204).end();
        case 'MKCOL':
          await drain(req);
          if (st) return res.status(405).end();
          if (!exists(path.dirname(full))?.isDirectory()) return res.status(409).end();
          fs.mkdirSync(full);
          return res.status(201).end();
        case 'MOVE':
        case 'COPY': {
          await drain(req);
          if (!st || !rel.length) return res.status(404).end();
          let destPath;
          try { destPath = new URL(String(req.headers.destination || ''), 'http://x').pathname; } catch { return res.status(400).end(); }
          if (!destPath.startsWith('/dav/')) return res.status(502).end();
          const dest = resolve(destPath.slice(4));
          if (!dest || !dest.rel.length) return res.status(403).end();
          const dst = exists(dest.full);
          if (dst && String(req.headers.overwrite || 'T').toUpperCase() === 'F') return res.status(412).end();
          if (!exists(path.dirname(dest.full))?.isDirectory()) return res.status(409).end();
          if (st.isDirectory() && req.method === 'COPY') return res.status(403).end();
          if (req.method === 'MOVE') fs.renameSync(full, dest.full); else fs.copyFileSync(full, dest.full);
          res.status(dst ? 204 : 201).end();
          if (!st.isDirectory()) onUploaded(dest.full);
          return;
        }
        case 'LOCK': {
          await drain(req);
          const token = `opaquelocktoken:${crypto.randomUUID()}`;
          res.set('Lock-Token', `<${token}>`);
          return res.status(200).type('application/xml; charset=utf-8').send(`${XML_HEAD}<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>0</d:depth><d:timeout>Second-3600</d:timeout><d:locktoken><d:href>${token}</d:href></d:locktoken></d:activelock></d:lockdiscovery></d:prop>`);
        }
        case 'UNLOCK':
          await drain(req);
          return res.status(204).end();
        default:
          await drain(req);
          return res.status(405).end();
      }
    } catch (e) {
      log.warn('webdav error', { method: req.method, err: e.message });
      if (!res.headersSent) res.status(e.message === 'upload too large' ? 413 : 500).type('text/plain').send('error');
    }
  };
}
