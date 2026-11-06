import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

const initial = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
const shares = readFileSync(new URL("../migrations/0002_file_shares.sql", import.meta.url), "utf8");

describe("D1 SQLite migrations", () => {
  test("keeps the initial schema and adds a separate additive migration", () => {
    expect(readdirSync(new URL("../migrations/", import.meta.url)).filter(name => name.endsWith(".sql")))
      .toEqual(["0001_initial.sql", "0002_file_shares.sql"]);
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
