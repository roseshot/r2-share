-- Cache per-storage managed-file usage after the scheduled file cleanup.
-- Values come from D1 file records, not a remote bucket inventory.
CREATE TABLE IF NOT EXISTS storage_usage (
  storage_id TEXT PRIMARY KEY,
  used_bytes INTEGER NOT NULL CHECK (used_bytes >= 0),
  file_count INTEGER NOT NULL CHECK (file_count >= 0),
  calculated_at TEXT NOT NULL
);
