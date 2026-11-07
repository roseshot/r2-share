import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;

describe("environment-injected D1 deployment", () => {
  test("does not commit a D1 database identifier", () => {
    expect(config.d1_databases).toBeUndefined();
    expect(config.keep_vars).toBe(true);
    expect(config.vars).toBeUndefined();
    expect(config.r2_buckets).toBeUndefined();
    const generator = readFileSync(new URL("../scripts/configure-d1.mjs", import.meta.url), "utf8");
    expect(generator).toContain("process.env.D1_DATABASE_ID");
    expect(generator).toContain("process.env.D1_DATABASE_NAME");
    expect(generator).toContain("wrangler.generated.jsonc");
    const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
    expect(vite).toContain("./wrangler.generated.jsonc");
  });

  test("requires both database environment variables and injects them into the generated binding", () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "tuckbox-d1-config-"));
    const generator = fileURLToPath(new URL("../scripts/configure-d1.mjs", import.meta.url));
    const databaseId = "12345678-1234-4123-8123-123456789abc";
    const run = (name: string, id: string) => spawnSync(process.execPath, [generator], {
      cwd: workingDirectory,
      encoding: "utf8",
      env: { ...process.env, D1_DATABASE_NAME: name, D1_DATABASE_ID: id },
    });
    try {
      const missingName = run("", databaseId);
      expect(missingName.status).not.toBe(0);
      expect(missingName.stderr).toContain("D1_DATABASE_NAME is required");

      const missingId = run("my-d1", "");
      expect(missingId.status).not.toBe(0);
      expect(missingId.stderr).toContain("D1_DATABASE_ID is required");

      const invalidId = run("my-d1", "invalid");
      expect(invalidId.status).not.toBe(0);
      expect(invalidId.stderr).toContain("D1_DATABASE_ID must be a UUID");

      const success = run("my-d1", databaseId);
      expect(success.status).toBe(0);
      const config = JSON.parse(readFileSync(join(workingDirectory, "wrangler.generated.jsonc"), "utf8"));
      expect(config.d1_databases).toEqual([{
        binding: "DB",
        database_name: "my-d1",
        database_id: databaseId,
        migrations_dir: "migrations",
      }]);
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  test("keeps storage credentials private and runs only expiration cleanup", () => {
    expect(config.secrets.required).toEqual([
      "APP_MASTER_KEY", "ADMIN_PATH", "ADMIN_PASSWORD",
    ]);
    expect(config.name).toBe("r2-share");
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.assets).toEqual({
      binding: "ASSETS", run_worker_first: true, html_handling: "none",
    });
    expect(config.triggers.crons).toEqual(["0 */6 * * *"]);
    expect(config.secrets.required).toHaveLength(3);
    expect(config.vars).toBeUndefined();
    const migrations = readdirSync(new URL("../migrations/", import.meta.url)).filter(name => name.endsWith(".sql")).sort();
    expect(migrations).toEqual(["0001_initial.sql", "0002_file_shares.sql", "0003_share_labels.sql", "0004_storage_usage.sql", "0005_public_upload_pages.sql", "0006_virustotal_queue.sql"]);
    const schema = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS app_settings");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS files");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS upload_sessions");
    const shareSchema = readFileSync(new URL("../migrations/0002_file_shares.sql", import.meta.url), "utf8");
    expect(shareSchema).toContain("CREATE TABLE IF NOT EXISTS shares");
    expect(shareSchema).toContain("INSERT OR IGNORE INTO shares");
    expect(readFileSync(new URL("../migrations/0004_storage_usage.sql", import.meta.url), "utf8"))
      .toContain("CREATE TABLE IF NOT EXISTS storage_usage");
    expect(readFileSync(new URL("../migrations/0005_public_upload_pages.sql", import.meta.url), "utf8"))
      .toContain("CREATE TABLE IF NOT EXISTS public_upload_pages");
    expect(schema).not.toContain("storage_reset");
    expect(schema).not.toContain("import_progress");
    expect(schema).toContain("storage_id TEXT NOT NULL");
    expect(schema).not.toMatch(/DELETE\s+FROM\s+app_settings/i);
  });

  test("automatically migrates before deployment and blocks missing database IDs", () => {
    expect(scripts["db:migrate"]).toContain("configure-d1.mjs");
    expect(scripts["db:migrate"]).not.toContain("--require-id");
    expect(scripts["db:migrate"]).toContain("migrations apply DB --remote");
    expect(scripts.deploy).toBe("bun run db:migrate && bun run build && wrangler deploy");
    expect(scripts["deploy:publish"]).toBeUndefined();
    expect(scripts.dev).not.toContain("provision-app.mjs");
    expect(scripts.deploy).not.toContain("provision-app.mjs");
    expect(scripts.build).toContain("configure-d1.mjs");
    const schema = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
    expect(schema).not.toMatch(/DROP\s+TABLE|DELETE\s+FROM|storage_reset|import_progress/i);
    const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
    expect(worker).not.toContain("storageResetPending");
    expect(worker).not.toContain("resetStorageBatch");
    expect(worker).not.toContain("Storage reset in progress");
  });
});
