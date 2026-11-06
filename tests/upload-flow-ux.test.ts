import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = (file: string) => readFileSync(new URL("../" + file, import.meta.url), "utf8");

describe("upload completion experience", () => {
  test("provides a persistent, copyable link and access code after upload", () => {
    const admin = source("src/admin.tsx");
    expect(admin).toContain("setUploadResults([...succeeded])");
    expect(admin).toContain("uploadResults.map(result =>");
    expect(admin).toContain("setSelected(failed)");
    expect(admin).toContain('aria-label="Upload result"');
    expect(admin).toContain("Copy link");
    expect(admin).toContain("Copy access code");
    expect(admin).toContain("Open link");
  });
  test("selects multiple files or folders and supports dropping recursive directory trees", () => {
    const admin = source("src/admin.tsx");
    const queue = source("src/upload-queue.ts");
    expect(admin).toContain('id="upload-file"');
    expect(admin).toContain('id="upload-folder"');
    expect(admin).toContain('type="file" multiple');
    expect(admin).toContain('setAttribute("webkitdirectory", "")');
    expect(admin).toContain("onDrop={event =>");
    expect(admin).toContain("droppedFiles(event.dataTransfer)");
    expect(admin).toContain("Clear queue");
    expect(queue).toContain("readEntries(resolve, reject)");
  });

  test("uploads one file at a time and retains independent share links and errors", () => {
    const admin = source("src/admin.tsx");
    expect(admin).toContain("for (const [index, entry] of batch.entries())");
    expect(admin).toContain("filename: entry.filename, size: entry.file.size");
    expect(admin).toContain("xhr.send(entry.file)");
    expect(admin).toContain("setUploadResults([...succeeded])");
    expect(admin).toContain("setUploadFailures([...failures])");
    expect(admin).toContain("setSelected(failed)");
    expect(admin).toContain("setOverallProgress(");
    expect(admin).toContain('aria-label="Upload errors"');
  });

  test("shows processing state without suggesting a completed upload", () => {
    const admin = source("src/admin.tsx");
    expect(admin).toContain("xhr.upload.onprogress");
    expect(admin).toContain("setProcessing(true)");
    expect(admin).toContain("Processing file…");
  });
  test("guides first-time users to the storage settings form", () => {
    const admin = source("src/admin.tsx");
    const settings = source("src/admin-settings.tsx");
    expect(admin).toContain("Configure storage");
    expect(admin).toContain("scrollIntoView");
    expect(settings).toContain('id="object-storage-settings"');
    expect(settings).toContain("aria-label={label}");
  });
});
