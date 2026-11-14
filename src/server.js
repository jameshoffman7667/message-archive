import { loadConfig, makeLogger } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

let config;
try { config = loadConfig(); } catch (e) { console.error('FATAL: ' + e.message); process.exit(1); }
const log = makeLogger(config.logLevel);
const db = openDb(config.dataDir, log);
const app = createApp({ db, cfg: config, log });
const jobs = app.locals.jobs;

const server = app.listen(config.port, '0.0.0.0', () => log.info(`message-archive ${config.version} listening on ${config.port}`, { inbox: config.inboxDir }));
server.keepAliveTimeout = 65_000;
server.requestTimeout = 0; // large WebDAV uploads over a slow link must not be cut off

// Inbox scan: once shortly after start, then on the interval (0 = manual only).
const first = setTimeout(() => jobs.scan(), 10_000);
const timer = config.scanIntervalMinutes > 0 ? setInterval(() => jobs.scan(), config.scanIntervalMinutes * 60_000) : null;

// Stop accepting, let the running import stop at the next chunk (it commits what it has),
// close SQLite, exit well inside 10 s.
let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log.info(`${sig} received, shutting down`);
  const force = setTimeout(() => { log.warn('forced exit after timeout'); process.exit(1); }, 8000);
  force.unref();
  clearTimeout(first);
  if (timer) clearInterval(timer);
  server.close();
  server.closeIdleConnections?.();
  await jobs.stop();
  try { db.close(); } catch (e) { log.error('db close failed', { err: e.message }); }
  log.info('stopped cleanly');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
