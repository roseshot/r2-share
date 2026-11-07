import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

export function createTestDatabase(): D1Database {
  const database = new Database(":memory:");
  database.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../migrations/0002_file_shares.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../migrations/0003_share_labels.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../migrations/0004_storage_usage.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../migrations/0005_public_upload_pages.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../migrations/0006_virustotal_queue.sql", import.meta.url), "utf8"));

  function prepare(sql: string, params: unknown[] = []) {
    const statement = database.prepare(sql);
    return {
      bind(...values: unknown[]) { return prepare(sql, values); },
      async first<T>() { return (statement.get(...params) ?? null) as T | null; },
      async all<T>() { return { results: statement.all(...params) as T[] }; },
      async run() { return { success: true, meta: { changes: statement.run(...params).changes } }; },
      execute() { return statement.run(...params); },
    };
  }

  return {
    prepare,
    async batch(statements: { execute(): { changes: number } }[]) {
      const results = database.transaction(() =>
        statements.map(statement => statement.execute()))();
      // D1 batch returns D1Result.meta.changes; bun:sqlite returns changes directly.
      return results.map(result => ({ ...result, meta: { changes: result.changes } }));
    },
  } as unknown as D1Database;
}
