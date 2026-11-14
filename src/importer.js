import fs from 'node:fs';
import path from 'node:path';
import { SaxesParser } from 'saxes';
import yauzl from 'yauzl';
import { smsFingerprint, mmsFingerprint, normAddr } from './fingerprint.js';
import { storeMedia, mediaPath, hashFile } from './media.js';
import { rethread } from './threads.js';

const BATCH = 200;
const NON_MEDIA = new Set(['application/smil', 'text/plain']);
const isMediaPart = (p) => p.ct && !NON_MEDIA.has(String(p.ct).toLowerCase()) && String(p.seq) !== '-1';
const nul = (v) => (v === undefined || v === null || v === 'null' ? null : v);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

export function isBackupName(name) {
  return /\.xml(\.zip)?$/i.test(name) && !/^calls/i.test(name) && !name.startsWith('.');
}

// --- character clean-up -----------------------------------------------------
// Older SMS Backup & Restore versions wrote emoji as two numeric entities (a UTF-16
// surrogate pair), which is not well-formed XML. Join such pairs into the real character
// and replace other characters XML forbids, so one odd message never stops an import.
function codeOf(m) { return m[0] === 'x' ? parseInt(m.slice(1), 16) : parseInt(m, 10); }
const allowed = (c) => c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff);
export function fixEntities(s) {
  if (!s.includes('&#')) return s;
  return s.replace(/&#(x[0-9a-fA-F]+|[0-9]+);&#(x[0-9a-fA-F]+|[0-9]+);|&#(x[0-9a-fA-F]+|[0-9]+);/g, (all, a, b, single) => {
    if (single !== undefined) {
      const c = codeOf(single);
      return allowed(c) ? all : '�';
    }
    const hi = codeOf(a), lo = codeOf(b);
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) return String.fromCodePoint((hi - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000);
    return (allowed(hi) ? `&#${a};` : '�') + (allowed(lo) ? `&#${b};` : '�');
  });
}
// Raw control characters that XML 1.0 forbids (seen in some carrier messages).
const BAD_RAW = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function openXmlStream(file) {
  if (!/\.zip$/i.test(file)) {
    const s = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    s.setEncoding('utf8');
    return Promise.resolve(s);
  }
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        if (entry.generalPurposeBitFlag & 1) return reject(new Error('the zip is password-protected; turn off the backup password in SMS Backup & Restore'));
        zip.openReadStream(entry, (e2, s) => {
          if (e2) return reject(e2);
          s.setEncoding('utf8');
          resolve(s);
        });
      });
      zip.on('end', () => reject(new Error('zip has no XML entry')));
      zip.readEntry();
    });
  });
}

