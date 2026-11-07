-- Admin-issued public upload pages. A completed upload consumes one quota slot.
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

-- Reuse upload sessions as atomic reservations for public page quotas.
ALTER TABLE upload_sessions ADD COLUMN public_page_id TEXT;
CREATE INDEX IF NOT EXISTS idx_upload_sessions_page
  ON upload_sessions (public_page_id, created_at);
