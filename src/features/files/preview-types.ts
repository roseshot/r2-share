export type PreviewKind = "image" | "pdf" | "text" | "audio" | "video";

const image: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", avif: "image/avif",
};
const audio: Record<string, string> = {
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
  flac: "audio/flac", aac: "audio/aac",
};
const video: Record<string, string> = {
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4",
};
const textExtensions = new Set([
  "txt", "md", "csv", "json", "xml", "html", "htm", "css", "js", "ts",
  "jsx", "tsx", "log", "yml", "yaml", "ini", "conf", "toml", "sh",
  "py", "go", "rs", "java", "c", "cpp", "h", "sql", "svg",
]);
const extensionOf = (filename: string): string => filename.split(".").pop()?.toLowerCase() ?? "";
const archiveExtensions = new Set(["zip", "tar", "tgz", "gz", "7z", "rar"]);
const archiveMimeTypes = new Set([
  "application/zip", "application/x-zip-compressed", "application/x-tar",
  "application/gzip", "application/x-gzip", "application/x-7z-compressed",
  "application/vnd.rar", "application/x-rar-compressed",
]);

export function isArchiveFile(filename: string, mime = ""): boolean {
  const normalized = mime.split(";")[0].trim().toLowerCase();
  return archiveExtensions.has(extensionOf(filename)) || archiveMimeTypes.has(normalized);
}

export function previewFormat(filename: string, mime = ""): { kind: PreviewKind; contentType?: string } | null {
  if (isArchiveFile(filename, mime)) return null;
  const extension = extensionOf(filename);
  if (image[extension]) return { kind: "image", contentType: image[extension] };
  if (audio[extension]) return { kind: "audio", contentType: audio[extension] };
  if (video[extension]) return { kind: "video", contentType: video[extension] };
  if (extension === "pdf") return { kind: "pdf", contentType: "application/pdf" };
  if (textExtensions.has(extension)) return { kind: "text", contentType: "text/plain; charset=utf-8" };

  // Browsers and upload tools sometimes omit the extension or upload with a generic name.
  const normalized = mime.split(";")[0].trim().toLowerCase();
  if (normalized === "application/pdf") return { kind: "pdf", contentType: "application/pdf" };
  if (Object.values(image).includes(normalized)) return { kind: "image", contentType: normalized };
  if (Object.values(audio).includes(normalized)) return { kind: "audio", contentType: normalized };
  if (Object.values(video).includes(normalized)) return { kind: "video", contentType: normalized };
  if (normalized === "text/plain" || normalized === "text/csv" || normalized === "application/json") {
    return { kind: "text", contentType: "text/plain; charset=utf-8" };
  }
  return null;
}
