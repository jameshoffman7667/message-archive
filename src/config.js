import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export const PUBLIC_DIR = path.join(ROOT, 'public');

function int(env, name, def, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  return n;
}
function bool(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false (got "${raw}")`);
}

// Fail fast: every folder must exist and be writable by the container user.
function writableDir(name, dir) {
  if (!dir) throw new Error(`${name} is required`);
  let st;
  try { st = fs.statSync(dir); } catch { throw new Error(`${name} (${dir}) does not exist; create it and give uid 1000 / gid 100 write access`); }
  if (!st.isDirectory()) throw new Error(`${name} (${dir}) is not a directory`);
  try { fs.accessSync(dir, fs.constants.W_OK | fs.constants.R_OK); } catch { throw new Error(`${name} (${dir}) is not writable by uid ${process.getuid?.()}`); }
  return path.resolve(dir);
}

export function loadConfig(env = process.env) {
  const cfg = {
    version: APP_VERSION,
    port: int(env, 'PORT', 8080, 1, 65535),
    dataDir: writableDir('DATA_DIR', env.DATA_DIR || '/data'),
    filesDir: writableDir('FILES_DIR', env.FILES_DIR || '/files'),
    inboxDir: writableDir('INBOX_DIR', env.INBOX_DIR || '/inbox'),
    scanIntervalMinutes: int(env, 'SCAN_INTERVAL_MINUTES', 15, 0, 1440),
    settleSeconds: int(env, 'SETTLE_SECONDS', 120, 0, 86400),
    countryCode: (env.DEFAULT_COUNTRY_CODE || '1').replace(/\D/g, '') || '1',
    selfNumbers: (env.SELF_NUMBERS || '').split(',').map((s) => s.trim()).filter(Boolean),
    cutoffDays: int(env, 'CUTOFF_DAYS', 730, 1, 36500),
    keepRecentDays: int(env, 'KEEP_RECENT_DAYS', 30, 0, 36500),
    cookieSecure: bool(env, 'COOKIE_SECURE', false),
    sessionIdleMinutes: int(env, 'SESSION_IDLE_MINUTES', 720, 5, 525600),
    davMaxGb: int(env, 'DAV_MAX_GB', 20, 1, 500),
    logLevel: (env.LOG_LEVEL || 'info').toLowerCase(),
  };
  if (!['debug', 'info', 'warn', 'error'].includes(cfg.logLevel)) throw new Error('LOG_LEVEL must be debug, info, warn or error');
  return cfg;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export function makeLogger(level = 'info', sink = (line) => process.stdout.write(line + '\n')) {
  const min = LEVELS[level] ?? 20;
  const out = (lvl) => (msg, extra) => {
    if (LEVELS[lvl] < min) return;
    let line = `${new Date().toISOString()} ${lvl.toUpperCase()} ${msg}`;
    if (extra && Object.keys(extra).length) line += ' ' + Object.entries(extra).map(([k, v]) => `${k}=${typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : v}`).join(' ');
    sink(line);
  };
  return { debug: out('debug'), info: out('info'), warn: out('warn'), error: out('error') };
}
