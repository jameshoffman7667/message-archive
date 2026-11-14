import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normAddr, smsFingerprint, mmsFingerprint } from '../src/fingerprint.js';
import { fixEntities, isBackupName } from '../src/importer.js';
import { snippet } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword, verifyPassword, passwordProblem } from '../src/auth.js';
import { tmpDirs } from './helpers.js';

test('normAddr normalizes NANP numbers, emails, short codes and sender ids', () => {
  assert.equal(normAddr('6135550122'), '+16135550122');
  assert.equal(normAddr('1-613-555-0122'), '+16135550122');
  assert.equal(normAddr('+1 (613) 555-0122'), '+16135550122');
  assert.equal(normAddr('+33 1 23 45 67 89'), '+33123456789');
  assert.equal(normAddr('0033123456789'), '+33123456789');
  assert.equal(normAddr('72345'), '72345');
  assert.equal(normAddr('Abc@RCS.Google.com'), 'abc@rcs.google.com');
  assert.equal(normAddr('TD-Bank'), 'td-bank');
  assert.equal(normAddr('insert-address-token'), 'insert-address-token');
  assert.equal(normAddr('null'), '');
  assert.equal(normAddr(undefined), '');
});

// Locked test vectors: Phase 2's phone app must produce exactly these values.
test('fingerprints are stable (test vectors for the phone app)', () => {
  const sms = smsFingerprint({ date: '1700000000000', type: '1', address: '(613) 555-0122', body: 'Hello 👋' });
  assert.equal(sms, smsFingerprint({ date: 1700000000000, type: 1, address: '+16135550122', body: 'Hello 👋' }));
  assert.equal(sms, '871d597122b556dc6a9e843903c9b098a175f0e9657728956d87ffa0af0c0f58');
  const addrs = [{ address: '+16135550100', type: '137' }, { address: '6135550122', type: '151' }];
  const withIds = mmsFingerprint({ date: '1700000000000', msg_box: '2', m_id: 'abc', tr_id: 'proto:x' }, addrs, 'hi');
  assert.equal(withIds, '262ae70d4d16fa5a33021794aa64876d06b48ef17df76d3296c54770ac3c8efc');
  // text does not matter when ids exist (restricted backups may lack the text)
  assert.equal(withIds, mmsFingerprint({ date: '1700000000000', msg_box: '2', m_id: 'abc', tr_id: 'proto:x' }, [...addrs].reverse(), ''));
  const noIds = mmsFingerprint({ date: '1700000000000', msg_box: '2', m_id: 'null', tr_id: 'null' }, addrs, 'hi');
  assert.notEqual(noIds, mmsFingerprint({ date: '1700000000000', msg_box: '2' }, addrs, 'other text'));
  assert.notEqual(withIds, noIds);
});

test('fixEntities joins surrogate pairs and replaces forbidden characters', () => {
  assert.equal(fixEntities('a &#55357;&#56832; b'), 'a 😀 b');
  assert.equal(fixEntities('x&#55357;y'), 'x�y');
  assert.equal(fixEntities('bell &#7; ok &#233;'), 'bell � ok &#233;');
  assert.equal(fixEntities('&#x1F600;'), '&#x1F600;');
  assert.equal(fixEntities('plain'), 'plain');
});

test('isBackupName accepts message backups only', () => {
  assert.ok(isBackupName('sms-20261113010203.xml'));
  assert.ok(isBackupName('sms-20261113010203.xml.zip'));
  assert.ok(!isBackupName('calls-20261113010203.xml'));
  assert.ok(!isBackupName('.upload-abc-sms.xml'));
  assert.ok(!isBackupName('notes.txt'));
});

test('snippet highlights matches ignoring case and accents', () => {
  const segs = snippet('On se voit au Café demain?', ['cafe']);
  assert.deepEqual(segs.filter((s) => s.h).map((s) => s.t), ['Café']);
  const long = 'x '.repeat(200) + 'needle here';
  const s2 = snippet(long, ['needle']);
  assert.equal(s2[0].t, '…');
  assert.ok(s2.some((s) => s.h && s.t === 'needle'));
  assert.deepEqual(snippet('', ['a']), []);
});

test('config fails fast with clear messages', () => {
  const d = tmpDirs();
  assert.throws(() => loadConfig({ DATA_DIR: '/nonexistent-ma', FILES_DIR: d.files, INBOX_DIR: d.inbox }), /DATA_DIR .* does not exist/);
  assert.throws(() => loadConfig({ DATA_DIR: d.data, FILES_DIR: d.files, INBOX_DIR: '/nonexistent-inbox' }), /INBOX_DIR/);
  assert.throws(() => loadConfig({ DATA_DIR: d.data, FILES_DIR: d.files, INBOX_DIR: d.inbox, PORT: 'abc' }), /PORT must be an integer/);
  assert.throws(() => loadConfig({ DATA_DIR: d.data, FILES_DIR: d.files, INBOX_DIR: d.inbox, COOKIE_SECURE: 'maybe' }), /COOKIE_SECURE/);
  assert.throws(() => loadConfig({ DATA_DIR: d.data, FILES_DIR: d.files, INBOX_DIR: d.inbox, LOG_LEVEL: 'loud' }), /LOG_LEVEL/);
  const ok = loadConfig({ DATA_DIR: d.data, FILES_DIR: d.files, INBOX_DIR: d.inbox });
  assert.equal(ok.port, 8080);
  assert.equal(ok.cutoffDays, 730);
  assert.equal(ok.cookieSecure, false);
});

test('passwords are scrypt-hashed and checked', () => {
  const h = hashPassword('correct horse battery');
  assert.match(h, /^scrypt\$/);
  assert.ok(verifyPassword('correct horse battery', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(passwordProblem('short'));
  assert.equal(passwordProblem('long enough pw'), null);
});
