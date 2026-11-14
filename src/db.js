import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// Forward-only, idempotent migrations. Each runs once inside a transaction.
const MIGRATIONS = [
  {
    version: 1,
    destructive: false,
    sql: `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE imports (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,              -- inbox | dav | test
  file_name TEXT NOT NULL,
  file_path TEXT,
  file_size INTEGER,
  file_mtime INTEGER,
  file_sha256 TEXT,
  status TEXT NOT NULL,              -- running | verified | failed | interrupted | skipped
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  backup_set TEXT, backup_date INTEGER, backup_type TEXT,
  count_attr INTEGER, parsed INTEGER DEFAULT 0, parsed_sms INTEGER DEFAULT 0, parsed_mms INTEGER DEFAULT 0,
  new_messages INTEGER DEFAULT 0, existing_messages INTEGER DEFAULT 0, upgraded_messages INTEGER DEFAULT 0,
  media_parts INTEGER DEFAULT 0, media_new INTEGER DEFAULT 0, media_new_bytes INTEGER DEFAULT 0,
  media_missing INTEGER DEFAULT 0, restricted INTEGER DEFAULT 0,
  message TEXT,                      -- error or verification summary
  verify_json TEXT
);
CREATE INDEX imports_sha ON imports(file_sha256);
CREATE INDEX imports_path ON imports(file_path, file_size, file_mtime);
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  participants TEXT NOT NULL,        -- JSON array of normalized addresses (self excluded)
  is_group INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  first_date INTEGER, last_date INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  media_count INTEGER NOT NULL DEFAULT 0,
  media_bytes INTEGER NOT NULL DEFAULT 0,
  last_snippet TEXT
);
CREATE INDEX conversations_last ON conversations(last_date DESC);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  fp TEXT NOT NULL UNIQUE,           -- fingerprint, see src/fingerprint.js
  kind TEXT NOT NULL,                -- sms | mms
  address TEXT,                      -- raw address attribute (SMS number, MMS '~' list)
  conversation_id INTEGER REFERENCES conversations(id),
  date INTEGER NOT NULL,             -- ms UTC
  date_sent INTEGER,
  box INTEGER NOT NULL,              -- 1 received, 2 sent, 3 draft, 4 outbox, 5 failed, 6 queued
  sender TEXT,                       -- normalized address, NULL = me
  body TEXT,
  read INTEGER,
  restricted INTEGER NOT NULL DEFAULT 0,
  copies INTEGER NOT NULL DEFAULT 1,
  media_count INTEGER NOT NULL DEFAULT 0,
  media_missing INTEGER NOT NULL DEFAULT 0,
  first_import_id INTEGER,
  attrs TEXT NOT NULL,               -- original XML attributes (JSON), for faithful restore
  addrs TEXT                         -- MMS <addr> list (JSON)
);
CREATE INDEX messages_conv_date ON messages(conversation_id, date, id);
CREATE INDEX messages_date ON messages(date);
CREATE TABLE parts (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  seq INTEGER, ct TEXT, name TEXT, text TEXT,
  media_sha256 TEXT, media_size INTEGER,
  missing INTEGER NOT NULL DEFAULT 0,  -- media type with no data in any backup so far
  attrs TEXT NOT NULL
);
CREATE INDEX parts_msg ON parts(message_id);
CREATE INDEX parts_media ON parts(media_sha256);
CREATE TABLE media (
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  ct TEXT,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  verify_ok INTEGER
);
CREATE TABLE message_sources (message_id INTEGER NOT NULL, import_id INTEGER NOT NULL, PRIMARY KEY (message_id, import_id)) WITHOUT ROWID;
CREATE TABLE contacts (address TEXT PRIMARY KEY, name TEXT NOT NULL, name_date INTEGER NOT NULL);
CREATE TABLE self_addresses (address TEXT PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL);
CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
`,
  },
];

export function openDb(dataDir, log) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'archive.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, dataDir, log);
  return db;
}

export function currentSchema(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  return row?.v || 0;
}

export function migrate(db, dataDir, log) {
  const from = currentSchema(db);
  const todo = MIGRATIONS.filter((m) => m.version > from);
  if (!todo.length) return from;
  if (from > 0 && todo.some((m) => m.destructive)) {
    const dir = path.join(dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const to = todo[todo.length - 1].version;
    const target = path.join(dir, `pre-migrate-${from}-to-${to}.db`);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    log?.info('database copied before migration', { target });
  }
  for (const m of todo) {
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    })();
    log?.info('migration applied', { version: m.version });
  }
  return todo[todo.length - 1].version;
}

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}
export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
