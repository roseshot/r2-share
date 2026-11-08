import { describe, expect, test } from "bun:test";
import { appendUploads, droppedFiles, MAX_BATCH_FILES, MAX_UPLOAD_BYTES, selectedFiles,
  validateUpload, type DroppedEntry, type UploadEntry } from "../src/upload-queue";

const makeFile = (name: string, size = 4) =>
  new File([new Uint8Array(size)], name, { lastModified: 1234 });

describe("multiple file and folder selection", () => {
  test("selects multiple files and preserves browser-provided folder paths", () => {
    const first = makeFile("one.txt");
    const second = makeFile("two.txt");
    Object.defineProperty(second, "webkitRelativePath", { value: "photos/nested/two.txt" });
    expect(selectedFiles([first, second]).map(file => file.filename))
      .toEqual(["one.txt", "photos/nested/two.txt"]);
  });

  test("validates each file using the existing server-side size and filename limits", () => {
    expect(validateUpload({ file: makeFile("okay.txt"), filename: "folder/okay.txt" })).toBeNull();
    expect(validateUpload({ file: makeFile("zero", 0), filename: "zero" })).toContain("90 MiB");
    expect(validateUpload({ file: makeFile("huge"), filename: "a".repeat(241) })).toContain("240");
    expect(validateUpload({ file: makeFile("fine"), filename: "bad\nname" })).toContain("control");
    const huge = { name: "huge.bin", size: MAX_UPLOAD_BYTES + 1, lastModified: 1 } as File;
    expect(validateUpload({ file: huge, filename: huge.name })).toContain("90 MiB");
  });

  test("adds selections while deduplicating exact same file and rejecting invalid entries", () => {
    const existing: UploadEntry[] = [{ file: makeFile("a.txt"), filename: "folder/a.txt" }];
    const same = { file: makeFile("a.txt"), filename: "folder/a.txt" };
    const distinct = { file: makeFile("a.txt"), filename: "other/a.txt" };
    const invalid = { file: makeFile("bad.txt", 0), filename: "bad.txt" };
    const result = appendUploads(existing, [same, distinct, invalid]);
    expect(result.files.map(item => item.filename)).toEqual(["folder/a.txt", "other/a.txt"]);
    expect(result.rejected).toEqual([{ filename: "bad.txt",
      reason: "File size must be greater than zero and at most 90 MiB" }]);
  });

  test("caps queued files to 500", () => {
    const many = Array.from({ length: MAX_BATCH_FILES + 2 }, (_, index) => ({
      file: makeFile(index + ".txt"), filename: index + ".txt",
    }));
    const result = appendUploads([], many);
    expect(result.files).toHaveLength(MAX_BATCH_FILES);
    expect(result.rejected).toHaveLength(2);
  });

  test("recursively reads dropped directories across multiple readEntries batches", async () => {
    function fileEntry(path: string): DroppedEntry {
      return { isFile: true, isDirectory: false, name: path.split("/").pop()!,
        fullPath: "/" + path, file: resolve => resolve(makeFile(path.split("/").pop()!)) };
    }
    const folder: DroppedEntry = {
      isDirectory: true, isFile: false, name: "folder", fullPath: "/folder",
      createReader: () => {
        let reads = 0;
        return {
          readEntries(resolve) {
            reads += 1;
            resolve(reads === 1 ? [fileEntry("folder/one.txt")] :
              reads === 2 ? [fileEntry("folder/nested/two.txt")] : []);
          },
        };
      },
    };
    const transfer = {
      items: [{ kind: "file", webkitGetAsEntry: () => folder }],
      files: [],
    } as unknown as DataTransfer;
    const result = await droppedFiles(transfer);
    expect(result.map(item => item.filename)).toEqual(["folder/one.txt", "folder/nested/two.txt"]);
  });

  test("includes individual files dropped alongside a folder when entry handles are missing", async () => {
    const folderFile = makeFile("inside.txt");
    const extraFile = makeFile("outside.txt");
    const transfer = {
      items: [
        { kind: "file", webkitGetAsEntry: () => ({
          isFile: true, isDirectory: false, name: "inside.txt", fullPath: "/folder/inside.txt",
          file: (resolve: (file: File) => void) => resolve(folderFile),
        }) },
        { kind: "file", webkitGetAsEntry: () => null, getAsFile: () => extraFile },
      ],
      files: [folderFile, extraFile],
    } as unknown as DataTransfer;
    const result = await droppedFiles(transfer);
    expect(result.map(item => item.filename)).toEqual(["folder/inside.txt", "outside.txt"]);
  });

  test("falls back to normal dropped files when directory entries are unavailable", async () => {
    const transfer = {
      items: [{ kind: "file" }],
      files: [makeFile("one.png"), makeFile("two.png")],
    } as unknown as DataTransfer;
    const result = await droppedFiles(transfer);
    expect(result.map(item => item.filename)).toEqual(["one.png", "two.png"]);
  });

  test("reports directory scanning failures rather than silently uploading a partial tree", async () => {
    const transfer = {
      items: [{ kind: "file", webkitGetAsEntry: () => ({
        isFile: false, isDirectory: true, name: "folder", fullPath: "/folder",
        createReader: () => ({ readEntries(_success: unknown, failure: (error: Error) => void) {
          failure(new Error("Directory access denied"));
        } }),
      }) }],
      files: [],
    } as unknown as DataTransfer;
    expect(droppedFiles(transfer)).rejects.toThrow("Directory access denied");
  });
});
