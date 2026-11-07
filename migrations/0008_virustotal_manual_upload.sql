-- Only administrator-authorized files may have bytes sent to VirusTotal.
-- Authorizations are tied to a particular file ID; identical hashes alone do
-- not permit submission of a different file.
ALTER TABLE virustotal_queue ADD COLUMN upload_file_id TEXT;
ALTER TABLE virustotal_queue ADD COLUMN upload_submitted_at INTEGER;
