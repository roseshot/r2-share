-- Initial schema for a new Cloudflare D1 database.
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_files_created ON files (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_files_expires ON files (expires_at);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  backend TEXT NOT NULL CHECK (backend IN ('b2', 'r2')),
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'uploading'))
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_created ON upload_sessions (created_at);

CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL
);
