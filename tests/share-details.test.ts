import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sizeText } from "../src/lib";
import { createPlaceholderShare, generatePlaceholderShare } from "../worker/placeholder-share";

const id = "Kq8mH2_nP4xY7zQb";
const secret = "test-session-secret-for-placeholder-metadata";

describe("server-generated missing share metadata", () => {
  test("is stable across repeated requests and independent Worker instances", async () => {
    const first = await generatePlaceholderShare(id, secret);
    const second = await generatePlaceholderShare(id, secret);
    expect(second).toEqual(first);
    expect(await generatePlaceholderShare("OtherMissingID99", secret)).not.toEqual(first);
    expect(await generatePlaceholderShare(id, secret + "rotated")).not.toEqual(first);
    expect(first).toMatchObject({ id, mode: "public" });
    expect(first.filename).toMatch(/\.(pdf|jpg|zip|txt|mp4|xlsx)$/);
    expect(first.checksums?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(first.originalModifiedAt!)).toBeLessThan(Date.now());
    expect(first.size).toBeGreaterThan(0);
    expect(first.size).toBeLessThan(1024 ** 4);
  });

  test("uses familiar filenames, type-aware sizes and the existing size ceiling", () => {
    const variants = [
      { ext: "pdf", mime: "application/pdf", typical: [60 * 1024, 256 * 1024] },
      { ext: "jpg", mime: "image/jpeg", typical: [500 * 1024, 2 * 1024 ** 2] },
      { ext: "zip", mime: "application/zip", typical: [1024 ** 2, 8 * 1024 ** 2] },
      { ext: "txt", mime: "text/plain", typical: [400, 2 * 1024] },
      { ext: "mp4", mime: "video/mp4", typical: [12 * 1024 ** 2, 64 * 1024 ** 2] },
      { ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        typical: [16 * 1024, 80 * 1024] },
    ];
    const values = new Uint32Array(12);
    for (let type = 0; type < variants.length; type++) {
      values[0] = type;
      for (let variant = 0; variant < 10; variant++) {
        values[1] = variant;
        values[4] = variant * 31;
        values[5] = variant * 7;
        const share = createPlaceholderShare(id, values);
        expect(share.filename).toMatch(new RegExp("\\." + variants[type].ext + "$"));
        expect(share.mime).toBe(variants[type].mime);
        expect(share.size).toBeGreaterThan(0);
        expect(share.size).toBeLessThan(1024 ** 4);
        expect(sizeText(share.size!)).not.toMatch(/TiB|PiB/);
      }
      values[2] = 0x80000000;
      const typical = createPlaceholderShare(id, values).size!;
      expect(typical).toBeGreaterThanOrEqual(variants[type].typical[0]);
      expect(typical).toBeLessThanOrEqual(variants[type].typical[1]);
      values[2] = 0xffffffff;
      values[6] = 0xffffffff;
      expect(createPlaceholderShare(id, values).size).toBeLessThanOrEqual(999 * 1024 ** 3);
      values[2] = 0;
      values[6] = 0;
    }
    values[0] = 1;
    values[1] = 0;
    values[4] = 287;
    expect(createPlaceholderShare(id, values).filename).toBe("IMG_1287.jpg");
    values[1] = 2;
    expect(createPlaceholderShare(id, values).filename).toMatch(/^PXL_\d{8}_\d{9}\.jpg$/);
    values[0] = 3;
    values[1] = 4;
    expect(createPlaceholderShare(id, values).filename).toMatch(/\(1\)\.txt$/);
  });

  test("does not perform browser-side decoy generation or persist fake data", () => {
    const frontend = readFileSync(new URL("../src/share.tsx", import.meta.url), "utf8");
    const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
    expect(frontend).toContain('requestJson<Share>("/api/files/" + id)');
    expect(frontend).not.toContain("isPlaceholder");
    expect(frontend).not.toContain("localStorage");
    expect(worker).toContain("generatePlaceholderShare(id, c.env.SESSION_SECRET)");
    expect(worker).toContain('return c.json(await generatePlaceholderShare(id, c.env.SESSION_SECRET))');
    expect(worker).toContain("if (!result) {");
  });
});