// --- import one file ----------------------------------------------------------
export async function importFile(ctx, file, opts = {}) {
  const { db, cfg, log } = ctx;
  const cc = cfg.countryCode;
  const shouldStop = opts.shouldStop || (() => false);
  const source = opts.source || 'inbox';
  const st = fs.statSync(file);
  const fileName = path.basename(file);
  const { sha: fileSha } = await hashFile(file);

  if (!opts.force) {
    const same = db.prepare("SELECT id FROM imports WHERE file_sha256 = ? AND status = 'verified' ORDER BY id LIMIT 1").get(fileSha);
    if (same) {
      const id = Number(db.prepare(`INSERT INTO imports (source, file_name, file_path, file_size, file_mtime, file_sha256, status, started_at, finished_at, message)
        VALUES (?, ?, ?, ?, ?, ?, 'skipped', ?, ?, ?)`).run(source, fileName, file, st.size, Math.floor(st.mtimeMs), fileSha, Date.now(), Date.now(), `identical to import #${same.id}`).lastInsertRowid);
      return db.prepare('SELECT * FROM imports WHERE id = ?').get(id);
    }
  }

  const importId = Number(db.prepare(`INSERT INTO imports (source, file_name, file_path, file_size, file_mtime, file_sha256, status, started_at)
    VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`).run(source, fileName, file, st.size, Math.floor(st.mtimeMs), fileSha, Date.now()).lastInsertRowid);
  log.info('import started', { id: importId, file: fileName, bytes: st.size });

  const c = { parsed: 0, parsed_sms: 0, parsed_mms: 0, new_messages: 0, existing_messages: 0, upgraded_messages: 0, media_parts: 0, media_new: 0, media_new_bytes: 0, media_missing: 0, restricted: 0 };
  const root = { name: null, count: null, backup_set: null, backup_date: null, type: null };
  const fileFp = new Map();       // fp -> occurrences in this file
  const fileMediaByFp = new Map(); // fp -> media parts with data in this file

  const q = {
    byFp: db.prepare('SELECT id, body, media_missing FROM messages WHERE fp = ?'),
    insMsg: db.prepare(`INSERT INTO messages (fp, kind, address, date, date_sent, box, body, read, restricted, media_count, media_missing, first_import_id, attrs, addrs)
      VALUES (@fp, @kind, @address, @date, @date_sent, @box, @body, @read, @restricted, @media_count, @media_missing, @first_import_id, @attrs, @addrs)`),
    insFts: db.prepare('INSERT INTO messages_fts (rowid, body) VALUES (?, ?)'),
    delFts: db.prepare('DELETE FROM messages_fts WHERE rowid = ?'),
    updBody: db.prepare('UPDATE messages SET body = ? WHERE id = ?'),
    insPart: db.prepare(`INSERT INTO parts (message_id, seq, ct, name, text, media_sha256, media_size, missing, attrs)
      VALUES (@message_id, @seq, @ct, @name, @text, @media_sha256, @media_size, @missing, @attrs)`),
    missingParts: db.prepare('SELECT id, seq, ct, name FROM parts WHERE message_id = ? AND missing = 1'),
    fillPart: db.prepare('UPDATE parts SET media_sha256 = ?, media_size = ?, missing = 0 WHERE id = ?'),
    updMissing: db.prepare('UPDATE messages SET media_missing = (SELECT COUNT(*) FROM parts WHERE message_id = ? AND missing = 1) WHERE id = ?'),
    insMedia: db.prepare('INSERT OR IGNORE INTO media (sha256, size, ct, created_at) VALUES (?, ?, ?, ?)'),
    insSource: db.prepare('INSERT OR IGNORE INTO message_sources (message_id, import_id) VALUES (?, ?)'),
    contact: db.prepare(`INSERT INTO contacts (address, name, name_date) VALUES (?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET name = excluded.name, name_date = excluded.name_date WHERE excluded.name_date >= contacts.name_date`),
    copies: db.prepare('UPDATE messages SET copies = MAX(copies, ?) WHERE fp = ?'),
  };

  const noteContact = (address, name, date) => {
    if (!name || name === '(Unknown)' || name.includes(',')) return;
    const a = normAddr(address, cc);
    if (a && !String(address).includes('~')) q.contact.run(a, name, date || 0);
  };
  const seeFp = (fp) => fileFp.set(fp, (fileFp.get(fp) || 0) + 1);

  function onSms(a) {
    c.parsed++; c.parsed_sms++;
    const fp = smsFingerprint(a, cc);
    seeFp(fp);
    if (a.restricted === '1') c.restricted++;
    const ex = q.byFp.get(fp);
    let id;
    if (ex) { c.existing_messages++; id = ex.id; }
    else {
      const { body, ...rest } = a;
      id = Number(q.insMsg.run({
        fp, kind: 'sms', address: nul(a.address), date: num(a.date) ?? 0, date_sent: num(a.date_sent), box: num(a.type) ?? 0,
        body: nul(body), read: num(a.read), restricted: a.restricted === '1' ? 1 : 0, media_count: 0, media_missing: 0,
        first_import_id: importId, attrs: JSON.stringify(rest), addrs: null,
      }).lastInsertRowid);
      if (nul(body)) q.insFts.run(id, body);
      c.new_messages++;
    }
    q.insSource.run(id, importId);
    noteContact(a.address, a.contact_name, num(a.date));
  }

  function onMms(m) {
    c.parsed++; c.parsed_mms++;
    const a = m.attrs;
    const text = m.parts.filter((p) => String(p.ct).toLowerCase() === 'text/plain' && nul(p.text)).map((p) => p.text).join('\n');
    const fp = mmsFingerprint(a, m.addrs, text, cc);
    seeFp(fp);
    if (a.restricted === '1') c.restricted++;
    const ex = q.byFp.get(fp);
    const mediaParts = m.parts.filter(isMediaPart);
    let withData = 0;

    const store = (p) => {
      const buf = Buffer.from(p.data, 'base64');
      const r = storeMedia(cfg.filesDir, buf);
      q.insMedia.run(r.sha, r.size, nul(p.ct), Date.now());
      if (r.written) { c.media_new++; c.media_new_bytes += r.size; }
      return r;
    };

    let id;
    if (!ex) {
      const stored = new Map();
      for (const p of mediaParts) {
        if (nul(p.data)) { stored.set(p, store(p)); withData++; c.media_parts++; }
        else c.media_missing++;
      }
      id = Number(q.insMsg.run({
        fp, kind: 'mms', address: nul(a.address), date: num(a.date) ?? 0, date_sent: num(a.date_sent), box: num(a.msg_box) ?? 0,
        body: text || null, read: num(a.read), restricted: a.restricted === '1' ? 1 : 0,
        media_count: mediaParts.length, media_missing: mediaParts.length - withData,
        first_import_id: importId, attrs: JSON.stringify(a), addrs: JSON.stringify(m.addrs),
      }).lastInsertRowid);
      for (const p of m.parts) {
        const { data, text: t, ...rest } = p;
        const s = stored.get(p);
        const media = isMediaPart(p);
        q.insPart.run({
          message_id: id, seq: num(p.seq), ct: nul(p.ct), name: nul(p.cl) || nul(p.name), text: nul(t),
          media_sha256: s?.sha ?? null, media_size: s?.size ?? null, missing: media && !s ? 1 : 0, attrs: JSON.stringify(rest),
        });
      }
      if (text) q.insFts.run(id, text);
      c.new_messages++;
    } else {
      id = ex.id;
      c.existing_messages++;
      let upgraded = false;
      if (ex.media_missing > 0) {
        const holes = q.missingParts.all(id);
        for (const h of holes) {
          const cand = mediaParts.find((p) => nul(p.data) && String(p.ct) === String(h.ct) && num(p.seq) === h.seq && (nul(p.cl) || nul(p.name)) === h.name);
          if (cand) { const r = store(cand); q.fillPart.run(r.sha, r.size, h.id); upgraded = true; }
        }
        if (upgraded) q.updMissing.run(id, id);
      }
      if (!ex.body && text) { q.updBody.run(text, id); q.delFts.run(id); q.insFts.run(id, text); upgraded = true; }
      if (upgraded) c.upgraded_messages++;
      for (const p of mediaParts) { if (nul(p.data)) { withData++; c.media_parts++; } else c.media_missing++; }
    }
    fileMediaByFp.set(fp, Math.max(fileMediaByFp.get(fp) || 0, withData));
    q.insSource.run(id, importId);
    if (!String(a.address || '').includes('~')) noteContact(a.address, a.contact_name, num(a.date));
  }

  // --- streaming parse ---
  let status = 'verified';
  let message = null;
  let verify = null;
  let inTx = false;
  let sinceCommit = 0;
  const begin = () => { db.exec('BEGIN'); inTx = true; sinceCommit = 0; };
  const commit = () => { if (inTx) { db.exec('COMMIT'); inTx = false; } };
  const tick = () => { if (++sinceCommit >= BATCH) { commit(); begin(); } };

  try {
    const stream = await openXmlStream(file);
    const parser = new SaxesParser({ xmlns: false });
    let cur = null;
    let depth = 0;
    parser.on('opentag', (node) => {
      depth++;
      const n = node.name;
      if (depth === 1) {
        root.name = n;
        if (n !== 'smses') return;
        root.count = num(node.attributes.count);
        root.backup_set = nul(node.attributes.backup_set);
        root.backup_date = num(node.attributes.backup_date);
        root.type = nul(node.attributes.type);
        return;
      }
      if (root.name !== 'smses') return;
      if (n === 'sms' && depth === 2) { onSms({ ...node.attributes }); tick(); }
      else if (n === 'mms' && depth === 2) cur = { attrs: { ...node.attributes }, parts: [], addrs: [] };
      else if (n === 'part' && cur) cur.parts.push({ ...node.attributes });
      else if (n === 'addr' && cur) cur.addrs.push({ ...node.attributes });
    });
    parser.on('closetag', (node) => {
      depth--;
      if (node.name === 'mms' && cur && depth === 1) { onMms(cur); cur = null; tick(); }
    });
    begin();
    let carry = '';
    for await (const chunk of stream) {
      let s = carry + chunk;
      const amp = s.lastIndexOf('&');
      const tailEnt = /&#(x[0-9a-fA-F]+|[0-9]+);$/.exec(s);
      if (amp >= 0 && amp > s.length - 40 && s.indexOf(';', amp) === -1) { carry = s.slice(amp); s = s.slice(0, amp); }
      else if (tailEnt && codeOf(tailEnt[1]) >= 0xd800 && codeOf(tailEnt[1]) <= 0xdbff) { carry = tailEnt[0]; s = s.slice(0, tailEnt.index); }
      else carry = '';
      parser.write(fixEntities(s).replace(BAD_RAW, '�'));
      if (root.name && root.name !== 'smses') { stream.destroy?.(); break; }
      if (shouldStop()) { stream.destroy?.(); status = 'interrupted'; message = 'stopped before the end of the file; it will be retried on the next scan'; break; }
    }
    if (status !== 'interrupted' && !(root.name && root.name !== 'smses')) {
      if (carry) parser.write(fixEntities(carry));
      parser.close();
    }
    for (const [fp, n] of fileFp) if (n > 1) q.copies.run(n, fp);
    commit();
    if (root.name === 'calls') { status = 'skipped'; message = 'call log backup, ignored'; }
    else if (root.name !== 'smses') { status = 'failed'; message = `not an SMS Backup & Restore message file (root <${root.name}>)`; }
  } catch (e) {
    try { if (inTx) { db.exec('COMMIT'); inTx = false; } } catch { try { db.exec('ROLLBACK'); } catch { /* ignore */ } }
    status = 'failed';
    message = e.message;
    log.warn('import failed', { id: importId, err: e.message });
  }

  if (status === 'verified') {
    verify = verifyImport(db, cfg, root, c, fileFp, fileMediaByFp);
    if (!verify.ok) { status = 'failed'; message = verify.problems.join('; '); }
    else message = `${c.parsed} records verified: ${c.new_messages} new, ${c.existing_messages} already archived${c.media_missing ? `, ${c.media_missing} attachment${c.media_missing === 1 ? '' : 's'} without data` : ''}`;
  }

  db.prepare(`UPDATE imports SET status = @status, finished_at = @finished_at, backup_set = @backup_set, backup_date = @backup_date, backup_type = @backup_type,
    count_attr = @count_attr, parsed = @parsed, parsed_sms = @parsed_sms, parsed_mms = @parsed_mms, new_messages = @new_messages,
    existing_messages = @existing_messages, upgraded_messages = @upgraded_messages, media_parts = @media_parts, media_new = @media_new,
    media_new_bytes = @media_new_bytes, media_missing = @media_missing, restricted = @restricted, message = @message, verify_json = @verify_json WHERE id = @id`).run({
    ...c, status, finished_at: Date.now(), backup_set: root.backup_set, backup_date: root.backup_date, backup_type: root.type,
    count_attr: root.count, message, verify_json: verify ? JSON.stringify(verify) : null, id: importId,
  });
  if (c.new_messages || c.upgraded_messages) rethread(db, cfg);
  log.info('import finished', { id: importId, status, parsed: c.parsed, new: c.new_messages, media_new: c.media_new, missing_media: c.media_missing });
  return db.prepare('SELECT * FROM imports WHERE id = ?').get(importId);
}

