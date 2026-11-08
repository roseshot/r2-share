import { randomFileId, randomId, randomRevision, randomCode, encryptCode } from "./crypto";
import { monitorUpload } from "./integrity";
import { dataKey, expirationDate, type Bindings, type FileRecord, type Mode } from "./model";
import { getObjectStore, isStorageConfigured } from "./object-store";
import { reserveUpload, claimUpload, abandonUpload, finishUpload } from "./storage";

/** Remote importing is administrator-only. Never use an unchecked redirect destination. */
export class RemoteImportError extends Error {
  constructor(message: string, readonly status: 400 | 413 | 503 = 400) {
    super(message);
    this.name = "RemoteImportError";
  }
}

const MAX_REDIRECTS = 20;
const MAX_URL_LENGTH = 2048;
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa",
  ".onion", ".test", ".invalid", ".arpa", ".localdomain"];
const BLOCKED_NAMES = new Set(["localhost", "metadata.google", "metadata", "ip6-localhost"]);

function privateIpv4(o: number[]): boolean {
  const [a, b, c] = o;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) ||
      (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

function blockedIpLiteral(host: string): boolean {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    return privateIpv4(host.split(".").map(Number));
  }
  if (!host.startsWith("[") || !host.endsWith("]")) return false;
  // URL normalizes IPv6 literals into hexadecimal groups, including IPv4-mapped
  // forms such as [::ffff:7f00:1]. Classify before every redirect fetch.
  const parts = host.slice(1, -1).split("::");
  if (parts.length > 2) return true;
  const left = parts[0] ? parts[0].split(":").map(x => parseInt(x, 16)) : [];
  const right = parts[1] ? parts[1].split(":").map(x => parseInt(x, 16)) : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill(0), ...right];
  if (groups.length !== 8 || groups.some(x => !Number.isInteger(x) || x < 0 || x > 0xffff))
    return true;
  const [first, second] = groups;
  if (first === 0 && groups.slice(0, 5).every(x => x === 0) &&
      groups[5] === 0xffff) {
    const last = groups[6]!, tail = groups[7]!;
    return privateIpv4([last >>> 8, last & 255, tail >>> 8, tail & 255]);
  }
  if (groups.every(x => x === 0) ||
      (groups.slice(0, 7).every(x => x === 0) && groups[7] === 1)) return true;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 || (first === 0x2001 && second === 0xdb8) ||
    (first === 0x0064 && second === 0xff9b);
}

export function validateRemoteUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > MAX_URL_LENGTH)
    throw new RemoteImportError("Invalid remote URL");
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new RemoteImportError("Invalid remote URL"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username || url.password)
    throw new RemoteImportError("Remote URL must use HTTP or HTTPS without embedded credentials");
  // Fragments are browser-only and must not affect the HTTP request.
  url.hash = "";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") && !host.startsWith("[")) {
    throw new RemoteImportError("Remote URL must refer to a public hostname or IP");
  }
  if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some(s => host.endsWith(s)) ||
      host.startsWith("metadata.") || blockedIpLiteral(host))
    throw new RemoteImportError("Remote URL cannot target a local, private or reserved address");
  return url;
}

export function remoteFilename(url: URL, supplied?: string): string {
  let name = supplied?.trim() ?? "";
  if (!name) {
    const segment = url.pathname.split("/").at(-1) ?? "";
    try { name = decodeURIComponent(segment); }
    catch { name = segment; }
    name = name.trim().replace(/[/\\]/g, "_");
  }
  if (!name || name === "." || name === ".." || name.length > 240 ||
      /[\x00-\x1f\x7f/\\]/.test(name))
    throw new RemoteImportError("Enter a valid filename (1–240 characters) or use a URL ending in a filename");
  return name;
}

export interface RemoteImportOptions {
  url: string;
  filename?: string;
  storageId: string;
  mode: Mode;
  code?: string;
  shareExpiresIn: number;
}

