import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

const schema = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");

function database() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(schema);
  return db;
}

describe("D1 database schema", () => {
  test("uses a single baseline without data backfills or upgrade scripts", () => {
    expect(readdirSync(new URL("../migrations/", import.meta.url))
      .filter(name => name.endsWith(".sql")).sort()).toEqual(["0001_initial.sql"]);
    expect(schema).not.toMatch(/ALTER\s+TABLE|INSERT\s+(?:OR\s+IGNORE\s+)?INTO|UPDATE\s+|DELETE\s+FROM|DROP\s+TABLE/i);
    const db = database();
    try {
      const tables = db.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all().map(row => (row as { name: string }).name);
      expect(tables).toEqual([
        "app_settings", "files", "public_upload_pages", "shares",
        "storage_usage", "upload_sessions", "virustotal_queue", "virustotal_reports",
      ]);
    } finally { db.close(); }
  });

  test("stores independent share permissions and checks default visibility", () => {
    const db = database();
    try {
      db.query("INSERT INTO files (id, record_json, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .run("3d4071e7-a4b3-4c06-9801-61f4aca13052", "{}", "2026-11-01", null);
      const insert = db.query(
        "INSERT INTO shares (id, file_id, mode, revision, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      );
      insert.run("shareOne", "3d4071e7-a4b3-4c06-9801-61f4aca13052",
        "public", "first", null, "2026-11-01");
      insert.run("shareTwo", "3d4071e7-a4b3-4c06-9801-61f4aca13052",
        "protected", "second", "2026-12-01", "2026-11-01");
      expect(db.query("SELECT id, mode, label, show_virustotal FROM shares ORDER BY id").all())
        .toEqual([
          { id: "shareOne", mode: "public", label: "", show_virustotal: 0 },
          { id: "shareTwo", mode: "protected", label: "", show_virustotal: 0 },
        ]);
      db.query("UPDATE shares SET show_virustotal = 1 WHERE id = 'shareOne'").run();
      expect(() => db.query("UPDATE shares SET show_virustotal = 2").run()).toThrow();
      expect(() => insert.run("other", "missing-file", "public", "rev", null, "2026-11-01"))
        .toThrow();
      expect(() => insert.run("other", "3d4071e7-a4b3-4c06-9801-61f4aca13052",
        "invalid", "rev", null, "2026-11-01")).toThrow();
    } finally { db.close(); }
  });

  test("supports public upload reservations and quotas", () => {
    const db = database();
    try {
      db.query("INSERT INTO public_upload_pages (id, label, storage_id, created_at) VALUES (?, ?, ?, ?)")
        .run("uploadPage", "Public Upload", "primary-b2", "2026-11-01");
      db.query(
        "INSERT INTO upload_sessions (id, storage_id, created_at, status, public_page_id) VALUES (?, ?, ?, ?, ?)"
      ).run("session", "primary-b2", 0, "pending", "uploadPage");
      expect(db.query("SELECT public_page_id FROM upload_sessions WHERE id = 'session'").get())
        .toEqual({ public_page_id: "uploadPage" });
      expect(() => db.query(
        "INSERT INTO public_upload_pages (id, label, storage_id, max_uploads, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run("invalidPage", "Invalid", "primary-b2", 0, "2026-11-01")).toThrow();
    } finally { db.close(); }
  });

  test("supports usage tracking and VirusTotal queue with explicit upload consent", () => {
    const db = database();
    try {
      db.query(
        "INSERT INTO storage_usage (storage_id, used_bytes, file_count, calculated_at) VALUES (?, ?, ?, ?)"
      ).run("primary-b2", 12, 1, "2026-11-01");
      expect(db.query("SELECT used_bytes, file_count FROM storage_usage").get())
        .toEqual({ used_bytes: 12, file_count: 1 });
      expect(() => db.query(
        "INSERT INTO storage_usage (storage_id, used_bytes, file_count, calculated_at) VALUES (?, ?, ?, ?)"
      ).run("invalid", -1, 0, "2026-11-01")).toThrow();
      const sha256 = "a".repeat(64);
      db.query("INSERT INTO virustotal_queue (sha256, enqueued_at) VALUES (?, ?)")
        .run(sha256, 0);
      expect(db.query(
        "SELECT next_attempt_at, attempts, upload_file_id, upload_submitted_at FROM virustotal_queue"
      ).get()).toEqual({
        next_attempt_at: 0, attempts: 0, upload_file_id: null, upload_submitted_at: null,
      });
      db.query("INSERT INTO virustotal_reports (sha256, report_json, checked_at) VALUES (?, ?, ?)")
        .run(sha256, '{"status":"found"}', "2026-11-01");
      expect(db.query("SELECT COUNT(*) AS n FROM virustotal_reports").get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });
});
