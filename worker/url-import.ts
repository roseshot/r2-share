import { randomFileId, randomId, randomRevision, randomCode, encryptCode } from "./crypto";
import { monitorUpload } from "./integrity";
import { MAX_FILE_BYTES, dataKey, expirationDate, type Bindings, type FileRecord, type Mode } from "./model";
import { getObjectStore, isStorageConfigured } from "./object-store";
import { reserveUpload, claimUpload, abandonUpload, finishUpload } from "./storage";

/** Remote importing is administrator-only. Never use an unchecked redirect destination. */
export class RemoteImportError extends Error {
  constructor(message: string, readonly status: 400 | 413 | 503 = 400) {
    super(message);
    this.name = "RemoteImportError";
  }
}

const MAX_REDIRECTS = 5;
const MAX_URL_LENGTH = 2048;
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".onion",
  ".test", ".invalid", ".arpa"];
const BLOCKED_NAMES = new Set(["localhost", "metadata.google", "metadata", "ip6-localhost"]);

export function validateRemoteUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > MAX_URL_LENGTH)
    throw new RemoteImportError("Invalid remote URL");
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new RemoteImportError("Invalid remote URL"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username || url.password || url.hash ||
      (url.port && url.port !== "80" && url.port !== "443"))
    throw new RemoteImportError("Remote URL must use HTTP or HTTPS without credentials or custom ports");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // Explicitly reject IP literals (including IPv6 and WHATWG-normalized numeric
  // spellings) and non-public/reserved hostnames. Redirects are checked too.
  if (!host.includes(".") || host.includes(":") || host.startsWith("[") ||
      /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) ||
      BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some(s => host.endsWith(s)) ||
      host.startsWith("metadata.") || host.endsWith(".metadata.google.internal"))
    throw new RemoteImportError("Remote URL must refer to a public hostname");
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
  if (!Number.isSafeInteger(length)) return null;
  return length;
}

async function openRemoteFile(
  raw: string,
  request: typeof fetch,
): Promise<{ response: Response; finalUrl: URL; size: number }> {
  let url = validateRemoteUrl(raw);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    let response: Response;
    try {
      response = await request(url.toString(), {
        method: "GET", redirect: "manual", headers: {
          Accept: "*/*", "Accept-Encoding": "identity",
        }, signal: AbortSignal.timeout(120000),
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
    if (response.headers.get("content-encoding") &&
        response.headers.get("content-encoding") !== "identity") {
      await response.body?.cancel();
      throw new RemoteImportError("Remote server must send an uncompressed file", 503);
    }
    if (!response.body) throw new RemoteImportError("Remote file has no response body", 503);
    let size = remoteLength(response.headers.get("content-length"));
    if (size === null) {
      // Some servers omit GET Content-Length but expose it for HEAD. A missing
      // trustworthy length cannot be forwarded to S3's fixed-length PUT.
      try {
        const head = await request(url.toString(), {
          method: "HEAD", redirect: "manual",
          headers: { "Accept-Encoding": "identity" }, signal: AbortSignal.timeout(15000),
        });
        if (head.ok && !head.headers.get("content-encoding")) {
          size = remoteLength(head.headers.get("content-length"));
        }
        await head.body?.cancel();
      } catch { /* Fall through to the missing-length error. */ }
    }
    if (size === null) {
      await response.body.cancel();
      throw new RemoteImportError("Remote server must provide Content-Length", 503);
    }
    if (size < 1 || size > MAX_FILE_BYTES) {
      await response.body.cancel();
      throw new RemoteImportError("Remote file must be between 1 byte and 90 MiB", 413);
    }
    return { response, finalUrl: url, size };
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
  const { response, finalUrl, size } = await openRemoteFile(input.url, request);
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
      id, storageId: input.storageId, filename, size, mime, mode: input.mode, revision,
      createdAt: new Date().toISOString(), expiresAt: null,
      shareExpiresAt: expirationDate(input.shareExpiresIn),
      encryptedCode: code ? await encryptCode(code, shareId, revision, env.CODE_ENCRYPTION_KEY) : undefined,
    };
    const store = getObjectStore(env, input.storageId);
    const integrity = monitorUpload(response.body!, size);
    const object = await store.put(dataKey(id), integrity.stream, mime, size);
    const verified = await integrity.result();
    if (object.size !== size || verified.size !== size)
      throw new RemoteImportError("Remote file size does not match Content-Length", 503);
    record.checksums = { sha256: verified.sha256 };
    await finishUpload(env, record, shareId);
    reservedId = null;
    return { id, shareId, filename, size, mode: input.mode,
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
