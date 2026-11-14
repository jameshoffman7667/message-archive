import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import { setup } from './helpers.js';
import { importFile, scanInbox } from '../src/importer.js';
import { mediaPath, sha256, verifyAllMedia } from '../src/media.js';
import { buildDemo, demoXml, scene } from '../scripts/make-demo.js';

const NOW = Date.UTC(2026, 10, 13, 12);
const write = (dir, name, xml) => { const p = path.join(dir, name); fs.writeFileSync(p, xml); return p; };
const count = (db, sql, ...a) => db.prepare(sql).get(...a).n;

test('full import: every record verified, media stored by checksum, threads built', async () => {
  const { db, dirs, ctx } = setup();
  const items = buildDemo({ now: NOW, small: true });
  const f = write(dirs.inbox, 'sms-1.xml', demoXml({ now: NOW, items }));
  const r = await importFile(ctx, f);
  assert.equal(r.status, 'verified', r.message);
  assert.equal(r.parsed, items.length);
  assert.equal(r.count_attr, items.length);
  assert.equal(r.new_messages, items.length);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM messages'), items.length);
  assert.equal(r.media_missing, 1, 'the restricted message has no data');
  assert.equal(count(db, 'SELECT COUNT(*) n FROM parts WHERE missing = 1'), 1);
  // every stored file has the content its name says
  for (const m of db.prepare('SELECT sha256, size FROM media').all()) {
    const buf = fs.readFileSync(mediaPath(dirs.files, m.sha256));
    assert.equal(sha256(buf), m.sha256);
    assert.equal(buf.length, m.size);
  }
  // own number learned from sent MMS; group chat has three others; RCS group resolved from <addr>
  assert.deepEqual(db.prepare('SELECT address FROM self_addresses').all().map((x) => x.address), ['+16135550100']);
  const convs = db.prepare('SELECT participants, is_group, title FROM conversations').all();
  assert.ok(convs.some((c) => c.is_group && JSON.parse(c.participants).length === 3));
  assert.ok(convs.every((c) => !JSON.parse(c.participants).includes('+16135550100')), 'self never appears as a participant');
  assert.ok(convs.some((c) => c.title === 'Alex Martin'), 'contact names come from contact_name');
  assert.ok(!convs.some((c) => c.title.includes('rcs.google.com')));
});

test('re-import and incremental files only add what is new', async () => {
  const { db, dirs, ctx } = setup();
  const items = buildDemo({ now: NOW, small: true });
  const half = items.slice(0, Math.floor(items.length / 2));
  const a = await importFile(ctx, write(dirs.inbox, 'sms-a.xml', demoXml({ now: NOW, items: half })));
  assert.equal(a.new_messages, half.length);
  const again = await importFile(ctx, write(dirs.inbox, 'sms-a-copy.xml', demoXml({ now: NOW, items: half })));
  assert.equal(again.status, 'skipped', 'identical file content is recognised');
  const full = await importFile(ctx, write(dirs.inbox, 'sms-b.xml', demoXml({ now: NOW + 1, items })));
  assert.equal(full.status, 'verified', full.message);
  assert.equal(full.new_messages, items.length - half.length);
  assert.equal(full.existing_messages, half.length);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM messages'), items.length);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM message_sources WHERE import_id = ?', full.id), items.length);
});

test('a later backup with media fills in a message first seen without it', async () => {
  const { db, dirs, ctx } = setup();
  const pic = scene(3, 64, 48);
  const from = { name: 'Sam Tremblay', num: '+16135550122' };
  const without = [{ kind: 'mms-restricted', date: NOW - 1000, from, parts: [{ ct: 'image/jpeg', cl: 'encrypted.jpg', data: null }] }];
  const r1 = await importFile(ctx, write(dirs.inbox, 'sms-1.xml', demoXml({ now: NOW, items: without })));
  assert.equal(r1.media_missing, 1);
  const withData = [{ ...without[0], parts: [{ ct: 'image/jpeg', cl: 'encrypted.jpg', data: pic }] }];
  const r2 = await importFile(ctx, write(dirs.inbox, 'sms-2.xml', demoXml({ now: NOW, items: withData })));
  assert.equal(r2.status, 'verified', r2.message);
  assert.equal(r2.new_messages, 0);
  assert.equal(r2.upgraded_messages, 1);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM parts WHERE missing = 1'), 0);
  assert.equal(db.prepare('SELECT media_sha256 FROM parts WHERE ct = ?').get('image/jpeg').media_sha256, sha256(pic));
  assert.equal(db.prepare('SELECT media_missing FROM messages').get().media_missing, 0);
});

test('identical twin messages in one backup are counted as copies', async () => {
  const { db, dirs, ctx } = setup();
  const sms = { kind: 'sms', a: { address: '6135550111', date: NOW - 5000, type: 1, body: 'ok', read: 1 } };
  const r = await importFile(ctx, write(dirs.inbox, 'sms-1.xml', demoXml({ now: NOW, items: [sms, sms, sms] })));
  assert.equal(r.status, 'verified', r.message);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM messages'), 1);
  assert.equal(db.prepare('SELECT copies FROM messages').get().copies, 3);
});

