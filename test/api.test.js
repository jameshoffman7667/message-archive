import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, waitIdle } from './helpers.js';
import { importFile } from '../src/importer.js';
import { buildDemo, demoXml } from '../scripts/make-demo.js';
import { APP_VERSION } from '../src/config.js';

const NOW = Date.UTC(2026, 10, 13, 12);
const PW = 'test-password-1234';

async function withDemo(t) {
  const a = await startApp();
  t.after(() => a.close());
  const f = path.join(a.dirs.inbox, 'sms-1.xml');
  fs.writeFileSync(f, demoXml({ now: NOW, items: buildDemo({ now: NOW }) }));
  await importFile(a.ctx, f);
  return a;
}

test('/healthz returns exactly status and version, no login, no cookie', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  const r = await a.req('/healthz', { auth: false });
  assert.equal(r.status, 200);
  assert.equal(r.text, JSON.stringify({ status: 'ok', version: APP_VERSION }));
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version, r.json.version);
});

test('first run, sign-in, rate limit, sessions and CSRF', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  assert.deepEqual((await a.req('/api/auth/state')).json, { setup: false, signedIn: false, version: APP_VERSION });
  assert.equal((await a.req('/api/conversations')).status, 401);
  assert.equal((await a.req('/api/auth/setup', { method: 'POST', body: { password: 'short' } })).status, 400);
  const s = await a.req('/api/auth/setup', { method: 'POST', body: { password: PW } });
  assert.equal(s.status, 200);
  assert.match(s.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await a.req('/api/auth/setup', { method: 'POST', body: { password: PW } })).status, 409, 'setup only once');
  assert.equal((await a.req('/api/conversations')).status, 200);
  // CSRF: writes need the header and a same-origin Origin
  assert.equal((await a.req('/api/imports/scan', { method: 'POST', headers: { 'x-requested-with': '' } })).status, 403);
  assert.equal((await a.req('/api/imports/scan', { method: 'POST', headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await a.req('/api/imports/scan', { method: 'POST' })).status, 200);
  await waitIdle(a.app);
  // sign out, wrong password, lockout
  await a.req('/api/auth/logout', { method: 'POST' });
  a.setCookie('');
  assert.equal((await a.req('/api/conversations')).status, 401);
  for (let i = 0; i < 8; i++) assert.equal((await a.req('/api/auth/login', { method: 'POST', body: { password: 'nope-nope-nope' } })).status, 401);
  assert.equal((await a.req('/api/auth/login', { method: 'POST', body: { password: PW } })).status, 429);
  assert.ok(a.lines.some((l) => l.includes('sign-in failed')));
  assert.ok(!a.lines.some((l) => l.includes(PW)), 'passwords never logged');
});

test('password change signs out other sessions', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  await a.req('/api/auth/setup', { method: 'POST', body: { password: PW } });
  const old = a.getCookie();
  assert.equal((await a.req('/api/auth/password', { method: 'POST', body: { current: 'wrong-wrong-wrong', next: 'new-password-123' } })).status, 401);
  assert.equal((await a.req('/api/auth/password', { method: 'POST', body: { current: PW, next: 'new-password-123' } })).status, 200);
  const fresh = a.getCookie();
  assert.notEqual(fresh, old);
  a.setCookie(old);
  assert.equal((await a.req('/api/conversations')).status, 401);
  a.setCookie(fresh);
  assert.equal((await a.req('/api/conversations')).status, 200);
});

test('conversations, paging, search and media', async (t) => {
  const a = await withDemo(t);
  await a.req('/api/auth/setup', { method: 'POST', body: { password: PW } });
  const list = (await a.req('/api/conversations')).json;
  assert.ok(list.total >= 7);
  const sorted = list.conversations.map((c) => c.last_date);
  assert.deepEqual(sorted, [...sorted].sort((x, y) => y - x), 'newest first');
  const alex = list.conversations.find((c) => c.title === 'Alex Martin');
  assert.ok((await a.req('/api/conversations?q=555-0111')).json.conversations.some((c) => c.id === alex.id), 'filter by number');

  const page1 = (await a.req(`/api/conversations/${alex.id}/messages?limit=10`)).json;
  assert.equal(page1.messages.length, 10);
  assert.ok(page1.hasOlder);
  const first = page1.messages[0];
  const page2 = (await a.req(`/api/conversations/${alex.id}/messages?limit=10&beforeDate=${first.date}&beforeId=${first.id}`)).json;
  assert.ok(page2.messages.every((m) => m.date <= first.date));
  assert.ok(!page2.messages.some((m) => page1.messages.some((x) => x.id === m.id)), 'no overlap between pages');
  const around = (await a.req(`/api/conversations/${alex.id}/messages?limit=10&around=${first.id}`)).json;
  assert.equal(around.anchor, first.id);
  assert.ok(around.messages.some((m) => m.id === first.id));

  const s = (await a.req('/api/search?q=CAFE')).json;
  assert.ok(s.total > 0);
  assert.ok(s.results[0].snippet.some((x) => x.h && /café/i.test(x.t)));
  const scoped = (await a.req(`/api/search?q=dinner&conversation=${alex.id}`)).json;
  assert.ok(scoped.results.every((r) => r.conversationId === alex.id));
  assert.equal((await a.req('/api/search?q=%22%29%28*')).status, 200, 'odd input never breaks the query');
  const ranged = (await a.req(`/api/search?from=${NOW - 86400_000 * 5}&to=${NOW}`)).json;
  assert.ok(ranged.results.every((r) => r.date >= NOW - 86400_000 * 5 && r.date < NOW));
  const withMedia = (await a.req('/api/search?media=1')).json;
  assert.ok(withMedia.total > 0 && withMedia.results.every((r) => r.mediaCount > 0));

  const mm = page1.messages.concat(page2.messages).find((m) => m.parts.some((p) => p.sha)) || (await a.req(`/api/search?media=1&conversation=${alex.id}`)).json.results[0];
  const msgs = (await a.req(`/api/conversations/${alex.id}/messages?limit=500`)).json.messages;
  const part = msgs.flatMap((m) => m.parts).find((p) => p.sha);
  assert.ok(mm && part);
  const img = await a.req(`/api/media/${part.sha}`, { raw: true });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('content-security-policy'), /sandbox/);
  const range = await a.req(`/api/media/${part.sha}`, { raw: true, headers: { range: 'bytes=0-9' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 10);
  assert.equal((await a.req('/api/media/zz')).status, 400);
  assert.equal((await a.req(`/api/media/${'0'.repeat(64)}`)).status, 404);
  a.setCookie('');
  assert.equal((await a.req(`/api/media/${part.sha}`)).status, 401, 'media needs a session');
});

test('stats and cutoff preview', async (t) => {
  const a = await withDemo(t);
  await a.req('/api/auth/setup', { method: 'POST', body: { password: PW } });
  const s = (await a.req('/api/stats')).json;
  assert.ok(s.totals.messages > 200);
  assert.ok(s.byYear.length >= 3);
  assert.ok(s.cutoff.messages > 0 && s.cutoff.messages < s.totals.messages);
  assert.equal(s.cutoff.days, 730);
});

test('SPA routes serve the shell with a strict CSP; unknown paths 404', async (t) => {
  const a = await startApp();
  t.after(() => a.close());
  for (const p of ['/', '/c/12', '/search', '/imports', '/stats', '/settings']) {
    const r = await a.req(p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /<div id="app"/);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self';/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  }
  assert.equal((await a.req('/nope')).status, 404);
  assert.equal((await a.req('/api/nope')).status, 401);
});
