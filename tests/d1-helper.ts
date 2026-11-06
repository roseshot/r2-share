import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

export function createTestDatabase(): D1Database {
  const database = new Database(":memory:");
  database.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../migrations/0002_file_shares.sql", import.meta.url), "utf8"));

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
    async batch(statements: { execute(): unknown }[]) {
      return database.transaction(() => statements.map(statement => statement.execute()))();
    },
  } as unknown as D1Database;
}
