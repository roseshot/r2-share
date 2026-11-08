/** Each queue item becomes an independent file and share link. */
export interface UploadEntry {
  file: File;
  filename: string;
}

export const MAX_BATCH_FILES = 500;
export const MAX_UPLOAD_BYTES = 90 * 1024 * 1024;
export const MAX_FILENAME_LENGTH = 240;

export function selectedFiles(files: Iterable<File>): UploadEntry[] {
  return Array.from(files, file => ({
    file,
    filename: file.webkitRelativePath || file.name,
  }));
}

export function validateUpload(entry: UploadEntry): string | null {
  if (!entry.filename || entry.filename.length > MAX_FILENAME_LENGTH ||
      /[\x00-\x1f\x7f]/.test(entry.filename)) {
    return "File path must be 1–240 characters without control characters";
  }
  if (!entry.file.size || entry.file.size > MAX_UPLOAD_BYTES) {
    return "File size must be greater than zero and at most 90 MiB";
  }
  return null;
}

export function appendUploads(existing: UploadEntry[], incoming: UploadEntry[]) {
  const seen = new Set(existing.map(entry =>
    entry.filename + "\u0000" + entry.file.size + "\u0000" + entry.file.lastModified));
  const files = [...existing];
  const rejected: { filename: string; reason: string }[] = [];
  for (const entry of incoming) {
    const key = entry.filename + "\u0000" + entry.file.size + "\u0000" + entry.file.lastModified;
    if (seen.has(key)) continue;
    const reason = validateUpload(entry);
    if (reason) {
      rejected.push({ filename: entry.filename, reason });
      continue;
    }
    if (files.length >= MAX_BATCH_FILES) {
      rejected.push({ filename: entry.filename, reason: "Batch limit of 500 files reached" });
      continue;
    }
    seen.add(key);
    files.push(entry);
  }
  return { files, rejected };
}

export type DroppedEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (success: (file: File) => void, failure: (error: DOMException) => void) => void;
  createReader?: () => {
    readEntries: (success: (entries: DroppedEntry[]) => void,
      failure: (error: DOMException) => void) => void;
  };
};

async function collectEntry(entry: DroppedEntry, results: UploadEntry[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
    if (results.length >= MAX_BATCH_FILES) throw new Error("A selection may contain at most 500 files");
    results.push({ file, filename: entry.fullPath.replace(/^\/+/, "") || file.name });
    return;
  }
  if (!entry.isDirectory || !entry.createReader) return;
  const reader = entry.createReader();
  // readEntries() can return as few as 100 entries at a time.
  while (true) {
    const batch = await new Promise<DroppedEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) await collectEntry(child, results);
  }
}

/** Call synchronously inside the drop handler so directory handles remain accessible. */
export async function droppedFiles(transfer: DataTransfer): Promise<UploadEntry[]> {
  const items = Array.from(transfer.items).filter(item => item.kind === "file");
  const entries = items.map(item =>
    typeof item.webkitGetAsEntry === "function" ?
      item.webkitGetAsEntry() as DroppedEntry | null : null);
  if (entries.some(Boolean)) {
    const results: UploadEntry[] = [];
    for (const [index, entry] of entries.entries()) {
      if (entry) {
        await collectEntry(entry, results);
      } else {
        const file = items[index].getAsFile();
        if (file) {
          if (results.length >= MAX_BATCH_FILES) throw new Error("A selection may contain at most 500 files");
          results.push({ file, filename: file.name });
        }
      }
    }
    return results;
  }
  return selectedFiles(Array.from(transfer.files));
}
