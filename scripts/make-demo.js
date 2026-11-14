// Writes a demo backup in SMS Backup & Restore XML format, with invented people and
// generated pictures. Used by the tests and for the screenshots; never real data.
// Usage: node scripts/make-demo.js <out.xml> [--now=<ms>] [--small]
import fs from 'node:fs';
import zlib from 'node:zlib';

// --- tiny PNG encoder (RGB) --------------------------------------------------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const [r, g, b] = pixel(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// Simple "landscape" pictures: sky gradient, sun, hills.
export function scene(seed, w = 480, h = 360) {
  const sky = [[255, 183, 120], [120, 180, 240], [170, 140, 230], [250, 210, 140]][seed % 4];
  const hill = [[70, 140, 90], [60, 110, 150], [120, 150, 70], [90, 80, 130]][seed % 4];
  const sx = 120 + (seed * 97) % 260, sy = 90 + (seed * 31) % 60;
  return png(w, h, (x, y) => {
    const t = y / h;
    if ((x - sx) ** 2 + (y - sy) ** 2 < 900) return [255, 240, 200];
    const ridge = h * 0.62 + Math.sin((x + seed * 40) / 55) * 22 + Math.sin(x / 23) * 8;
    if (y > ridge) { const d = (y - ridge) / h; return hill.map((c) => Math.max(0, c - d * 120)); }
    return sky.map((c) => Math.min(255, c + t * 50));
  });
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
const attrs = (o) => Object.entries(o).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');

export const ME = '+16135550100';
export const PEOPLE = [
  { name: 'Alex Martin', num: '+16135550111' },
  { name: 'Sam Tremblay', num: '6135550122' },
  { name: 'Jordan Lee', num: '+1 (613) 555-0133' },
  { name: 'Chris Gagnon', num: '+16135550144' },
  { name: 'Taylor Roy', num: '+16135550155' },
];

const LINES = [
  ['Are you coming for dinner Sunday?', 'Yes! What should I bring?', 'Maybe a salad, we have lots of dessert', 'Perfect, see you at 5'],
  ['Did the package arrive?', 'Just got it, thanks', 'Great, let me know if it fits'],
  ['On se voit au café demain matin?', 'Oui, vers 9h ça te va?', 'Parfait, à demain!'],
  ['Look at this view from the trail', 'Wow, where is that?', 'Gatineau Park, near the lookout'],
  ['Running 10 minutes late, sorry', 'No problem, we just sat down'],
  ['Happy birthday!! 🎉', 'Thank you so much 😊', 'Hope you have a great day'],
  ['Can you send me the recipe?', 'Sure, I will take a picture of the card', 'Thanks!'],
];

export function buildDemo({ now = Date.now(), small = false } = {}) {
  const items = [];
  const DAY = 86400_000;
  const span = small ? 800 : 1300; // days of history
  let seq = 0;
  const push = (o) => items.push(o);
  const people = small ? PEOPLE.slice(0, 3) : PEOPLE;
  people.forEach((p, pi) => {
    const rounds = small ? 4 : 14;
    for (let r = 0; r < rounds; r++) {
      const base = now - Math.floor(((rounds - r) / rounds) * span * DAY) + pi * 3600_000;
      const lines = LINES[(pi + r) % LINES.length];
      lines.forEach((text, li) => {
        const sent = (li + pi) % 2 === 1;
        const date = base + li * 240_000 + 1000 * (++seq % 7);
        push({ kind: 'sms', a: { protocol: 0, address: p.num, date, type: sent ? 2 : 1, subject: 'null', body: text, toa: 'null', sc_toa: 'null', service_center: 'null', read: 1, status: -1, locked: 0, date_sent: sent ? 0 : date - 2000, sub_id: 1, readable_date: new Date(date).toString(), contact_name: p.name } });
      });
      if (r % 3 === 1) {
        const date = base + 30 * 60_000;
        const sent = r % 2 === 0;
        const img = scene(pi * 7 + r);
        push({ kind: 'mms', date, sent, p, parts: [{ ct: 'image/png', cl: `IMG_${2023 + (r % 3)}${String(r).padStart(4, '0')}.png`, data: img }, { ct: 'text/plain', text: r % 2 ? 'Look at this!' : '' }] });
      }
    }
  });
  // A group chat (MMS) with three other people.
  const group = people.slice(0, 3);
  for (let r = 0; r < (small ? 3 : 8); r++) {
    const date = now - (span - r * 60) * DAY + 5 * 3600_000;
    const from = r % 4 === 3 ? null : group[r % 3];
    push({ kind: 'mms-group', date, from, group, parts: [{ ct: 'text/plain', text: ['Who is in for the cottage weekend?', 'Me!', 'Count me in', 'I can drive', 'Bring the board games'][r % 5] }, ...(r === 2 ? [{ ct: 'image/png', cl: 'cottage.png', data: scene(40 + r) }] : [])] });
  }
  // An RCS group chat stored without real numbers, plus a restricted (encrypted) message without data.
  const rcsDate = now - 40 * DAY;
  push({ kind: 'mms-rcs', date: rcsDate, from: people[1], group: people.slice(0, 2), parts: [{ ct: 'text/plain', text: 'RCS group: photos from Saturday' }, { ct: 'image/png', cl: 'saturday.png', data: scene(77) }] });
  push({ kind: 'mms-restricted', date: rcsDate + 60_000, from: people[1], parts: [{ ct: 'image/jpeg', cl: 'encrypted.jpg', data: null }] });
  // Short codes / business senders.
  push({ kind: 'sms', a: { protocol: 0, address: '72345', date: now - 3 * DAY, type: 1, body: 'Your verification code is 482913', read: 1, status: -1, locked: 0, date_sent: now - 3 * DAY, sub_id: 1, contact_name: '(Unknown)' } });
  items.sort((x, y) => (x.a?.date ?? x.date) - (y.a?.date ?? y.date));
  return items;
}

function mmsXml(it) {
  let addrs, a, box;
  if (it.kind === 'mms') {
    box = it.sent ? 2 : 1;
    addrs = it.sent ? [{ address: ME, type: 137 }, { address: it.p.num, type: 151 }] : [{ address: it.p.num, type: 137 }, { address: ME, type: 151 }];
    a = { address: it.p.num, contact_name: it.p.name };
  } else if (it.kind === 'mms-group' || it.kind === 'mms-rcs') {
    box = it.from ? 1 : 2;
    const others = it.group.map((g) => g.num);
    addrs = it.from ? [{ address: it.from.num, type: 137 }, ...others.filter((n) => n !== it.from.num).map((n) => ({ address: n, type: 151 })), { address: ME, type: 151 }]
      : [{ address: 'insert-address-token', type: 137 }, ...others.map((n) => ({ address: n, type: 151 }))];
    a = { address: it.kind === 'mms-rcs' ? '7f3c2a9e1b@rcs.google.com' : others.join('~'), contact_name: it.group.map((g) => g.name).join(', ') };
  } else {
    box = 1;
    addrs = [{ address: it.from.num, type: 137 }, { address: ME, type: 151 }];
    a = { address: it.from.num, contact_name: it.from.name, restricted: 1 };
  }
  const head = {
    date: it.date, rr: 'null', sub: 'null', ct_t: 'application/vnd.wap.multipart.related', read_status: 'null', seen: 1, msg_box: box, ...a,
    sub_cs: 'null', resp_st: 'null', retr_st: 'null', d_tm: 'null', text_only: it.parts.some((p) => p.ct !== 'text/plain') ? 0 : 1, exp: 'null', locked: 0,
    m_id: it.kind === 'mms-rcs' || it.kind === 'mms-restricted' ? 'null' : `mid${it.date}`, st: 'null', retr_txt_cs: 'null', retr_txt: 'null', creator: 'com.google.android.apps.messaging',
    date_sent: Math.floor(it.date / 1000), read: 1, m_size: 'null', rpt_a: 'null', ct_cls: 'null', pri: 'null', sub_id: 1,
    tr_id: it.kind === 'mms-rcs' || it.kind === 'mms-restricted' ? `proto:rcs${it.date}` : `tr${it.date}`, resp_txt: 'null', ct_l: 'null', m_cls: 'personal', d_rpt: 'null', v: 18, m_type: box === 2 ? 128 : 132,
    readable_date: new Date(it.date).toString(),
  };
  const parts = [{ seq: -1, ct: 'application/smil', name: 'null', chset: 'null', cd: 'null', fn: 'null', cid: '<smil>', cl: 'smil.xml', ctt_s: 'null', ctt_t: 'null', text: '<smil><body><par dur="5000ms"/></body></smil>' },
    ...it.parts.filter((p) => p.ct !== 'text/plain' || p.text).map((p, i) => ({
      seq: 0, ct: p.ct, name: 'null', chset: p.ct === 'text/plain' ? 106 : 'null', cd: 'null', fn: 'null', cid: `<${i}>`, cl: p.cl || `text.${i}.txt`, ctt_s: 'null', ctt_t: 'null',
      ...(p.ct === 'text/plain' ? { text: p.text } : p.data ? { text: 'null', data: p.data.toString('base64') } : { text: 'null' }),
    }))];
  return `  <mms ${attrs(head)}>\n    <parts>\n${parts.map((p) => `      <part ${attrs(p)} />`).join('\n')}\n    </parts>\n    <addrs>\n${addrs.map((x) => `      <addr ${attrs({ ...x, charset: 106 })} />`).join('\n')}\n    </addrs>\n  </mms>`;
}

export function demoXml(opts = {}) {
  const items = opts.items || buildDemo(opts);
  const now = opts.now || Date.now();
  const body = items.map((it) => (it.kind === 'sms' ? `  <sms ${attrs(it.a)} />` : mmsXml(it))).join('\n');
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<!--File Created By SMS Backup & Restore v10.29.002 on ${new Date(now).toString()}-->\n`
    + `<smses count="${opts.count ?? items.length}" backup_set="${opts.backupSet || '9c1f6a3e-demo'}" backup_date="${now}" type="full">\n${body}\n</smses>\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2];
  if (!out) { console.error('usage: node scripts/make-demo.js <out.xml> [--now=ms] [--small]'); process.exit(1); }
  const now = Number((process.argv.find((a) => a.startsWith('--now=')) || '').slice(6)) || Date.now();
  fs.writeFileSync(out, demoXml({ now, small: process.argv.includes('--small') }));
  console.log(`wrote ${out}`);
}
