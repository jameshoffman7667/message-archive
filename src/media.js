import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Content-addressed store: <filesDir>/media/ab/cd/<sha256>. Same bytes are stored once.
export function mediaPath(filesDir, sha) {
  return path.join(filesDir, 'media', sha.slice(0, 2), sha.slice(2, 4), sha);
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Writes the bytes unless an identical file is already there. Returns { sha, size, written }.
// The file is written to a temp name, flushed, read back and hashed, then renamed into place,
// so a file under its final name always has the content its name says.
export function storeMedia(filesDir, buf) {
  const sha = sha256(buf);
  const target = mediaPath(filesDir, sha);
  try {
    const st = fs.statSync(target);
    if (st.size === buf.length) return { sha, size: buf.length, written: false };
  } catch { /* not there yet */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const back = fs.readFileSync(tmp);
  if (back.length !== buf.length || sha256(back) !== sha) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`media write verification failed for ${sha}`);
  }
  fs.renameSync(tmp, target);
  return { sha, size: buf.length, written: true };
}

export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let size = 0;
    fs.createReadStream(file)
      .on('data', (c) => { h.update(c); size += c.length; })
      .on('error', reject)
      .on('end', () => resolve({ sha: h.digest('hex'), size }));
  });
}

// Re-hash every stored file and record the result. Returns a summary.
export async function verifyAllMedia(db, filesDir, { shouldStop = () => false, onProgress = () => {} } = {}) {
  const rows = db.prepare('SELECT sha256, size FROM media ORDER BY sha256').all();
  const mark = db.prepare('UPDATE media SET verified_at = ?, verify_ok = ? WHERE sha256 = ?');
  const out = { total: rows.length, ok: 0, missing: 0, mismatched: 0, bad: [] };
  let i = 0;
  for (const r of rows) {
    if (shouldStop()) { out.interrupted = true; break; }
    const file = mediaPath(filesDir, r.sha256);
    let ok = false;
    try {
      const got = await hashFile(file);
      ok = got.sha === r.sha256 && got.size === r.size;
      if (!ok) { out.mismatched++; out.bad.push(r.sha256); }
    } catch {
      out.missing++; out.bad.push(r.sha256);
    }
    if (ok) out.ok++;
    mark.run(Date.now(), ok ? 1 : 0, r.sha256);
    if (++i % 200 === 0) onProgress(i, rows.length);
  }
  out.bad = out.bad.slice(0, 50);
  return out;
}
