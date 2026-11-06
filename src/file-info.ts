export const checksumAlgorithms = [
  { key: "sha256", label: "SHA-256" },
] as const;

/** File.lastModified is available to browsers; original creation dates are not. */
export function originalModificationDate(lastModified: number | undefined): string | undefined {
  if (typeof lastModified !== "number" || !Number.isFinite(lastModified) ||
      lastModified <= 0 || lastModified > 8640000000000000) return undefined;
  return new Date(lastModified).toISOString();
}

const formats: Record<string, string> = {
  pdf: "PDF document", txt: "Text document", md: "Markdown document",
  csv: "CSV spreadsheet", json: "JSON document", xml: "XML document",
  html: "HTML document", css: "CSS stylesheet", js: "JavaScript file", ts: "TypeScript file",
  doc: "Word document", docx: "Word document", xls: "Excel spreadsheet",
  xlsx: "Excel spreadsheet", ppt: "PowerPoint presentation", pptx: "PowerPoint presentation",
  odt: "OpenDocument text", ods: "OpenDocument spreadsheet",
  png: "PNG image", jpg: "JPEG image", jpeg: "JPEG image", gif: "GIF image",
  webp: "WebP image", svg: "SVG image", avif: "AVIF image", bmp: "Bitmap image", heic: "HEIC image",
  mp3: "MP3 audio", m4a: "M4A audio", wav: "WAV audio", ogg: "Ogg audio", flac: "FLAC audio",
  mp4: "MP4 video", mov: "QuickTime video", webm: "WebM video", mkv: "Matroska video", avi: "AVI video",
  zip: "ZIP archive", "7z": "7z archive", rar: "RAR archive", tar: "TAR archive", gz: "Gzip archive",
  apk: "Android package", exe: "Windows executable", dmg: "Disk image", iso: "ISO disk image",
};

const mimeFormats: Record<string, string> = {
  "application/pdf": "PDF document", "text/plain": "Text document",
  "text/csv": "CSV spreadsheet", "application/json": "JSON document",
  "image/png": "PNG image", "image/jpeg": "JPEG image", "image/gif": "GIF image",
  "image/webp": "WebP image", "image/svg+xml": "SVG image",
  "audio/mpeg": "MP3 audio", "audio/wav": "WAV audio",
  "video/mp4": "MP4 video", "video/webm": "WebM video",
  "application/zip": "ZIP archive",
};

export function describeFileType(filename: string, mime?: string): string {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension && formats[extension]) return formats[extension];
  const normalized = (mime ?? "").split(";")[0].trim().toLowerCase();
  return mimeFormats[normalized] ?? "Unknown file type";
}