test('a file whose count disagrees with its content fails verification', async () => {
  const { dirs, ctx } = setup();
  const items = buildDemo({ now: NOW, small: true }).slice(0, 5);
  const r = await importFile(ctx, write(dirs.inbox, 'sms-bad.xml', demoXml({ now: NOW, items, count: 9 })));
  assert.equal(r.status, 'failed');
  assert.match(r.message, /file says 9 records, parsed 5/);
});

test('a truncated file fails instead of passing silently', async () => {
  const { dirs, ctx } = setup();
  const xml = demoXml({ now: NOW, items: buildDemo({ now: NOW, small: true }) });
  const r = await importFile(ctx, write(dirs.inbox, 'sms-cut.xml', xml.slice(0, Math.floor(xml.length * 0.6))));
  assert.equal(r.status, 'failed');
});

test('zip backups import; password-protected zips are refused with advice; call logs are skipped', async () => {
  const { dirs, ctx } = setup();
  const xml = demoXml({ now: NOW, items: buildDemo({ now: NOW, small: true }) });
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(xml), 'sms-20261113.xml');
  zip.end();
  const zp = path.join(dirs.inbox, 'sms-20261113.xml.zip');
  await new Promise((res) => zip.outputStream.pipe(fs.createWriteStream(zp)).on('close', res));
  const r = await importFile(ctx, zp);
  assert.equal(r.status, 'verified', r.message);

  const enc = fs.readFileSync(zp);
  // set the "encrypted" flag in the local header and central directory entry
  enc.writeUInt16LE(enc.readUInt16LE(6) | 1, 6);
  const cd = enc.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  enc.writeUInt16LE(enc.readUInt16LE(cd + 8) | 1, cd + 8);
  const ep = path.join(dirs.inbox, 'sms-enc.xml.zip');
  fs.writeFileSync(ep, enc);
  const r2 = await importFile(ctx, ep);
  assert.equal(r2.status, 'failed');
  assert.match(r2.message, /password-protected/);

  const calls = await importFile(ctx, write(dirs.inbox, 'other.xml', '<?xml version="1.0"?><calls count="1"><call number="1" duration="2" date="3" type="1" presentation="1"/></calls>'));
  assert.equal(calls.status, 'skipped');
});

test('old-style emoji entities and control characters do not break an import', async () => {
  const { db, dirs, ctx } = setup();
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<smses count="2">`
    + `<sms address="6135550111" date="1700000000000" type="1" body="hi &#55357;&#56832;" read="1" />`
    + `<sms address="6135550111" date="1700000001000" type="2" body="bell&#7;" read="1" />\n</smses>`;
  const r = await importFile(ctx, write(dirs.inbox, 'sms-emoji.xml', xml));
  assert.equal(r.status, 'verified', r.message);
  assert.deepEqual(db.prepare('SELECT body FROM messages ORDER BY date').all().map((x) => x.body), ['hi 😀', 'bell�']);
});

test('inbox scan imports new files once and skips unchanged ones', async () => {
  const { dirs, ctx } = setup();
  fs.mkdirSync(path.join(dirs.inbox, 'SMSBackupRestore'));
  write(path.join(dirs.inbox, 'SMSBackupRestore'), 'sms-1.xml', demoXml({ now: NOW, items: buildDemo({ now: NOW, small: true }) }));
  write(dirs.inbox, 'calls-1.xml', '<calls count="0"></calls>');
  const first = await scanInbox(ctx);
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'verified');
  assert.equal((await scanInbox(ctx)).length, 0);
});

test('media verification finds a damaged file', async () => {
  const { db, dirs, ctx } = setup();
  await importFile(ctx, write(dirs.inbox, 'sms-1.xml', demoXml({ now: NOW, items: buildDemo({ now: NOW, small: true }) })));
  const clean = await verifyAllMedia(db, dirs.files);
  assert.equal(clean.ok, clean.total);
  const one = db.prepare('SELECT sha256 FROM media LIMIT 1').get().sha256;
  fs.appendFileSync(mediaPath(dirs.files, one), 'x');
  const bad = await verifyAllMedia(db, dirs.files);
  assert.equal(bad.mismatched, 1);
  assert.deepEqual(bad.bad, [one]);
});

test('search index covers new messages, case- and accent-insensitive', async () => {
  const { db, dirs, ctx } = setup();
  await importFile(ctx, write(dirs.inbox, 'sms-1.xml', demoXml({ now: NOW, items: buildDemo({ now: NOW }) })));
  const hits = db.prepare("SELECT COUNT(*) n FROM messages_fts WHERE messages_fts MATCH 'cafe'").get().n;
  assert.ok(hits > 0);
});
