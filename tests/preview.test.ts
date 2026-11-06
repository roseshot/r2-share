import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isArchiveFile, previewFormat } from "../src/preview-types";

describe("safe file format selection", () => {
  test("supports common image, PDF, text, audio and video previews", () => {
    expect(previewFormat("photo.jpeg")?.contentType).toBe("image/jpeg");
    expect(previewFormat("report.pdf")?.contentType).toBe("application/pdf");
    expect(previewFormat("notes.md")?.contentType).toBe("text/plain; charset=utf-8");
    expect(previewFormat("website.html")?.contentType).toBe("text/plain; charset=utf-8");
    expect(previewFormat("code.js")?.contentType).toBe("text/plain; charset=utf-8");
    expect(previewFormat("icon.svg")?.contentType).toBe("text/plain; charset=utf-8");
    expect(previewFormat("track.mp3")?.kind).toBe("audio");
    expect(previewFormat("movie.mp4")?.kind).toBe("video");
  });

  test("never previews archives, including archives with misleading MIME types", () => {
    for (const name of [
      "report.ZIP", "backup.tar", "backup.tar.gz", "backup.tgz",
      "backup.gz", "backup.7z", "backup.rar",
    ]) {
      expect(isArchiveFile(name), name).toBe(true);
      expect(previewFormat(name), name).toBeNull();
      expect(previewFormat(name, "image/png"), name).toBeNull();
    }
    for (const mime of [
      "application/zip", "application/x-zip-compressed",
      "application/x-tar", "application/gzip", "application/x-gzip",
      "application/x-7z-compressed", "application/vnd.rar",
      "application/x-rar-compressed",
    ]) {
      expect(isArchiveFile("unknown-file", mime), mime).toBe(true);
      expect(previewFormat("unknown-file", mime), mime).toBeNull();
      expect(previewFormat("photo.png", mime), mime).toBeNull();
    }
    expect(previewFormat("malware.exe")).toBeNull();
  });

  test("archive preview code never downloads or parses archives", () => {
    const component = readFileSync(new URL("../src/file-preview.tsx", import.meta.url), "utf8");
    expect(component).not.toContain('from "./archive"');
    expect(component).not.toContain('"/download"');
    expect(component).not.toContain("readArchiveDirectory");
    expect(component).not.toContain("Archive contents");
    expect(component).toContain('"/preview"');
    const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
    expect(worker.indexOf('if (preview && (!format || !format.contentType))'))
      .toBeLessThan(worker.indexOf("getObjectStore(env, record.storageId).get(dataKey(record.id))"));
  });
});
