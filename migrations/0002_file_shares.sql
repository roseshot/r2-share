-- Move share permissions out of file metadata. Preserve each existing URL as its first share.
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('public', 'protected')),
  revision TEXT NOT NULL,
  encrypted_code_json TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_file ON shares (file_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares (expires_at);

INSERT OR IGNORE INTO shares (id, file_id, mode, revision, encrypted_code_json, expires_at, created_at)
SELECT id, id,
  json_extract(record_json, '$.mode'),
  json_extract(record_json, '$.revision'),
  json_extract(record_json, '$.encryptedCode'),
  json_extract(record_json, '$.shareExpiresAt'),
  created_at
FROM files
WHERE json_extract(record_json, '$.mode') IN ('public', 'protected')
  AND json_type(record_json, '$.revision') = 'text';
