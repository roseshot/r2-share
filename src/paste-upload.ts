import type { UploadEntry } from "./upload-queue";

export function pasteIsEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest(
    "input, textarea, select, [contenteditable], [role='textbox']"));
}

export function clipboardUploads(clipboard: DataTransfer, now = Date.now()): UploadEntry[] {
  const files = Array.from(clipboard.files);
  if (files.length) {
    return files.map((file, index) => ({
      file,
      filename: file.name || "pasted-file-" + (index + 1),
    }));
  }
  const text = clipboard.getData("text/plain");
  if (!text) return [];
  const timestamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const filename = "pasted-text-" + timestamp + ".txt";
  const file = new File([text], filename, { type: "text/plain", lastModified: now });
  return [{ file, filename }];
}
