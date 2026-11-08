import { describe, expect, test } from "bun:test";
import { unzipSync, strFromU8 } from "fflate";
import { archiveFolders } from "../src/folder-zip";
import { clipboardUploads } from "../src/paste-upload";
import { MAX_UPLOAD_BYTES } from "../src/upload-queue";

const file = (name: string, content: string) => new File([content], name, { type: "text/plain" });

describe("folder uploads become ZIP archives", () => {
  test("preserves nested paths and file bytes inside one ZIP per folder", async () => {
    const result = await archiveFolders([
      { file: file("a.txt", "hello"), filename: "Photos/a.txt" },
      { file: file("b.txt", "nested"), filename: "Photos/Travel/b.txt" },
      { file: file("loose.txt", "plain"), filename: "loose.txt" },
    ]);
    expect(result).toHaveLength(2);
    expect(result.map(item => item.filename)).toEqual(["loose.txt", "Photos.zip"]);
    expect(result[1].file.type).toBe("application/zip");
    const decoded = unzipSync(new Uint8Array(await result[1].file.arrayBuffer()));
    expect(strFromU8(decoded["a.txt"])).toBe("hello");
    expect(strFromU8(decoded["Travel/b.txt"])).toBe("nested");
    expect(Object.keys(decoded)).toHaveLength(2);
  });

  test("creates separate archives for different folder roots", async () => {
    const result = await archiveFolders([
      { file: file("a.txt", "a"), filename: "One/a.txt" },
      { file: file("b.txt", "b"), filename: "Two/b.txt" },
    ]);
    expect(result.map(item => item.filename)).toEqual(["One.zip", "Two.zip"]);
  });

  test("rejects traversal paths, duplicate names, and oversized folders", async () => {
    expect(archiveFolders([{ file: file("a.txt", "a"), filename: "Bad/../a.txt" }]))
      .rejects.toThrow("Invalid folder path");
    expect(archiveFolders([
      { file: file("a.txt", "a"), filename: "Dir/a.txt" },
      { file: file("a.txt", "a"), filename: "Dir/a.txt" },
    ])).rejects.toThrow("Duplicate path");
    const huge = { name: "large.bin", size: MAX_UPLOAD_BYTES + 1 } as File;
    expect(archiveFolders([{ file: huge, filename: "Folder/large.bin" }]))
      .rejects.toThrow("90 MiB");
  });
});

describe("clipboard uploads", () => {
  test("pastes plain text as a named UTF-8 text file", async () => {
    const data = {
      files: [],
      getData: (type: string) => type === "text/plain" ? "hello\nworld" : "",
    } as unknown as DataTransfer;
    const result = clipboardUploads(data, Date.UTC(2026, 10, 7, 12, 30));
    expect(result).toHaveLength(1);
    expect(result[0].filename).toMatch(/^pasted-text-.*\.txt$/);
    expect(result[0].file.type).toStartWith("text/plain");
    expect(await result[0].file.text()).toBe("hello\nworld");
  });

  test("prefers clipboard image/file data over accompanying text", () => {
    const image = new File(["img"], "image.png", { type: "image/png" });
    const data = {
      files: [image],
      getData: () => "fallback text",
    } as unknown as DataTransfer;
    const result = clipboardUploads(data);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe(image);
    expect(result[0].filename).toBe("image.png");
  });

  test("does not create an empty file for a clipboard without usable contents", () => {
    const data = { files: [], getData: () => "" } as unknown as DataTransfer;
    expect(clipboardUploads(data)).toEqual([]);
  });
});
