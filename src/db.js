// SQLite store (node:sqlite, zero dependencies).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DESK_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'desk.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT,
  author TEXT,
  author_id TEXT,
  content TEXT,
  ts TEXT,
  edited_ts TEXT,
  attachments TEXT,   -- JSON [{url, filename, local}]
  embeds TEXT,        -- JSON
  reply_to TEXT,
  source TEXT,        -- 'api' | 'dom'
  analyzed INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(ts);
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT UNIQUE,
  ts TEXT,
  symbol TEXT,
  side TEXT,          -- LONG | SHORT
  entry REAL, entry_hi REAL,
  sl REAL,
  tps TEXT,           -- JSON [numbers]
  leverage REAL,
  kind TEXT,          -- open | update | close | info
  confidence REAL,
  parser TEXT,        -- regex | llm
  notes TEXT
);
CREATE TABLE IF NOT EXISTS analyses (
  message_id TEXT PRIMARY KEY,
  ts TEXT,
  summary TEXT,
  verdict TEXT,       -- JSON
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`);

const upsertMsg = db.prepare(`
INSERT INTO messages (id, channel_id, author, author_id, content, ts, edited_ts, attachments, embeds, reply_to, source)
VALUES (?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  content = CASE WHEN excluded.source='api' OR messages.content IS NULL OR messages.content='' THEN excluded.content ELSE messages.content END,
  edited_ts = COALESCE(excluded.edited_ts, messages.edited_ts),
  attachments = CASE WHEN excluded.source='api' THEN excluded.attachments ELSE messages.attachments END,
  embeds = CASE WHEN excluded.source='api' THEN excluded.embeds ELSE messages.embeds END,
  source = CASE WHEN excluded.source='api' THEN 'api' ELSE messages.source END,
  analyzed = CASE WHEN excluded.edited_ts IS NOT NULL AND excluded.edited_ts IS NOT messages.edited_ts THEN 0 ELSE messages.analyzed END
`);

// Returns 'new', 'edited' (edit timestamp changed) or null.
function saveMessage(m) {
  const before = db.prepare('SELECT edited_ts FROM messages WHERE id=?').get(m.id);
  upsertMsg.run(
    m.id, m.channel_id, m.author || null, m.author_id || null, m.content || '',
    m.ts, m.edited_ts || null, JSON.stringify(m.attachments || []),
    JSON.stringify(m.embeds || []), m.reply_to || null, m.source
  );
  if (!before) return 'new';
  return m.edited_ts && m.edited_ts !== before.edited_ts ? 'edited' : null;
}

const kvGet = (k) => db.prepare('SELECT v FROM kv WHERE k=?').get(k)?.v;
const kvSet = (k, v) => db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));

module.exports = { db, saveMessage, kvGet, kvSet, DATA_DIR };
