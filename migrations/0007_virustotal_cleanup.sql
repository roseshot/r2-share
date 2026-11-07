-- Clear VirusTotal data for hashes no longer associated with stored files.
-- Keep shared SHA-256 records while at least one file still references them.
DELETE FROM virustotal_queue
WHERE NOT EXISTS (
  SELECT 1 FROM files
  WHERE json_extract(record_json, '$.checksums.sha256') = virustotal_queue.sha256
);

DELETE FROM virustotal_reports
WHERE NOT EXISTS (
  SELECT 1 FROM files
  WHERE json_extract(record_json, '$.checksums.sha256') = virustotal_reports.sha256
);
