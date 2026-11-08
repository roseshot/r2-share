import { zipSync } from "fflate";
import { MAX_BATCH_FILES, MAX_UPLOAD_BYTES, type UploadEntry } from "./upload-queue";

export interface FolderSource {
  file: File;
  filename: string;
}

/** Convert each directory root into a single ZIP while leaving loose files alone. */
export async function archiveFolders(entries: FolderSource[]): Promise<UploadEntry[]> {
  const folders = new Map<string, FolderSource[]>();
  const loose: UploadEntry[] = [];

  for (const entry of entries) {
    const parts = entry.filename.replaceAll("\\", "/").split("/");
    if (parts.length < 2) {
      loose.push({ file: entry.file, filename: entry.file.name });
      continue;
    }
    if (parts.some(part => !part || part === "." || part === "..")) {
      throw new Error("Invalid folder path: " + entry.filename);
    }
    const [root] = parts;
    const found = folders.get(root) ?? [];
    found.push({ file: entry.file, filename: parts.slice(1).join("/") });
    folders.set(root, found);
  }

  for (const [name, files] of folders) {
    if (files.length > MAX_BATCH_FILES) throw new Error("Folder exceeds the 500-file limit: " + name);
    const archiveName = name + ".zip";
    if (archiveName.length > 240) throw new Error("Folder name is too long: " + name);
    const total = files.reduce((sum, item) => sum + item.file.size, 0);
    if (total > MAX_UPLOAD_BYTES) {
      throw new Error("Folder exceeds the 90 MiB uncompressed limit: " + name);
    }
    // Do not zip more bytes than the Worker can accept; memory stays bounded.
    const contents: Record<string, Uint8Array> = Object.create(null);
    for (const { file, filename } of files) {
      if (Object.hasOwn(contents, filename)) {
        throw new Error("Duplicate path in folder: " + filename);
      }
      contents[filename] = new Uint8Array(await file.arrayBuffer());
    }
    const archive = zipSync(contents, { level: 1 });
    if (archive.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error("Compressed ZIP exceeds the 90 MiB upload limit: " + name);
    }
    const zipFile = new File([new Uint8Array(archive)], archiveName,
      { type: "application/zip", lastModified: Date.now() });
    loose.push({ file: zipFile, filename: archiveName });
  }
  return loose;
}
