import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

describe("Cloudflare build resource limits", () => {
  test("caps Rollup concurrent file reads to prevent EMFILE on Lucide icons", () => {
    const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
    const count = /maxParallelFileOps:\s*(\d+)/.exec(vite);
    expect(count).not.toBeNull();
    const max = Number(count?.[1]);
    expect(max).toBeGreaterThanOrEqual(8);
    expect(max).toBeLessThanOrEqual(64);
    expect(vite).toContain("rollupOptions");
  });
});