// Every record in the file must be in the database, with at least as many media files as
// the file carried, and every one of those files must be on disk with the recorded size.
function verifyImport(db, cfg, root, c, fileFp, fileMediaByFp) {
  const problems = [];
  if (root.count !== null && root.count !== c.parsed) problems.push(`file says ${root.count} records, parsed ${c.parsed}`);
  const getMsg = db.prepare('SELECT id FROM messages WHERE fp = ?');
  const getParts = db.prepare('SELECT media_sha256, media_size FROM parts WHERE message_id = ? AND media_sha256 IS NOT NULL');
  const getMedia = db.prepare('SELECT size FROM media WHERE sha256 = ?');
  let missingMsgs = 0, missingFiles = 0, shortMedia = 0, filesChecked = 0;
  const checked = new Set();
  for (const fp of fileFp.keys()) {
    const m = getMsg.get(fp);
    if (!m) { missingMsgs++; continue; }
    const parts = getParts.all(m.id);
    if (parts.length < (fileMediaByFp.get(fp) || 0)) shortMedia++;
    for (const p of parts) {
      if (checked.has(p.media_sha256)) continue;
      checked.add(p.media_sha256);
      filesChecked++;
      const row = getMedia.get(p.media_sha256);
      let size = -1;
      try { size = fs.statSync(mediaPath(cfg.filesDir, p.media_sha256)).size; } catch { /* missing */ }
      if (!row || size !== row.size || size !== p.media_size) missingFiles++;
    }
  }
  if (missingMsgs) problems.push(`${missingMsgs} messages from the file are not in the archive`);
  if (shortMedia) problems.push(`${shortMedia} messages have fewer stored media files than the file carried`);
  if (missingFiles) problems.push(`${missingFiles} media files are missing or the wrong size on disk`);
  return { ok: problems.length === 0, problems, records: c.parsed, unique: fileFp.size, mediaFilesChecked: filesChecked };
}

// --- inbox scan ---------------------------------------------------------------
function walk(dir, depth, out) {
  if (depth > 4) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1, out);
    else if (e.isFile() && isBackupName(e.name)) out.push(p);
  }
  return out;
}

export async function scanInbox(ctx, { shouldStop = () => false, ready = new Set(), force = false } = {}) {
  const { db, cfg } = ctx;
  const files = walk(cfg.inboxDir, 0, []).sort();
  const seen = db.prepare("SELECT id FROM imports WHERE file_path = ? AND file_size = ? AND file_mtime = ? AND status <> 'interrupted' LIMIT 1");
  const results = [];
  for (const f of files) {
    if (shouldStop()) break;
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (!force && seen.get(f, st.size, Math.floor(st.mtimeMs))) continue;
    if (!ready.has(f) && Date.now() - st.mtimeMs < cfg.settleSeconds * 1000) continue; // still being copied
    results.push(await importFile(ctx, f, { shouldStop, source: ready.has(f) ? 'dav' : 'inbox' }));
  }
  return results;
}
