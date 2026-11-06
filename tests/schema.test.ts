import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

const schema = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");

describe("new D1 SQLite schema", () => {
  test("has a single initial migration without legacy operations", () => {
    expect(readdirSync(new URL("../migrations/", import.meta.url)).filter(name => name.endsWith(".sql")))
      .toEqual(["0001_initial.sql"]);
    expect(schema).not.toMatch(/storage_reset|import_progress|DROP\s+TABLE|DELETE\s+FROM/i);
    expect(schema).toContain("backend TEXT NOT NULL");
  });

  test("creates only the current tables and indexes", () => {
    const db = new Database(":memory:");
    try {
      db.exec(schema);
      const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[];
      expect(tables.map(row => row.name)).toEqual(["app_settings", "files", "upload_sessions"]);
      const indexes = db.query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all() as { name: string }[];
      expect(indexes.map(row => row.name)).toEqual([
        "idx_files_created", "idx_files_expires", "idx_upload_sessions_created",
      ]);

      db.query("INSERT INTO files (id, record_json, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .run("one", '{"id":"one","backend":"b2"}', "2026-11-01T00:00:00.000Z", null);
      db.query("INSERT INTO upload_sessions (id, backend, created_at, status) VALUES (?, ?, ?, ?)")
        .run("two", "r2", 1234, "pending");
      db.query("INSERT INTO app_settings (id, payload) VALUES (1, ?)").run("encrypted-settings");
      db.exec(schema);
      expect(db.query("SELECT record_json FROM files WHERE id = 'one'").get())
        .toEqual({ record_json: '{"id":"one","backend":"b2"}' });
      expect(db.query("SELECT backend, status FROM upload_sessions WHERE id = 'two'").get())
        .toEqual({ backend: "r2", status: "pending" });
      expect(db.query("SELECT payload FROM app_settings WHERE id = 1").get())
        .toEqual({ payload: "encrypted-settings" });
    } finally {
      db.close();
    }
  });

  test("requires a valid backend for each upload session", () => {
    const db = new Database(":memory:");
    try {
      db.exec(schema);
      expect(() => db.query("INSERT INTO upload_sessions (id, created_at, status) VALUES (?, ?, ?)")
        .run("missing", 1234, "pending")).toThrow();
      expect(() => db.query("INSERT INTO upload_sessions (id, backend, created_at, status) VALUES (?, ?, ?, ?)")
        .run("invalid", "legacy", 1234, "pending")).toThrow();
      db.query("INSERT INTO upload_sessions (id, backend, created_at, status) VALUES (?, ?, ?, ?)")
        .run("valid", "b2", 1234, "pending");
      expect(db.query("SELECT backend FROM upload_sessions WHERE id = 'valid'").get())
        .toEqual({ backend: "b2" });
    } finally {
      db.close();
    }
  });
});
