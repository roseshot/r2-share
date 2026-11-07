import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = (file: string) => readFileSync(new URL("../" + file, import.meta.url), "utf8");

describe("public upload completion and invalid share navigation", () => {
  test("shows only a success confirmation once all public uploads complete", () => {
    const page = source("src/public-upload.tsx");
    expect(page).toContain("const completed = !loading && uploaded.length > 0 && selected.length === 0 && !uploading && !error;");
    expect(page).toContain('{completed ? <div role="status" aria-label="Upload complete"');
    expect(page).toContain("<h1 className=\"text-2xl font-semibold\">Upload successful</h1>");
    expect(page).not.toContain("Files are available to the administrator.");
    // The upload controls and page usage details only appear in the non-completed branch.
    const successStart = page.indexOf("{completed ? <div");
    const controlsStart = page.indexOf('<h1 className="break-words text-3xl font-semibold">', successStart);
    expect(successStart).toBeGreaterThanOrEqual(0);
    expect(controlsStart).toBeGreaterThan(successStart);
    expect(page.slice(successStart, controlsStart)).toContain("</div> : <>");
  });

  test("shows only relevant upload information", () => {
    const page = source("src/public-upload.tsx");
    expect(page).not.toContain(">Public upload</p>");
    expect(page).not.toContain("Upload files without signing in.");
    expect(page).not.toContain("No time limit");
    expect(page).not.toContain("No file-count limit");
    expect(page).not.toContain("slots available");
    expect(page).toContain("page?.active && (page.expiresAt || page.remaining !== null)");
    expect(page).toContain("90 MiB per file · folders become ZIPs · paste with Ctrl+V");
    expect(page).toContain("Choose files</Button>");
    expect(page).toContain("Choose folder</Button>");
    expect(page).toContain("Uploading {current} · {progress}%");
  });

  test("uses the branded SharePage unavailable state for unknown IDs", () => {
    const worker = source("worker/index.ts");
    const routes = source("src/routes.ts");
    const client = source("src/main.tsx");
    const share = source("src/share.tsx");
    expect(worker).toContain('app.get("/:entry", async c =>');
    expect(worker).toContain("return serveHtml(c.req.raw, c.env);");
    const route = worker.slice(worker.indexOf('app.get("/:entry",'), worker.indexOf('app.get("/assets/*"'));
    expect(route).not.toContain("resolveSharedFile");
    expect(route).not.toContain('c.text("Not found", 404)');
    expect(routes).toContain('return isAdminEntry ? "admin" : "share"');
    expect(client).toContain('const needsAdminCheck = initialRoute === "share"');
    expect(share).toContain("Link unavailable");
    expect(share).toContain('requestJson<Share>("/api/files/" + id)');
  });
});
