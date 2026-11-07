import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isArchiveFile, previewFormat } from "../src/preview-types";

describe("safe file format selection", () => {
  test("places cached VirusTotal results immediately below File preview, above SHA-256", () => {
    const share = readFileSync(new URL("../src/share.tsx", import.meta.url), "utf8");
    const preview = share.indexOf("<FilePreview ");
    const virusTotal = share.indexOf('aria-label="VirusTotal reputation"');
    const sha256 = share.indexOf("<FileChecksums ");
    const download = share.indexOf('onClick={() => void download()}');
    expect(preview).toBeGreaterThanOrEqual(0);
    expect(virusTotal).toBeGreaterThan(preview);
    expect(virusTotal).toBeLessThan(sha256);
    expect(sha256).toBeLessThan(download);
    expect(share).toContain("file.checksums && file.virusTotal &&");
    expect(share).toContain('file.virusTotal?.status === "found"');
    expect(share).toContain("View on VirusTotal");
  });

  test("uses a generic server overloaded message for public download errors", () => {
    const share = readFileSync(new URL("../src/share.tsx", import.meta.url), "utf8");
    expect(share).toContain("Server overloaded. Please try again.");
    expect(share).not.toContain("Download unavailable. Please try again.");
    expect(share).toContain("Access expired. Enter the access code again.");
  });

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

  test("loads preview content on first open and hides it without unmounting", () => {
    const source = readFileSync(new URL("../src/file-preview.tsx", import.meta.url), "utf8");
    expect(source).toContain("const [activated, setActivated] = useState(false)");
    expect(source).toContain("setActivated(true)");
    expect(source).toContain('activated && <div id="preview-details" hidden={!opened}');
    expect(source).not.toContain('{opened && <div id="preview-details"');
    expect(source).toContain('src={previewURL}');
    expect(source).toContain('aria-expanded={opened}');
  });

  test("reuses successful text previews and lets failed previews retry", () => {
    const source = readFileSync(new URL("../src/file-preview.tsx", import.meta.url), "utf8");
    expect(source).toContain('if (!activated || format?.kind !== "text" || text !== null || error) return;');
    expect(source).toContain('if (!controller.signal.aborted) setText(content.slice(0, 200000))');
    expect(source).toContain('[activated, format?.kind, file.size, previewURL, text, error]');
    expect(source).not.toContain('[opened, format?.kind');
    expect(source).toContain('if (error) setError("")');
    expect(source).toContain('cache: "no-store"');
  });

  test("pauses playing audio and video when collapsed and resets on a different file", () => {
    const source = readFileSync(new URL("../src/file-preview.tsx", import.meta.url), "utf8");
    const share = readFileSync(new URL("../src/share.tsx", import.meta.url), "utf8");
    expect(source).toContain("audioRef.current?.pause()");
    expect(source).toContain("videoRef.current?.pause()");
    expect(source).toContain("<audio ref={audioRef}");
    expect(source).toContain("<video ref={videoRef}");
    expect(share).toContain('key={[id, file.filename, file.size, file.checksums?.sha256].join(":")}');
  });

  test("archive preview code never downloads or parses archives", () => {
    const component = readFileSync(new URL("../src/file-preview.tsx", import.meta.url), "utf8");
    expect(component).not.toContain('from "./archive"');
    expect(component).not.toContain('fetch("/api/files/" + id + "/download"');
    expect(component).toContain('href={"/api/files/" + id + "/download"}');
    expect(component).not.toContain("readArchiveDirectory");
    expect(component).not.toContain("Archive contents");
    expect(component).toContain('"/preview"');
    const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
    expect(worker.indexOf('if (preview && (!format || !format.contentType))'))
      .toBeLessThan(worker.indexOf("const store = getObjectStore(env, record.storageId)"));
  });
});
