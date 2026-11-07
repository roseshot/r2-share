import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

describe("D1-backed per-storage usage", () => {
  test("calculates and stores an atomic snapshot after file cleanup", () => {
    const storage = read("worker/storage.ts");
    expect(storage).toContain("await recalculateStorageUsage(env)");
    expect(storage).toContain("SUM(CAST(json_extract(record_json, '$.size') AS INTEGER))");
    expect(storage).toContain("GROUP BY json_extract(record_json, '$.storageId')");
    expect(storage).toContain('env.DB.prepare("DELETE FROM storage_usage")');
    expect(storage).toContain("await env.DB.batch([");
    expect(storage).toContain("total?.used_bytes ?? 0");
    expect(storage).toContain("total?.file_count ?? 0");
  });

  test("exposes only configured storage IDs via authenticated settings", () => {
    const worker = read("worker/index.ts");
    expect(worker).toContain('app.get("/:entry/api/settings", async c =>');
    expect(worker).toContain("storageUsage: await getStorageUsage(c.env, (settings?.storages ?? []).map(storage => storage.id))");
    expect(worker).toContain('if (controller.cron === "0 */6 * * *") {');
    expect(worker).toContain("await cleanupExpired(configured);");
    expect(worker).toContain("await processVirusTotalQueue(configured);");
  });

  test("does not derive usage from the current file page or search filters", () => {
    const admin = read("src/admin.tsx");
    expect(admin).toContain("setStorageUsage(settings.storageUsage)");
    expect(admin).toContain('<section aria-label="Storage used"');
    expect(admin).toContain("storageUsage.map(usage =>");
    expect(admin).toContain("usage.usedBytes");
    expect(admin).toContain("usage.fileCount");
    expect(admin).toContain("usage.calculatedAt");
    expect(admin).toContain("Awaiting first cleanup");
    expect(admin).not.toContain("Storage used (current page)");
    expect(admin).not.toContain("sizeText(files.reduce((sum, f) => sum + f.size, 0))");
  });
});
