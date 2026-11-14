import { normAddr, SELF_TOKEN } from './fingerprint.js';

// Your own numbers are learned from the backups: the "From" address of messages you sent,
// and the only "To" address of 1:1 messages you received. SELF_NUMBERS adds fixed ones.
export function learnSelf(db, cfg) {
  const hits = new Map();
  const add = (a, n = 1) => { if (a && a !== SELF_TOKEN) hits.set(a, (hits.get(a) || 0) + n); };
  for (const r of db.prepare("SELECT box, addrs FROM messages WHERE kind = 'mms' AND addrs IS NOT NULL").iterate()) {
    const addrs = JSON.parse(r.addrs);
    if (r.box === 2) for (const x of addrs) if (String(x.type) === '137') add(normAddr(x.address, cfg.countryCode));
    if (r.box === 1) {
      const to = addrs.filter((x) => String(x.type) === '151');
      if (to.length === 1) add(normAddr(to[0].address, cfg.countryCode));
    }
  }
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM self_addresses WHERE source = 'learned'").run();
    const ins = db.prepare("INSERT OR REPLACE INTO self_addresses (address, hits, source) VALUES (?, ?, ?)");
    for (const [a, n] of hits) if (n >= 2) ins.run(a, n, 'learned');
    for (const s of cfg.selfNumbers) ins.run(normAddr(s, cfg.countryCode), 0, 'config');
  });
  tx();
  const self = new Set(db.prepare('SELECT address FROM self_addresses').all().map((r) => r.address));
  self.add(SELF_TOKEN);
  return self;
}

export function participantsOf(row, self, cc) {
  if (row.kind === 'sms') {
    const a = normAddr(row.address, cc);
    return a ? [a] : ['(unknown)'];
  }
  const addrs = row.addrs ? JSON.parse(row.addrs) : [];
  let list = addrs.map((x) => normAddr(x.address, cc)).filter((a) => a && !self.has(a));
  if (!list.length && row.address) {
    list = String(row.address).split('~').map((a) => normAddr(a, cc)).filter((a) => a && !self.has(a));
  }
  if (!list.length) list = ['(me)'];
  return [...new Set(list)].sort();
}

export function senderOf(row, self, cc) {
  if (row.box !== 1) return null;
  if (row.kind === 'sms') return normAddr(row.address, cc) || null;
  const addrs = row.addrs ? JSON.parse(row.addrs) : [];
  const from = addrs.find((x) => String(x.type) === '137');
  const a = from ? normAddr(from.address, cc) : '';
  return a && !self.has(a) ? a : null;
}

export function formatNumber(a) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(a);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : a;
}

export function displayName(db, address) {
  const c = db.prepare('SELECT name FROM contacts WHERE address = ?').get(address);
  return c?.name || formatNumber(address);
}

// Recompute conversation membership for every message. Conversation ids are stable per
// participant set, so links keep working when self numbers are learned later.
export function rethread(db, cfg) {
  const self = learnSelf(db, cfg);
  const cc = cfg.countryCode;
  const names = new Map(db.prepare('SELECT address, name FROM contacts').all().map((r) => [r.address, r.name]));
  const convByKey = new Map(db.prepare('SELECT id, key FROM conversations').all().map((r) => [r.key, r.id]));
  const insConv = db.prepare('INSERT INTO conversations (key, participants, is_group, title) VALUES (?, ?, ?, ?)');
  const updConvMeta = db.prepare('UPDATE conversations SET participants = ?, is_group = ?, title = ? WHERE id = ?');
  const updMsg = db.prepare('UPDATE messages SET conversation_id = ?, sender = ? WHERE id = ?');
  const seen = new Set();
  const title = (parts) => parts.map((a) => names.get(a) || formatNumber(a)).join(', ');
  db.transaction(() => {
    const rows = db.prepare('SELECT id, kind, box, address, addrs, conversation_id, sender FROM messages').all();
    for (const r of rows) {
      const parts = participantsOf(r, self, cc);
      const key = parts.join(',');
      let cid = convByKey.get(key);
      if (!cid) {
        cid = Number(insConv.run(key, JSON.stringify(parts), parts.length > 1 ? 1 : 0, title(parts)).lastInsertRowid);
        convByKey.set(key, cid);
      }
      if (!seen.has(cid)) { updConvMeta.run(JSON.stringify(parts), parts.length > 1 ? 1 : 0, title(parts), cid); seen.add(cid); }
      const sender = senderOf(r, self, cc);
      if (r.conversation_id !== cid || r.sender !== sender) updMsg.run(cid, sender, r.id);
    }
    db.exec(`
      UPDATE conversations SET
        message_count = (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = conversations.id),
        media_count = (SELECT COALESCE(SUM(media_count),0) FROM messages m WHERE m.conversation_id = conversations.id),
        media_bytes = (SELECT COALESCE(SUM(p.media_size),0) FROM parts p JOIN messages m ON m.id = p.message_id WHERE m.conversation_id = conversations.id),
        first_date = (SELECT MIN(date) FROM messages m WHERE m.conversation_id = conversations.id),
        last_date = (SELECT MAX(date) FROM messages m WHERE m.conversation_id = conversations.id);
      UPDATE conversations SET last_snippet = (
        SELECT CASE WHEN m.body IS NOT NULL AND m.body <> '' THEN substr(m.body, 1, 120)
                    WHEN m.media_count > 0 THEN '[media]' ELSE '' END
        FROM messages m WHERE m.conversation_id = conversations.id ORDER BY m.date DESC, m.id DESC LIMIT 1);
      DELETE FROM conversations WHERE message_count = 0;
    `);
  })();
}
