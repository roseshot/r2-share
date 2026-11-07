import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

const initial = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
const shares = readFileSync(new URL("../migrations/0002_file_shares.sql", import.meta.url), "utf8");

describe("D1 SQLite migrations", () => {
  test("keeps the initial schema and adds a separate additive migration", () => {
    expect(readdirSync(new URL("../migrations/", import.meta.url)).filter(name => name.endsWith(".sql")).sort())
      .toEqual(["0001_initial.sql", "0002_file_shares.sql", "0003_share_labels.sql", "0004_storage_usage.sql", "0005_public_upload_pages.sql", "0006_virustotal_queue.sql", "0007_virustotal_cleanup.sql"]);
    expect(initial).not.toContain("CREATE TABLE IF NOT EXISTS shares");
    expect(shares).toContain("CREATE TABLE IF NOT EXISTS shares");
    expect(shares).not.toMatch(/DROP\s+TABLE|DELETE\s+FROM/i);
    expect(shares).toContain("REFERENCES files(id) ON DELETE CASCADE");
  });

  test("migrates a previous link without changing its ID, encrypted code or expiry", () => {
    const db = new Database(":memory:");
    try {
      db.exec(initial);
      db.query("INSERT INTO files (id, record_json, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .run("oldFile123456789", JSON.stringify({
          id: "oldFile123456789", storageId: "b2-primary", filename: "old.txt",
          mode: "protected", revision: "rev123", encryptedCode: { iv: "iv", data: "secret" },
          shareExpiresAt: "2026-12-01T00:00:00.000Z",
        }), "2026-11-01T00:00:00.000Z", null);
      db.exec(shares);
      const row = db.query(
        "SELECT id, file_id, mode, revision, encrypted_code_json, expires_at FROM shares"
      ).get() as Record<string, unknown>;
      expect(row).toEqual({
        id: "oldFile123456789", file_id: "oldFile123456789",
        mode: "protected", revision: "rev123",
        encrypted_code_json: '{"iv":"iv","data":"secret"}',
        expires_at: "2026-12-01T00:00:00.000Z",
      });
      db.exec(shares);
      expect(db.query("SELECT COUNT(*) AS n FROM shares").get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });

  test("adds optional share labels without changing legacy access settings", () => {
    const db = new Database(":memory:");
    try {
      db.exec(initial);
      db.exec(shares);
      db.query("INSERT INTO files (id, record_json, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .run("someFile12345678", "{}", "2026-11-01", null);
      db.query("INSERT INTO shares (id, file_id, mode, revision, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("shareOne12345678", "someFile12345678", "public", "first", null, "2026-11-01");
      db.exec(readFileSync(new URL("../migrations/0003_share_labels.sql", import.meta.url), "utf8"));
      expect(db.query("SELECT id, label, revision FROM shares").get())
        .toEqual({ id: "shareOne12345678", label: "", revision: "first" });
    } finally { db.close(); }
  });

  test("adds isolated per-storage usage snapshots without mutating existing records", () => {
    const db = new Database(":memory:");
    try {
      db.exec(initial);
      db.exec(shares);
      db.exec(readFileSync(new URL("../migrations/0003_share_labels.sql", import.meta.url), "utf8"));
      db.query("INSERT INTO files (id, record_json, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .run("fileOne123456789", '{"filename":"unchanged.txt"}', "2026-11-01", null);
      const usage = readFileSync(new URL("../migrations/0004_storage_usage.sql", import.meta.url), "utf8");
      expect(usage).not.toMatch(/DROP\s+TABLE|DELETE\s+FROM/i);
      db.exec(usage);
      db.query("INSERT INTO storage_usage (storage_id, used_bytes, file_count, calculated_at) VALUES (?, ?, ?, ?)")
        .run("b2-primary", 12345, 2, "2026-11-07T00:00:00.000Z");
      expect(db.query("SELECT storage_id, used_bytes, file_count FROM storage_usage").get())
        .toEqual({ storage_id: "b2-primary", used_bytes: 12345, file_count: 2 });
      expect(db.query("SELECT COUNT(*) AS count FROM files").get()).toEqual({ count: 1 });
      db.exec(usage);
      expect(db.query("SELECT COUNT(*) AS count FROM storage_usage").get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });

  test("adds hash-keyed VirusTotal queue/cache and backfills existing verified files", () => {
    const database = new Database(":memory:");
    try {
      database.exec(initial);
      const sha256 = "a".repeat(64);
      database.query("INSERT INTO files (id, record_json, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .run("existingFile00001", JSON.stringify({ checksums: { sha256 } }), "2026-11-01", null);
      const migration = readFileSync(
        new URL("../migrations/0006_virustotal_queue.sql", import.meta.url), "utf8");
      expect(migration).not.toMatch(/DROP\\s+TABLE|DELETE\\s+FROM/i);
      database.exec(migration);
      expect(database.query("SELECT sha256 FROM virustotal_queue").all())
        .toEqual([{ sha256 }]);
      database.exec(migration);
      expect(database.query("SELECT COUNT(*) AS total FROM virustotal_queue").get())
        .toEqual({ total: 1 });
      database.query("INSERT INTO virustotal_reports (sha256, report_json, checked_at) VALUES (?, ?, ?)")
        .run(sha256, '{"status":"found"}', "2026-11-07");
      expect(database.query("SELECT COUNT(*) AS total FROM virustotal_reports").get())
        .toEqual({ total: 1 });
    } finally {
      database.close();
    }
  });

  test("deletes only orphaned VirusTotal reports and queue entries during migration", () => {
    const db = new Database(":memory:");
    try {
      db.exec(initial);
      const inUse = "a".repeat(64);
      const orphan = "b".repeat(64);
      db.query("INSERT INTO files (id, record_json, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .run("retainedFile0001", JSON.stringify({ checksums: { sha256: inUse } }),
          "2026-11-01", null);
      db.exec(readFileSync(new URL("../migrations/0006_virustotal_queue.sql", import.meta.url), "utf8"));
      db.query("INSERT INTO virustotal_queue (sha256, enqueued_at) VALUES (?, ?)")
        .run(orphan, 0);
      const insertReport = db.query(
        "INSERT INTO virustotal_reports (sha256, report_json, checked_at) VALUES (?, ?, ?)");
      for (const hash of [inUse, orphan]) {
        insertReport.run(hash, '{"status":"found"}', "2026-11-07");
      }
      const migrate = readFileSync(
        new URL("../migrations/0007_virustotal_cleanup.sql", import.meta.url), "utf8");
      expect(migrate).not.toMatch(/DROP\\s+TABLE/i);
      db.exec(migrate);
      db.exec(migrate);
      expect(db.query("SELECT sha256 FROM virustotal_queue").all()).toEqual([{ sha256: inUse }]);
      expect(db.query("SELECT sha256 FROM virustotal_reports").all()).toEqual([{ sha256: inUse }]);
      expect(db.query("SELECT COUNT(*) AS count FROM files").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  test("adds explicit VirusTotal file-level consent flags without automatic submission", () => {
    const db = new Database(":memory:");
    try {
      db.exec(initial);
      db.exec(readFileSync(new URL("../migrations/0006_virustotal_queue.sql", import.meta.url), "utf8"));
      db.exec(readFileSync(new URL("../migrations/0008_virustotal_manual_upload.sql", import.meta.url), "utf8"));
      const sha = "a".repeat(64);
      db.query("INSERT INTO virustotal_queue (sha256, enqueued_at) VALUES (?, 0)").run(sha);
      expect(db.query("SELECT upload_file_id, upload_submitted_at FROM virustotal_queue WHERE sha256 = ?")
        .get(sha)).toEqual({ upload_file_id: null, upload_submitted_at: null });
    } finally {
      db.close();
    }
  });

  test("supports multiple links to the same file with separate permissions", () => {
    const db = new Database(":memory:");
    try {
      db.exec(initial);
      db.exec(shares);
      const created = "2026-11-01T00:00:00.000Z";
      db.query("INSERT INTO files (id, record_json, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .run("oneFile123456789", '{"id":"oneFile123456789"}', created, null);
      const insert = db.query("INSERT INTO shares (id, file_id, mode, revision, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      insert.run("shareOne12345678", "oneFile123456789", "public", "first", null, created);
      insert.run("shareTwo12345678", "oneFile123456789", "protected", "second", "2026-12-01", created);
      expect(db.query("SELECT COUNT(*) AS n FROM shares WHERE file_id = ?")
        .get("oneFile123456789")).toEqual({ n: 2 });
      expect(db.query("SELECT mode FROM shares WHERE id = 'shareOne12345678'").get())
        .toEqual({ mode: "public" });
      expect(db.query("SELECT mode FROM shares WHERE id = 'shareTwo12345678'").get())
        .toEqual({ mode: "protected" });
    } finally { db.close(); }
  });
});
