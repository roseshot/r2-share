import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

describe("Vite 8 and React build compatibility", () => {
  const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  test("upgrades Vite and its React plugin together", () => {
    const major = (spec: string) => Number(/^\^(\d+)\./.exec(spec)?.[1] ?? 0);
    expect(major(pkg.devDependencies.vite)).toBeGreaterThanOrEqual(8);
    expect(major(pkg.devDependencies["@vitejs/plugin-react"])).toBeGreaterThanOrEqual(6);
    expect(vite).toContain('import react from "@vitejs/plugin-react"');
    expect(vite).toContain('import { cloudflare } from "@cloudflare/vite-plugin"');
  });

  test("does not pass unsupported Rollup options to Rolldown", () => {
    expect(vite).not.toContain("maxParallelFileOps");
    expect(vite).not.toContain("rollupOptions");
  });
});
