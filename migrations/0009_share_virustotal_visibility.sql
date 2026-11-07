-- Preserve existing share IDs and permissions while disabling public
-- VirusTotal display unless an administrator explicitly enables it.
ALTER TABLE shares ADD COLUMN show_virustotal INTEGER NOT NULL DEFAULT 0
  CHECK (show_virustotal IN (0, 1));
