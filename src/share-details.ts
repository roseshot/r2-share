import { RequestError, requestJson, type Share } from "./lib";

const placeholderFormats = [
  { prefix: "document", extension: "pdf", mime: "application/pdf" },
  { prefix: "photo", extension: "jpg", mime: "image/jpeg" },
  { prefix: "archive", extension: "zip", mime: "application/zip" },
  { prefix: "notes", extension: "txt", mime: "text/plain" },
  { prefix: "recording", extension: "mp4", mime: "video/mp4" },
  { prefix: "spreadsheet", extension: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
] as const;

export function createPlaceholderShare(id: string): Share {
  const values = new Uint32Array(12);
  crypto.getRandomValues(values);
  const format = placeholderFormats[values[0] % placeholderFormats.length];
  return {
    id,
    mode: "public",
    filename: format.prefix + "-" + values[1].toString(36) + "." + format.extension,
    size: 1024 + values[2] % (90 * 1024 * 1024 - 1024),
    mime: format.mime,
    originalModifiedAt: new Date(Date.now() - (1 + values[3] % 365) * 86400000).toISOString(),
    checksums: {
      sha256: Array.from(values.subarray(4), value => value.toString(16).padStart(8, "0")).join(""),
    },
  };
}

export async function loadShareDetails(
  id: string,
  load: (url: string) => Promise<Share> = requestJson,
): Promise<{ file: Share; isPlaceholder: boolean }> {
  try {
    return { file: await load("/api/files/" + id), isPlaceholder: false };
  } catch (error) {
    if (!(error instanceof RequestError) || error.status !== 404) throw error;
    return { file: createPlaceholderShare(id), isPlaceholder: true };
  }
}
