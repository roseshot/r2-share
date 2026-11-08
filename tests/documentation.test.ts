import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const docs = [
  "README.md",
  "docs/deployment.md",
  "docs/usage.md",
  "docs/operations.md",
  "docs/development.md",
  "services/download-node/README.md",
];

describe("documentation", () => {
  test("has a readable entry point and focused linked guides", () => {
    const readme = readFileSync(resolve(root, "README.md"), "utf8");
    for (const section of [
      "## Highlights", "## Quick start", "## Documentation",
      "## Security notes", "## Contributing and support", "## License",
    ]) expect(readme).toContain(section);
    for (const file of docs.slice(1)) {
      expect(readme, file).toContain("](" + file + ")");
    }
  });

  test("keeps local Markdown links resolvable and removes obsolete instructions", () => {
    for (const file of docs) {
      const content = readFileSync(resolve(root, file), "utf8");
      expect(content, file).toMatch(/^# .+/m);
      expect(content, file).not.toContain("0002_file_shares.sql");
      expect(content, file).not.toContain("roseshot/r2-share");
      expect(content, file).not.toContain("r2_share_admin");
      for (const match of content.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
        const target = match[1];
        if (/^(?:https?:|mailto:|#)/.test(target)) continue;
        const path = resolve(dirname(resolve(root, file)), target);
        expect(existsSync(path), file + " -> " + target).toBe(true);
      }
    }
  });

  test("documents the actual D1 baseline and deployment commands", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const deployment = readFileSync(resolve(root, "docs/deployment.md"), "utf8");
    const development = readFileSync(resolve(root, "docs/development.md"), "utf8");
    expect(deployment).toContain("database/migrations/0001_initial.sql");
    expect(deployment).toContain("D1_DATABASE_NAME");
    expect(deployment).toContain("D1_DATABASE_ID");
    expect(deployment).toContain("APP_MASTER_KEY");
    expect(deployment).toContain("ADMIN_PATH");
    expect(deployment).toContain("ADMIN_PASSWORD");
    for (const command of ["dev", "build", "db:migrate", "deploy", "typecheck", "test"]) {
      expect(pkg.scripts[command]).toBeDefined();
      expect(development + deployment).toContain(command === "test" ? "bun test" : "bun run " + command);
    }
  });
});
