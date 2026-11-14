import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDirs } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const VERSION = JSON.parse(read('package.json')).version;

test('manifest is complete and every referenced file exists', () => {
  const m = JSON.parse(read('public/manifest.webmanifest'));
  for (const k of ['name', 'short_name', 'id', 'start_url', 'scope', 'display', 'background_color', 'theme_color', 'description']) assert.ok(m[k], k);
  assert.equal(m.display, 'standalone');
  assert.ok(!/^https?:/.test(m.start_url));
  const sizes = m.icons.map((i) => `${i.sizes}:${i.purpose}`);
  assert.ok(sizes.includes('192x192:any') && sizes.includes('512x512:any') && sizes.includes('512x512:maskable'));
  assert.ok(m.screenshots.some((s) => s.form_factor === 'wide') && m.screenshots.some((s) => s.form_factor === 'narrow'));
  for (const f of [...m.icons, ...m.screenshots]) assert.ok(fs.existsSync(path.join(ROOT, 'public', f.src)), f.src);
  assert.ok(fs.existsSync(path.join(ROOT, 'public/icons/apple-touch-icon.png')));
});

test('index.html has the PWA head tags and no inline script or style', () => {
  const html = read('public/index.html');
  assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest">/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1/);
  assert.match(html, /name="theme-color"/);
  assert.match(html, /rel="apple-touch-icon"/);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline script');
  assert.ok(!/<style|style="/.test(html), 'no inline style');
  assert.ok(!/innerHTML|insertAdjacentHTML|\.style\s*=\s*['"`]/.test(read('public/app.js')), 'no HTML parsing of text in the UI');
});

test('service worker: version matches, never caches API, WebDAV, media or health', () => {
  const sw = read('public/sw.js');
  assert.equal(/const VERSION = '([^']+)'/.exec(sw)[1], VERSION);
  assert.match(sw, /message-archive-v\$\{VERSION\}/);
  assert.match(sw, /startsWith\('\/api\/'\)/);
  assert.match(sw, /startsWith\('\/dav'\)/);
  assert.match(sw, /'\/healthz'/);
  assert.match(sw, /offline\.html/);
  assert.ok(!/skipWaiting\(\)(?![^\n]*SKIP_WAITING)/.test(sw.replace(/if \(event\.data === 'SKIP_WAITING'\) self\.skipWaiting\(\);/, '')), 'skipWaiting only on request');
  assert.match(read('public/app.js'), /if \(hadController\) location\.reload\(\)/, 'no reload on first install');
});

test('CHANGELOG has this version with short <= 50 and long <= 250 characters', () => {
  const log = read('CHANGELOG.md');
  const block = log.split(`## v${VERSION} `)[1];
  assert.ok(block, 'entry for this version');
  const short = /\*\*Short:\*\* (.+)/.exec(block)[1];
  const long = /\*\*Long:\*\* (.+)/.exec(block)[1];
  assert.ok(short.length > 0 && short.length <= 50, `short is ${short.length}`);
  assert.ok(long.length > 0 && long.length <= 250, `long is ${long.length}`);
});

test('Dockerfile and compose health checks follow PORT, require status ok, wait 30 s', () => {
  const df = read('Dockerfile');
  assert.ok(!df.startsWith('# syntax'), 'no syntax line');
  assert.match(df, /HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3/);
  assert.match(df, /http:\/\/127\.0\.0\.1:\$\{PORT\}\/healthz \| grep -q '"status":"ok"'/);
  assert.match(df, /ENTRYPOINT \["\/sbin\/tini", "--"\]/);
  assert.match(df, /USER 1000:100/);
  assert.ok(!/ARG .*(TOKEN|SECRET|PASS)/i.test(df));
  const compose = read('deploy/compose.yaml');
  assert.match(compose, new RegExp(`image: mybadreligon/message-archive:${VERSION.replace(/\./g, '\\.')}\\n`), 'compose pins this exact version');
  assert.ok(!/:latest/.test(compose) && !/^\s*build:/m.test(compose));
  assert.match(compose, /wget -qO- http:\/\/127\.0\.0\.1:\$\$\{PORT\}\/healthz \| grep -q '\\"status\\":\\"ok\\"'/);
  assert.match(compose, /start_period: 30s/);
  assert.match(compose, /PORT=\$\{PORT_HOST:\?assign from port register\}/);
  assert.match(compose, /"\$\{PORT_HOST\}:\$\{PORT_HOST\}"/);
  assert.match(compose, /create_host_path: false/);
  assert.match(compose, /max-size: 10m/);
});

test('release workflow keeps its triggers and safety checks', () => {
  const wf = read('.github/workflows/release.yml');
  assert.match(wf, /push:\n\s+branches: \[main\]\n\s+paths: \[package\.json, VERSION\]\n\s+tags: \["v\*\.\*\.\*"\]/);
  assert.match(wf, /permissions:\n\s+contents: write/);
  assert.match(wf, /group: release-\$\{\{ needs\.prepare\.outputs\.version \}\}/);
  assert.match(wf, /gh release create "v\$VERSION" --target "\$GITHUB_SHA"/);
  assert.match(wf, /CHANGELOG\.md has no entry/);
  assert.match(wf, /platforms: linux\/amd64/);
});

test('RELEASE.md has the Update field right after the heading and the right version', () => {
  const lines = read('deploy/RELEASE.md').split('\n');
  assert.equal(lines[0], `# Release v${VERSION}`);
  assert.match(lines[1], /^Update: (now|later)\b/);
  assert.match(read('deploy/RELEASE.md'), new RegExp(`Image: mybadreligon/message-archive:${VERSION.replace(/\./g, '\\.')}`));
});

test('the server stops cleanly on SIGTERM within 10 seconds', async () => {
  const d = tmpDirs();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(20000 + Math.floor(Math.random() * 20000)), DATA_DIR: d.data, FILES_DIR: d.files, INBOX_DIR: d.inbox, SCAN_INTERVAL_MINUTES: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 8000);
    child.stdout.on('data', () => { if (out.includes('listening')) { clearTimeout(t); resolve(); } });
  });
  const started = Date.now();
  child.kill('SIGTERM');
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 10_000);
  assert.match(out, /stopped cleanly/);
});

test('missing folders make the server exit with a clear message', async () => {
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR: '/nonexistent-ma-data', FILES_DIR: '/tmp', INBOX_DIR: '/tmp' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 1);
  assert.match(err, /FATAL: DATA_DIR \(\/nonexistent-ma-data\) does not exist/);
});
