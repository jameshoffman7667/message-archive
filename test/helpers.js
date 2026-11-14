import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, makeLogger } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

export function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-test-'));
  const dirs = { root, data: path.join(root, 'data'), files: path.join(root, 'files'), inbox: path.join(root, 'inbox') };
  for (const d of [dirs.data, dirs.files, dirs.inbox]) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

export function quietLog() {
  const lines = [];
  return { log: makeLogger('debug', (l) => lines.push(l)), lines };
}

export function setup(extraEnv = {}) {
  const dirs = tmpDirs();
  const cfg = loadConfig({ DATA_DIR: dirs.data, FILES_DIR: dirs.files, INBOX_DIR: dirs.inbox, SETTLE_SECONDS: '0', ...extraEnv });
  const { log, lines } = quietLog();
  const db = openDb(cfg.dataDir, log);
  return { dirs, cfg, log, lines, db, ctx: { db, cfg, log } };
}

export async function startApp(extraEnv = {}) {
  const s = setup(extraEnv);
  const app = createApp({ db: s.db, cfg: s.cfg, log: s.log });
  const server = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function req(p, { method = 'GET', body, headers = {}, raw = false, auth = true } = {}) {
    const h = { ...headers };
    if (auth && cookie) h.cookie = cookie;
    if (method !== 'GET' && method !== 'HEAD' && !('x-requested-with' in h) && p.startsWith('/api')) h['x-requested-with'] = 'fetch';
    if (body !== undefined && !(body instanceof Buffer) && typeof body !== 'string') { h['content-type'] = 'application/json'; body = JSON.stringify(body); }
    const res = await fetch(base + p, { method, headers: h, body });
    const sc = res.headers.get('set-cookie');
    if (sc && sc.startsWith('ma_session=')) cookie = sc.split(';')[0];
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, json, text };
  }
  async function close() {
    await app.locals.jobs.stop();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    s.db.close();
  }
  return { ...s, app, server, base, req, close, setCookie: (c) => { cookie = c; }, getCookie: () => cookie };
}

export async function waitIdle(app) {
  for (let i = 0; i < 200; i++) {
    const st = app.locals.jobs.status();
    if (!st.running && !st.queued.length) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('jobs did not finish');
}
