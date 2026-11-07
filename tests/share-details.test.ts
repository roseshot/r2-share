import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RequestError, type Share } from "../src/lib";
import { createPlaceholderShare, loadShareDetails } from "../src/share-details";

const id = "Kq8mH2_nP4xY7zQb";

describe("unavailable share presentation", () => {
  test("preserves real share metadata", async () => {
    const share: Share = { id, mode: "protected" };
    const result = await loadShareDetails(id, async url => {
      expect(url).toBe("/api/files/" + id);
      return share;
    });
    expect(result).toEqual({ file: share, isPlaceholder: false });
  });

  test("substitutes randomized file details only for missing shares", async () => {
    const result = await loadShareDetails(id, async () => {
      throw new RequestError("File not found", 404);
    });
    expect(result.isPlaceholder).toBe(true);
    expect(result.file.id).toBe(id);
    expect(result.file.mode).toBe("public");
    expect(result.file.filename).toMatch(/^[a-z]+-[a-z0-9]+\.[a-z0-9]+$/);
    expect(result.file.size).toBeGreaterThanOrEqual(1024);
    expect(result.file.size).toBeLessThan(90 * 1024 * 1024);
    expect(result.file.mime).toBeTruthy();
    expect(Date.parse(result.file.originalModifiedAt!)).toBeLessThan(Date.now());
    expect(result.file.checksums?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const filenames = new Set(Array.from({ length: 8 }, () => createPlaceholderShare(id).filename));
    expect(filenames.size).toBeGreaterThan(1);
  });

  test("keeps other HTTP and network errors visible", async () => {
    for (const error of [new RequestError("Unavailable", 503), new Error("Network error")]) {
      await expect(loadShareDetails(id, async () => { throw error; })).rejects.toBe(error);
    }
  });

  test("disables downloads and previews for placeholder details", () => {
    const share = readFileSync(new URL("../src/share.tsx", import.meta.url), "utf8");
    const preview = readFileSync(new URL("../src/file-preview.tsx", import.meta.url), "utf8");
    expect(share).toContain("if (isPlaceholder || downloadBusy) return;");
    expect(share).toContain("disabled={isPlaceholder || downloadBusy}");
    expect(share).toContain("disabled={isPlaceholder} />");
    expect(preview).toContain("disabled={disabled}");
  });
});
