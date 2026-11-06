import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { readArchiveDirectory, readTarDirectory, readZipDirectory } from "../src/archive";
import { previewFormat } from "../src/preview-types";

const encoder = new TextEncoder();

function zipDirectory(names: string[], encrypted = false): Uint8Array {
  const namesBytes = names.map(name => encoder.encode(name));
  const directorySize = namesBytes.reduce((sum, bytes) => sum + 46 + bytes.length, 0);
  const out = new Uint8Array(directorySize + 22);
  const data = new DataView(out.buffer);
  let pos = 0;
  namesBytes.forEach(bytes => {
    data.setUint32(pos, 0x02014b50, true);
    data.setUint16(pos + 8, encrypted ? 1 : 0, true);
    data.setUint16(pos + 10, 8, true);
    data.setUint32(pos + 24, 42, true);
    data.setUint16(pos + 28, bytes.length, true);
    out.set(bytes, pos + 46);
    pos += bytes.length + 46;
  });
  data.setUint32(pos, 0x06054b50, true);
  data.setUint16(pos + 8, names.length, true);
  data.setUint16(pos + 10, names.length, true);
  data.setUint32(pos + 12, directorySize, true);
  data.setUint32(pos + 16, 0, true);
  return out;
}

function tarDirectory(): Uint8Array {
  const out = new Uint8Array(1024);
  out.set(encoder.encode("docs/readme.txt"), 0);
  out.set(encoder.encode("00000000000\0"), 124);
  out.set(encoder.encode("ustar\0"), 257);
  return out;
}

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

  test("only lists supported archives and leaves unsupported types unchanged", () => {
    expect(previewFormat("report.ZIP")?.kind).toBe("zip");
    expect(previewFormat("backup.tar")?.kind).toBe("tar");
    expect(previewFormat("backup.tar.gz")?.kind).toBe("tgz");
    expect(previewFormat("backup.tgz")?.kind).toBe("tgz");
    expect(previewFormat("backup.7z")).toBeNull();
    expect(previewFormat("backup.rar")).toBeNull();
    expect(previewFormat("malware.exe")).toBeNull();
  });
});

describe("unencrypted archive directory listing", () => {
  test("lists ZIP entries without extracting files", () => {
    const zip = readZipDirectory(zipDirectory(["docs/", "docs/readme.txt", "photo.jpg"]));
    expect(zip).toEqual({
      total: 3, truncated: false,
      entries: [
        { name: "docs/", size: 42, directory: true },
        { name: "docs/readme.txt", size: 42, directory: false },
        { name: "photo.jpg", size: 42, directory: false },
      ],
    });
  });

  test("rejects encrypted and damaged ZIP archives", () => {
    expect(() => readZipDirectory(zipDirectory(["secret.txt"], true))).toThrow("Password-protected");
    expect(() => readZipDirectory(new Uint8Array(20))).toThrow("Invalid ZIP");
    const zip = zipDirectory(["note.txt"]);
    zip[0] = 0;
    expect(() => readZipDirectory(zip)).toThrow("Invalid ZIP directory entry");
  });

  test("bounds the number of listed ZIP entries", () => {
    const files = Array.from({ length: 207 }, (_, index) => "item-" + index + ".txt");
    const result = readZipDirectory(zipDirectory(files));
    expect(result.total).toBe(207);
    expect(result.entries).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  test("lists a valid TAR and a gzipped TAR without executing contents", async () => {
    const tar = tarDirectory();
    expect(readTarDirectory(tar).entries).toEqual([
      { name: "docs/readme.txt", size: 0, directory: false },
    ]);
    const zipped = gzipSync(tar);
    const result = await readArchiveDirectory(new Blob([zipped]), "tgz");
    expect(result.entries).toEqual([
      { name: "docs/readme.txt", size: 0, directory: false },
    ]);
  });

  test("rejects truncated TAR streams", () => {
    const data = tarDirectory().slice(0, 513);
    expect(() => readTarDirectory(data)).toThrow("Invalid TAR");
  });
});
