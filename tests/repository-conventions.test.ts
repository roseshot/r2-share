import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const targets = [
  ".dev.vars.example",
  ".github/workflows",
  ".gitignore",
  "README.md",
  "index.html",
  "package.json",
  "public",
  "src",
  "tests",
  "tsconfig.json",
  "vite.config.ts",
  "worker",
  "wrangler.jsonc",
];

function collect(path: string): string[] {
  const name = resolve(root, path);
  if (statSync(name).isDirectory()) {
    return readdirSync(name).flatMap(entry => collect(path + "/" + entry));
  }
  return [path];
}

describe("repository conventions", () => {
  test("source files, UI messages, and docs use English only", () => {
    const invalid = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/u;
    for (const path of targets.flatMap(collect)) {
      expect(readFileSync(resolve(root, path), "utf8").match(invalid), path).toBeNull();
    }
  });

  test("public pages retain the TuckBox brand while admin can name storage providers", () => {
    for (const path of ["index.html", "src/home.tsx", "src/share.tsx"]) {
      const content = readFileSync(resolve(root, path), "utf8");
      expect(content, path).toContain("TuckBox");
      expect(content, path).not.toMatch(/R2 Share|Cloudflare|Backblaze/);
    }
    const admin = readFileSync(resolve(root, "src/admin.tsx"), "utf8");
    const storage = readFileSync(resolve(root, "src/admin-settings.tsx"), "utf8");
    expect(admin).toContain("TuckBox");
    expect(admin).toContain("Storage ID");
    expect(storage).toContain("Cloudflare R2");
    expect(storage).toContain("Backblaze B2");
  });

  test("uses one TuckBox mark for all pages and the browser icon", () => {
    const svg = readFileSync(resolve(root, "public/tuckbox-mark.svg"), "utf8");
    expect(svg).toContain('viewBox="0 0 48 48"');
    expect(svg).toContain('fill="#34d399"');
    for (const path of ["src/home.tsx", "src/share.tsx", "src/admin.tsx"]) {
      const page = readFileSync(resolve(root, path), "utf8");
      expect(page, path).toContain('src="/tuckbox-mark.svg"');
      expect(page, path).not.toContain("FileArchive");
    }
    const html = readFileSync(resolve(root, "index.html"), "utf8");
    expect(html).toContain('rel="icon" type="image/svg+xml" href="/tuckbox-mark.svg"');
    const worker = readFileSync(resolve(root, "worker/index.ts"), "utf8");
    expect(worker).toContain('app.get("/tuckbox-mark.svg"');
  });

  test("keeps appearance selection available throughout the interface", () => {
    const theme = readFileSync(resolve(root, "src/theme.tsx"), "utf8");
    expect(theme).toContain('aria-label="Appearance"');
    expect(theme).toContain('localStorage.setItem(storageKey, next)');
    for (const path of ["src/home.tsx", "src/share.tsx", "src/admin.tsx"]) {
      expect(readFileSync(resolve(root, path), "utf8"), path).toContain("<ThemeSwitcher");
    }
    const css = readFileSync(resolve(root, "src/style.css"), "utf8");
    expect(css).toContain('@custom-variant dark');
    expect(css).toContain(':root[data-theme="dark"]');
    const admin = readFileSync(resolve(root, "src/admin.tsx"), "utf8");
    expect(admin).not.toContain("<footer");
  });

  test("interactive components use Base UI, not Radix Slot", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(packageJson.dependencies["@base-ui/react"]).toBeDefined();
    expect(packageJson.dependencies["@radix-ui/react-slot"]).toBeUndefined();
    const ui = readFileSync(resolve(root, "src/ui.tsx"), "utf8");
    expect(ui).toContain("@base-ui/react/button");
    expect(ui).toContain("@base-ui/react/input");
    expect(ui).toContain("@base-ui/react/select");
    expect(ui).not.toContain("asChild");
  });
});
