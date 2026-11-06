import type { PreviewKind } from "./preview-types";

export interface ArchiveEntry {
  name: string;
  size: number;
  directory: boolean;
}
export interface ArchiveDirectory {
  entries: ArchiveEntry[];
  total: number;
  truncated: boolean;
}
const MAX_ENTRIES = 500;
const MAX_LISTED = 200;
const MAX_UNPACKED_TGZ = 48 * 1024 * 1024;
const decoder = new TextDecoder("utf-8");

function cleanName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 1024);
}

export function readZipDirectory(bytes: Uint8Array): ArchiveDirectory {
  if (bytes.length < 22) throw new Error("Invalid ZIP archive");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50 &&
        i + 22 + view.getUint16(i + 20, true) === bytes.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Invalid ZIP central directory");
  const count = view.getUint16(eocd + 10, true);
  const length = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0 ||
      view.getUint16(eocd + 8, true) !== count ||
      count === 0xffff || length === 0xffffffff || offset === 0xffffffff ||
      count > MAX_ENTRIES || offset + length > eocd) {
    throw new Error("ZIP64, multipart, or unusually large ZIP directories are not supported");
  }
  const entries: ArchiveEntry[] = [];
  let position = offset;
  let total = 0;
  const end = offset + length;
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50) {
      throw new Error("Invalid ZIP directory entry");
    }
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    if ((flags & 1) !== 0 || method === 99) {
      throw new Error("Password-protected archives cannot be listed");
    }
    const size = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const next = position + 46 + nameLength + extraLength + commentLength;
    if (size === 0xffffffff || next > end || nameLength === 0) {
      throw new Error("Unsupported or invalid ZIP entry");
    }
    const name = cleanName(decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength)));
    if (entries.length < MAX_LISTED) {
      entries.push({ name, size, directory: name.endsWith("/") });
    }
    total++;
    position = next;
  }
  if (position !== end) throw new Error("Invalid ZIP directory length");
  return { entries, total, truncated: total > MAX_LISTED };
}

function tarText(bytes: Uint8Array, offset: number, length: number): string {
  const area = bytes.subarray(offset, offset + length);
  const nul = area.indexOf(0);
  return cleanName(decoder.decode(nul < 0 ? area : area.subarray(0, nul)));
}

export function readTarDirectory(bytes: Uint8Array): ArchiveDirectory {
  if (bytes.length < 1024 || bytes.length % 512 !== 0) throw new Error("Invalid TAR archive");
  const entries: ArchiveEntry[] = [];
  let total = 0;
  let offset = 0;
  for (; offset + 512 <= bytes.length;) {
    const block = bytes.subarray(offset, offset + 512);
    if (block.every(value => value === 0)) break;
    const magic = tarText(bytes, offset + 257, 6);
    if (magic !== "ustar") throw new Error("Invalid or unsupported TAR header");
    const octal = tarText(bytes, offset + 124, 12).trim();
    if (!/^[0-7]+$/.test(octal)) throw new Error("Invalid TAR size");
    const size = Number.parseInt(octal, 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid TAR size");
    const kind = String.fromCharCode(bytes[offset + 156]);
    const suffix = tarText(bytes, offset, 100);
    const prefix = tarText(bytes, offset + 345, 155);
    const name = cleanName(prefix ? prefix + "/" + suffix : suffix);
    // PAX headers and GNU extension records are metadata, not user-facing files.
    if (!["x", "g", "L", "K"].includes(kind)) {
      if (total >= MAX_ENTRIES) throw new Error("Archive contains too many entries");
      if (entries.length < MAX_LISTED) {
        entries.push({ name, size, directory: kind === "5" || name.endsWith("/") });
      }
      total++;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
    if (offset > bytes.length) throw new Error("Truncated TAR archive");
  }
  return { entries, total, truncated: total > MAX_LISTED };
}

async function decompressGzip(data: Uint8Array): Promise<Uint8Array> {
  const source = new Blob([new Uint8Array(data)]).stream();
  const reader = source.pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UNPACKED_TGZ) {
        await reader.cancel();
        throw new Error("Decompressed archive is too large to list safely");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let index = 0;
  for (const chunk of chunks) { out.set(chunk, index); index += chunk.length; }
  return out;
}

export async function readArchiveDirectory(blob: Blob, kind: PreviewKind): Promise<ArchiveDirectory> {
  if (kind !== "zip" && kind !== "tar" && kind !== "tgz") {
    throw new Error("Unsupported archive format");
  }
  const input = new Uint8Array(await blob.arrayBuffer());
  if (kind === "zip") return readZipDirectory(input);
  if (kind === "tar") return readTarDirectory(input);
  return readTarDirectory(await decompressGzip(input));
}
