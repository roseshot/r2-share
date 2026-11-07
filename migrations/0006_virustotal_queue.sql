-- VirusTotal hash-only reputation queue and immutable successful reports.
-- No file bytes, public share URLs, or API credentials are stored here.
CREATE TABLE IF NOT EXISTS virustotal_reports (
  sha256 TEXT PRIMARY KEY,
  report_json TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS virustotal_queue (
  sha256 TEXT PRIMARY KEY,
  enqueued_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_virustotal_queue_due
  ON virustotal_queue (next_attempt_at, enqueued_at);

-- Enqueue previously uploaded files that already have a SHA-256.
INSERT OR IGNORE INTO virustotal_queue (sha256, enqueued_at, next_attempt_at, attempts)
SELECT DISTINCT json_extract(record_json, '$.checksums.sha256'), 0, 0, 0
FROM files
WHERE json_type(record_json, '$.checksums.sha256') = 'text'
  AND length(json_extract(record_json, '$.checksums.sha256')) = 64;
