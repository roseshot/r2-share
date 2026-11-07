import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RequestError, sizeText, type Share } from "../src/lib";
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
    expect(result.file.size).toBeGreaterThan(0);
    expect(Number.isSafeInteger(result.file.size)).toBe(true);
    expect(result.file.mime).toBeTruthy();
    expect(Date.parse(result.file.originalModifiedAt!)).toBeLessThan(Date.now());
    expect(result.file.checksums?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const filenames = new Set(Array.from({ length: 8 }, () => createPlaceholderShare(id).filename));
    expect(filenames.size).toBeGreaterThan(1);
  });

  test("generates everyday filenames with camera, date, version, and duplicate conventions", () => {
    const samples = [
      { extension: "pdf", mime: "application/pdf", typical: [60 * 1024, 256 * 1024] },
      { extension: "jpg", mime: "image/jpeg", typical: [500 * 1024, 2 * 1024 * 1024] },
      { extension: "zip", mime: "application/zip", typical: [1024 * 1024, 8 * 1024 * 1024] },
      { extension: "txt", mime: "text/plain", typical: [400, 2 * 1024] },
      { extension: "mp4", mime: "video/mp4", typical: [12 * 1024 * 1024, 64 * 1024 * 1024] },
      { extension: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        typical: [16 * 1024, 80 * 1024] },
    ];
    const values = new Uint32Array(12);
    const variants = 10;
    for (let category = 0; category < samples.length; category++) {
      const format = samples[category];
      values[0] = category;
      for (let variant = 0; variant < variants; variant++) {
        values[1] = variant;
        values[4] = variant * 31;
        values[5] = variant * 7;
        const file = createPlaceholderShare(id, values);
        expect(file.mime).toBe(format.mime);
        expect(file.filename?.endsWith("." + format.extension)).toBe(true);
        expect(file.filename).not.toContain("undefined");
        expect(file.filename).not.toContain("/");
        expect(file.filename).not.toContain("\\");
        expect(file.filename).not.toMatch(/[<>:"|?*]/);
        expect(Number.isSafeInteger(file.size)).toBe(true);
        expect(file.size).toBeGreaterThan(0);
      }
      values[2] = 0x80000000;
      values[6] = 0;
      const typicalSize = createPlaceholderShare(id, values).size!;
      expect(typicalSize).toBeGreaterThanOrEqual(format.typical[0]);
      expect(typicalSize).toBeLessThanOrEqual(format.typical[1]);
      values[2] = 0;
      values[6] = 0;
    }
    values[0] = 1;
    values[1] = 0;
    values[4] = 287;
    expect(createPlaceholderShare(id, values).filename).toBe("IMG_1287.jpg");
    values[1] = 2;
    expect(createPlaceholderShare(id, values).filename).toMatch(/^PXL_\d{8}_\d{9}\.jpg$/);
    values[0] = 0;
    values[1] = 3;
    expect(createPlaceholderShare(id, values).filename).toMatch(/proposal v[2-5]\.pdf$/);
    values[0] = 3;
    values[1] = 4;
    expect(createPlaceholderShare(id, values).filename).toMatch(/\(1\)\.txt$/);
  });

  test("does not cap placeholder sizes at previous per-format limits", () => {
    const oldCaps = [4 * 1024 ** 2, 5 * 1024 ** 2, 40 * 1024 ** 2,
      12 * 1024, 88 * 1024 ** 2, 800 * 1024];
    const values = new Uint32Array(12);
    for (let index = 0; index < oldCaps.length; index++) {
      values[0] = index;
      values[2] = 0xffffffff;
      values[6] = 0xffffffff;
      const size = createPlaceholderShare(id, values).size!;
      expect(size).toBeGreaterThan(oldCaps[index]);
      expect(Number.isSafeInteger(size)).toBe(true);
    }
  });

  test("never displays TiB or larger units for simulated files", () => {
    const values = new Uint32Array(12);
    values[2] = 0xffffffff;
    values[6] = 0xffffffff;
    for (let category = 0; category < 6; category++) {
      values[0] = category;
      const size = createPlaceholderShare(id, values).size!;
      expect(size).toBeLessThan(1024 ** 4);
      expect(size).toBeLessThanOrEqual(999 * 1024 ** 3);
      expect(sizeText(size).endsWith("GiB")).toBe(true);
    }
    for (let category = 0; category < 6; category++) {
      values[0] = category;
      for (let index = 0; index < 100; index++) {
        values[2] = Math.floor(index * (0xffffffff / 99));
        values[6] = index * 42949673;
        const size = createPlaceholderShare(id, values).size!;
        expect(size).toBeLessThan(1024 ** 4);
        expect(sizeText(size)).not.toMatch(/TiB|PiB/);
      }
    }
  });

  test("larger random quantiles produce larger files within each type", () => {
    const values = new Uint32Array(12);
    for (let category = 0; category < 6; category++) {
      values[0] = category;
      values[2] = 0x40000000;
      const smaller = createPlaceholderShare(id, values).size!;
      values[2] = 0xc0000000;
      const larger = createPlaceholderShare(id, values).size!;
      expect(larger).toBeGreaterThan(smaller);
    }
  });

  test("formats large file sizes in natural binary units", () => {
    expect(sizeText(512)).toBe("512 B");
    expect(sizeText(2048)).toBe("2.0 KiB");
    expect(sizeText(3 * 1024 ** 2)).toBe("3.0 MiB");
    expect(sizeText(2 * 1024 ** 3)).toBe("2.0 GiB");
    expect(sizeText(4 * 1024 ** 4)).toBe("4.0 TiB");
  });

  test("varies the subject inside the same filename pattern", () => {
    const values = new Uint32Array(12);
    values[0] = 4;
    values[1] = 2;
    const first = createPlaceholderShare(id, values).filename;
    values[4] = 1;
    const second = createPlaceholderShare(id, values).filename;
    expect(first).not.toBe(second);
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
