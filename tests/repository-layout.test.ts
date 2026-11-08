import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

function walk(dir: string): string[] {
  return readdirSync(resolve(root, dir)).flatMap(name => {
    const path = dir + "/" + name;
    return statSync(resolve(root, path)).isDirectory() ? walk(path) : [path];
  });
}

describe("repository layout", () => {
  test("separates UI layers, Worker entry, Go service and D1 schema", () => {
    for (const path of [
      "src/main.tsx", "src/pages/admin.tsx", "src/pages/share.tsx",
      "src/components/ui.tsx", "src/features/admin/admin-settings.tsx",
      "src/features/files/preview-types.ts", "src/features/uploads/upload-queue.ts",
      "src/lib/api.ts", "src/lib/routes.ts", "worker/index.ts",
      "database/migrations/0001_initial.sql", "services/download-node/go.mod",
    ]) expect(existsSync(resolve(root, path)), path).toBe(true);
    for (const obsolete of [
      "src/admin.tsx", "src/ui.tsx", "src/lib.ts", "src/preview-types.ts",
      "migrations/0001_initial.sql", "download-node/go.mod",
    ]) expect(existsSync(resolve(root, obsolete)), obsolete).toBe(false);
    const mod = readFileSync(resolve(root, "services/download-node/go.mod"), "utf8");
    expect(mod).toMatch(/^module github\.com\/roseshot\/tuckbox\/services\/download-node$/m);
  });

  test("resolves every local TS import after file moves", () => {
    for (const file of ["src", "worker"].flatMap(walk)
      .filter(file => /\.(?:ts|tsx|mjs)$/.test(file))) {
      const content = readFileSync(resolve(root, file), "utf8");
      for (const match of content.matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
        const target = resolve(dirname(resolve(root, file)), match[1]);
        expect([target, target + ".ts", target + ".tsx", target + ".json",
          target + ".css", target + ".mjs"].some(existsSync), file + ": " + match[1]).toBe(true);
      }
    }
  });

  test("aligns build, D1 migrations and Dependabot with the new paths", () => {
    const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    const dependabot = readFileSync(resolve(root, ".github/dependabot.yml"), "utf8");
    const d1 = readFileSync(resolve(root, "scripts/configure-d1.mjs"), "utf8");
    expect(ci).toContain("working-directory: services/download-node");
    expect(ci).toContain("go-version-file: services/download-node/go.mod");
    expect(dependabot).toContain('directory: "/services/download-node"');
    expect(d1).toContain('migrations_dir: "database/migrations"');
  });
});
