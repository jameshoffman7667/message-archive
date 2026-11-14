import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, waitIdle } from './helpers.js';
import { buildDemo, demoXml } from '../scripts/make-demo.js';

const NOW = Date.UTC(2026, 10, 13, 12);
const basic = (pw, user = 'archive') => 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');

async function davApp(t) {
  const a = await startApp();
  t.after(() => a.close());
  await a.req('/api/auth/setup', { method: 'POST', body: { password: 'test-password-1234' } });
  return a;
}

test('WebDAV is off until a password is set', async (t) => {
  const a = await davApp(t);
  const r = await a.req('/dav/', { method: 'PROPFIND', auth: false });
  assert.equal(r.status, 503);
  const g = await a.req('/api/settings/dav-password', { method: 'POST', body: { generate: true } });
  assert.equal(g.status, 200);
  assert.ok(g.json.password.length >= 16);
  assert.equal((await a.req('/dav/', { method: 'PROPFIND', auth: false })).status, 401);
  assert.equal((await a.req('/dav/', { method: 'PROPFIND', auth: false, headers: { authorization: basic('wrong-password') } })).status, 401);
  assert.equal((await a.req('/dav/', { method: 'PROPFIND', auth: false, headers: { authorization: basic(g.json.password, 'someone') } })).status, 401);
  const ok = await a.req('/dav/', { method: 'PROPFIND', auth: false, headers: { authorization: basic(g.json.password), depth: '1' } });
  assert.equal(ok.status, 207);
  assert.match(ok.text, /<d:multistatus xmlns:d="DAV:">/);
  assert.match(ok.headers.get('dav'), /1/);
  assert.equal((await a.req('/api/settings/dav-password', { method: 'POST', body: { disable: true } })).status, 200);
  assert.equal((await a.req('/dav/', { method: 'PROPFIND', auth: false, headers: { authorization: basic(g.json.password) } })).status, 503);
});

test('upload a backup over WebDAV: it is imported and verified right away', async (t) => {
  const a = await davApp(t);
  const { json } = await a.req('/api/settings/dav-password', { method: 'POST', body: { password: 'phone-upload-pw' } });
  assert.ok(json.enabled);
  const auth = { authorization: basic('phone-upload-pw') };
  assert.equal((await a.req('/dav/SMSBackupRestore', { method: 'MKCOL', auth: false, headers: auth })).status, 201);
  assert.equal((await a.req('/dav/SMSBackupRestore', { method: 'MKCOL', auth: false, headers: auth })).status, 405);
  const xml = demoXml({ now: NOW, items: buildDemo({ now: NOW, small: true }) });
  const put = await a.req('/dav/SMSBackupRestore/sms-20261113.xml', { method: 'PUT', auth: false, headers: { ...auth, 'content-type': 'application/xml' }, body: xml });
  assert.equal(put.status, 201);
  assert.ok(fs.existsSync(path.join(a.dirs.inbox, 'SMSBackupRestore', 'sms-20261113.xml')));
  assert.ok(!fs.readdirSync(path.join(a.dirs.inbox, 'SMSBackupRestore')).some((n) => n.startsWith('.upload-')), 'no temp file left');
  await waitIdle(a.app);
  const imp = (await a.req('/api/imports')).json.imports;
  assert.equal(imp[0].status, 'verified', imp[0].message);
  assert.equal(imp[0].source, 'dav');

  const list = await a.req('/dav/SMSBackupRestore/', { method: 'PROPFIND', auth: false, headers: { ...auth, depth: '1' } });
  assert.match(list.text, /sms-20261113\.xml/);
  assert.match(list.text, /<d:getcontentlength>\d+<\/d:getcontentlength>/);
  const got = await a.req('/dav/SMSBackupRestore/sms-20261113.xml', { auth: false, headers: auth });
  assert.equal(got.text, xml);
  // move, then delete (SMS Backup & Restore removes old backups this way)
  const mv = await a.req('/dav/SMSBackupRestore/sms-20261113.xml', { method: 'MOVE', auth: false, headers: { ...auth, destination: `${a.base}/dav/SMSBackupRestore/sms-old.xml` } });
  assert.equal(mv.status, 201);
  assert.equal((await a.req('/dav/SMSBackupRestore/sms-old.xml', { method: 'DELETE', auth: false, headers: auth })).status, 204);
  assert.equal((await a.req('/dav/SMSBackupRestore/sms-old.xml', { method: 'GET', auth: false, headers: auth })).status, 404);
  assert.equal((await a.req('/api/stats')).json.totals.messages > 0, true, 'the archive keeps the messages after the file is deleted');
});

test('WebDAV refuses paths outside the inbox and hidden files', async (t) => {
  const a = await davApp(t);
  await a.req('/api/settings/dav-password', { method: 'POST', body: { password: 'phone-upload-pw' } });
  const auth = { authorization: basic('phone-upload-pw') };
  for (const p of ['/dav/%2e%2e/escape.xml', '/dav/.hidden.xml', '/dav/a%2Fb.xml']) {
    const r = await a.req(p, { method: 'PUT', auth: false, headers: auth, body: 'x' });
    assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.ok(!fs.existsSync(path.join(a.dirs.root, 'escape.xml')));
  assert.equal((await a.req('/dav/missing/sms.xml', { method: 'PUT', auth: false, headers: auth, body: 'x' })).status, 409);
  const mv = await a.req('/dav/x.xml', { method: 'PUT', auth: false, headers: auth, body: '<smses count="0"></smses>' });
  assert.equal(mv.status, 201);
  assert.equal((await a.req('/dav/x.xml', { method: 'MOVE', auth: false, headers: { ...auth, destination: 'http://h/other/x.xml' } })).status, 502);
  await waitIdle(a.app);
});
