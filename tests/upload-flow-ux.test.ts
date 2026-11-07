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

  test("compresses folder selections but keeps individual files separate", () => {
    const admin = source("src/admin.tsx");
    const zip = source("src/folder-zip.ts");
    expect(admin).toContain("await archiveFolders(selectedFiles(files))");
    expect(admin).toContain("addToQueue(await archiveFolders(entries))");
    expect(zip).toContain("zipSync(contents");
    expect(zip).toContain('type: "application/zip"');
    expect(zip).toContain("MAX_UPLOAD_BYTES");
  });

  test("supports paste uploads without hijacking editable fields", () => {
    const admin = source("src/admin.tsx");
    const paste = source("src/paste-upload.ts");
    expect(admin).toContain('window.addEventListener("paste", handlePaste)');
    expect(admin).toContain('pasteIsEditing(event.target)');
    expect(admin).toContain("clipboardUploads(event.clipboardData)");
    expect(paste).toContain('clipboard.getData("text/plain")');
    expect(paste).toContain("Array.from(clipboard.files)");
  });

  test("keeps inline filename Save/Cancel but auto-saves file deletion when selected", () => {
    const admin = source("src/admin.tsx");
    const worker = source("worker/index.ts");
    const cards = admin.slice(admin.indexOf("{files.map(record =>"), admin.indexOf('<nav aria-label="File pages"'));
    expect(cards).toContain('editId === record.id && editKind === "name"');
    expect(cards).toContain('editId === record.id && editKind === "expiration"');
    expect(cards).toContain('<form onSubmit={updateRecord} aria-label={"Rename " + record.filename}');
    expect(cards).toContain('<Input id="edit-filename" autoFocus required');
    expect(cards).toContain('<div role="group" aria-label={"Edit file deletion period for " + record.filename}');
    expect(cards).toContain('<Select id="edit-file-expiration"');
    expect(cards).toContain('onValueChange={value => {');
    expect(cards).toContain('void updateFileExpiration(record, Number(value))');
    expect(cards).toContain('label: duration.seconds === 0 ? "Never" : duration.label');
    expect(cards).toContain('File deletion: {timeText(record.fileExpiresAt)}');
    expect(cards.match(/onSubmit={updateRecord}/g)).toHaveLength(1);
    expect(cards.match(/onClick={cancelEdit}>Cancel/g)).toHaveLength(1);
    expect(cards.match(/Saving…" : "Save"/g)).toHaveLength(1);
    expect(cards).not.toContain(">Settings</Button>");
    expect(cards).not.toContain("mt-5 space-y-4 rounded-xl");
    expect(cards.indexOf('<Input id="edit-filename"')).toBeLessThan(cards.indexOf('<Badge variant="muted">'));
    expect(cards.indexOf('<Select id="edit-file-expiration"')).toBeLessThan(cards.indexOf('<AdminShares'));
    expect(admin).toContain('jsonBody({ filename: name })');
    expect(admin).toContain('jsonBody({ fileExpiresIn: seconds })');
    expect(admin).toContain('if (saving || !durations.some(duration => duration.seconds === seconds)) return');
    expect(admin).toContain('setEditError((e as Error).message)');
    expect(cards).toContain('{saving && <span role="status">Saving…</span>}');
    expect(worker).toContain('record.filename = (body.filename as string).trim()');
    expect(worker).toContain('record.expiresAt = expirationDate(body.fileExpiresIn as number)');
    expect(worker).not.toContain('"fileExpiresAt"');
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
