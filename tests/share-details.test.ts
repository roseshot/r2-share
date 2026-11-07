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
    expect(result.file.filename).toMatch(/\.(pdf|jpg|zip|txt|mp4|xlsx)$/);
    expect(result.file.size).toBeGreaterThanOrEqual(1024);
    expect(result.file.size).toBeLessThan(90 * 1024 * 1024);
    expect(result.file.mime).toBeTruthy();
    expect(Date.parse(result.file.originalModifiedAt!)).toBeLessThan(Date.now());
    expect(result.file.checksums?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const filenames = new Set(Array.from({ length: 8 }, () => createPlaceholderShare(id).filename));
    expect(filenames.size).toBeGreaterThan(1);
  });

  test("uses familiar filenames consistent with the file type and date", () => {
    const values = new Uint32Array(12);
    const expected = [
      ["Project Proposal.pdf", /^Annual Report \\d{4}\\.pdf$/],
      [/^IMG_\\d{8}_\\d{6}\\.jpg$/, "Beach Sunset.jpg"],
      [/^Website Backup \\d{4}-\\d{2}-\\d{2}\\.zip$/, /^Family Photos \\d{4}\\.zip$/],
      [/^Meeting Notes \\d{4}-\\d{2}-\\d{2}\\.txt$/, "Shopping List.txt"],
      [/^Screen Recording \\d{4}-\\d{2}-\\d{2}\\.mp4$/, "Birthday Party.mp4"],
      [/^Monthly Budget \\d{4}-\\d{2}\\.xlsx$/, /^Expense Report \\d{4}\\.xlsx$/],
    ] as const;
    const extensions = ["pdf", "jpg", "zip", "txt", "mp4", "xlsx"];
    const sizes = [
      [16 * 1024, 8 * 1024 * 1024],
      [150 * 1024, 10 * 1024 * 1024],
      [1024 * 1024, 85 * 1024 * 1024],
      [1024, 64 * 1024],
      [6 * 1024 * 1024, 88 * 1024 * 1024],
      [12 * 1024, 4 * 1024 * 1024],
    ];
    for (let category = 0; category < expected.length; category++) {
      values[0] = category;
      for (let variant = 0; variant < 6; variant++) {
        values[1] = variant;
        const file = createPlaceholderShare(id, values);
        expect(file.filename?.endsWith("." + extensions[category])).toBe(true);
        expect(file.size).toBeGreaterThanOrEqual(sizes[category][0]);
        expect(file.size).toBeLessThanOrEqual(sizes[category][1]);
        if (variant < 2) {
          const pattern = expected[category][variant];
          if (typeof pattern === "string") expect(file.filename).toBe(pattern);
          else expect(file.filename).toMatch(pattern);
        }
      }
    }
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