function remoteLength(value: string | null): number | null {
  if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

async function openRemoteFile(
  raw: string,
  request: typeof fetch,
): Promise<{ response: Response; finalUrl: URL; expectedSize: number | null }> {
  let url = validateRemoteUrl(raw);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    let response: Response;
    try {
      response = await request(url.toString(), {
        method: "GET", redirect: "manual",
        headers: { Accept: "*/*", "Accept-Encoding": "identity" },
      });
    } catch {
      throw new RemoteImportError("Unable to download remote file", 503);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (redirects === MAX_REDIRECTS) throw new RemoteImportError("Too many URL redirects");
      if (!location) throw new RemoteImportError("Remote redirect is missing a Location header");
      let next: string;
      try { next = new URL(location, url).toString(); }
      catch { throw new RemoteImportError("Invalid redirect destination"); }
      url = validateRemoteUrl(next);
      continue;
    }
    if (!response.ok || response.status === 206) {
      await response.body?.cancel();
      throw new RemoteImportError("Remote server did not return a complete file", 503);
    }
    if (!response.body) throw new RemoteImportError("Remote file has no response body", 503);
    // With Content-Encoding, the runtime may expose decompressed bytes, which
    // need not match the compressed Content-Length. Count actual stream bytes.
    const encoded = response.headers.get("content-encoding");
    const expectedSize = !encoded || encoded.toLowerCase() === "identity"
      ? remoteLength(response.headers.get("content-length")) : null;
    return { response, finalUrl: url, expectedSize };
  }
  throw new RemoteImportError("Too many URL redirects");
}

export async function importRemoteFile(
  env: Bindings,
  input: RemoteImportOptions,
  request: typeof fetch = fetch,
): Promise<{ id: string; shareId: string; filename: string; size: number;
  mode: Mode; code: string | null; expiresAt: string | null }> {
  if (!isStorageConfigured(env, input.storageId))
    throw new RemoteImportError("Storage ID is not configured", 503);
  const { response, finalUrl, expectedSize } = await openRemoteFile(input.url, request);
  let reservedId: string | null = null;
  try {
    const filename = remoteFilename(finalUrl, input.filename);
    const contentType = response.headers.get("content-type")?.split(";")[0].trim() ?? "";
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(contentType)
      ? contentType : "application/octet-stream";
    let id = randomFileId();
    while (!await reserveUpload(env, id, input.storageId)) id = randomFileId();
    reservedId = id;
    if (!await claimUpload(env, id, input.storageId))
      throw new RemoteImportError("Could not reserve remote import", 503);
    const shareId = randomId();
    const revision = randomRevision();
    const code = input.mode === "protected" ? input.code?.trim() || randomCode() : null;
    const record: FileRecord = {
      id, storageId: input.storageId, filename, size: 1, mime, mode: input.mode, revision,
      createdAt: new Date().toISOString(), expiresAt: null,
      shareExpiresAt: expirationDate(input.shareExpiresIn),
      encryptedCode: code ? await encryptCode(code, shareId, revision, env.CODE_ENCRYPTION_KEY) : undefined,
    };
    const store = getObjectStore(env, input.storageId);
    const integrity = monitorUpload(response.body!, expectedSize);
    const object = store.putMultipart
      ? await store.putMultipart(dataKey(id), integrity.stream, mime)
      : expectedSize !== null
        ? await store.put(dataKey(id), integrity.stream, mime, expectedSize)
        : (() => { throw new RemoteImportError("Storage does not support streaming imports", 503); })();
    const verified = await integrity.result();
    if (!verified.size || object.size !== verified.size ||
        (expectedSize !== null && verified.size !== expectedSize))
      throw new RemoteImportError("Remote file size does not match Content-Length", 503);
    record.size = verified.size;
    record.checksums = { sha256: verified.sha256 };
    await finishUpload(env, record, shareId);
    reservedId = null;
    return { id, shareId, filename, size: record.size, mode: input.mode,
      code, expiresAt: record.shareExpiresAt };
  } catch (error) {
    if (reservedId) {
      // Even a failed PUT may have created an incomplete bucket object.
      await getObjectStore(env, input.storageId).delete(dataKey(reservedId)).catch(() => undefined);
      await abandonUpload(env, reservedId).catch(() => undefined);
    }
    if (error instanceof RemoteImportError) throw error;
    throw new RemoteImportError("Unable to save remote file", 503);
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}
