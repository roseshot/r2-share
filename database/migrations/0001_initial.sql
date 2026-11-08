-- TuckBox schema for new Cloudflare D1 databases.
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
  storage_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'uploading')),
  public_page_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_created ON upload_sessions (created_at);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_page ON upload_sessions (public_page_id, created_at);

CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL CHECK (mode IN ('public', 'protected')),
  revision TEXT NOT NULL,
  encrypted_code_json TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  show_virustotal INTEGER NOT NULL DEFAULT 0 CHECK (show_virustotal IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_shares_file ON shares (file_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares (expires_at);

CREATE TABLE IF NOT EXISTS storage_usage (
  storage_id TEXT PRIMARY KEY,
  used_bytes INTEGER NOT NULL CHECK (used_bytes >= 0),
  file_count INTEGER NOT NULL CHECK (file_count >= 0),
  calculated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public_upload_pages (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  storage_id TEXT NOT NULL,
  expires_at TEXT,
  max_uploads INTEGER CHECK (max_uploads IS NULL OR max_uploads BETWEEN 1 AND 1000),
  completed_uploads INTEGER NOT NULL DEFAULT 0 CHECK (completed_uploads >= 0),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_public_upload_pages_created
  ON public_upload_pages (created_at DESC);

CREATE TABLE IF NOT EXISTS virustotal_reports (
  sha256 TEXT PRIMARY KEY,
  report_json TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS virustotal_queue (
  sha256 TEXT PRIMARY KEY,
  enqueued_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  upload_file_id TEXT,
  upload_submitted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_virustotal_queue_due
  ON virustotal_queue (next_attempt_at, enqueued_at);
