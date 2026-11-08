import { AwsClient } from "aws4fetch";
import { b64, signToken } from "./crypto";
import { awsS3ObjectUrl, b2ObjectUrl, getStorageConfig, r2ObjectUrl } from "./object-store";
import { dataKey, validStoredId, type Bindings, type FileRecord } from "./model";

/** Optional download offload nodes. Absence keeps the original Worker streaming behavior. */
const maxNodes = 16;
const grantTtlMs = 90_000;
const sourceKeyPrefix = "tuckbox-download-source/v1:";

async function encryptedSource(secret: string, urls: { get: string; head: string }): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(sourceKeyPrefix + secret));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(urls)),
  );
  return b64(iv) + "." + b64(new Uint8Array(encrypted));
}

/** Only the Worker signs private object requests; nodes receive encrypted, short-lived URLs. */
async function presignedSource(env: Bindings, storageId: string, key: string, ttlSeconds: number) {
  const storage = getStorageConfig(env, storageId);
  if (!storage) throw new Error("Storage ID is not configured");
  const endpoint = storage.backend === "b2"
    ? b2ObjectUrl(storage.region, storage.bucket, key)
    : storage.backend === "r2"
      ? r2ObjectUrl(storage.accountId, storage.bucket, key)
      : awsS3ObjectUrl(storage.region, storage.bucket, key);
  const client = new AwsClient({
    service: "s3",
    region: storage.backend === "r2" ? "auto" : storage.region,
    accessKeyId: storage.backend === "b2" ? storage.keyId : storage.accessKeyId,
    secretAccessKey: storage.backend === "b2" ? storage.applicationKey : storage.secretAccessKey,
    retries: 0,
  });
  const url = new URL(endpoint);
  url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
  const [get, head] = await Promise.all([
    client.sign(new Request(url), { aws: { signQuery: true } }),
    client.sign(new Request(url, { method: "HEAD" }), { aws: { signQuery: true } }),
  ]);
  return { get: get.url, head: head.url };
}

export function parseDownloadNodeOrigins(entries: string[]): URL[] {
  if (!Array.isArray(entries) || entries.length > maxNodes) {
    throw new Error("Download nodes must be a list of at most 16 HTTPS origins");
  }
  const seen = new Set<string>();
  return entries.map(value => {
    let url: URL;
    if (typeof value !== "string" || !value || value !== value.trim()) {
      throw new Error("Invalid download node endpoint");
    }
    try { url = new URL(value); }
    catch { throw new Error("Invalid download node endpoint"); }
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash || !url.hostname ||
        seen.has(url.host)) {
      throw new Error("Download nodes must contain unique HTTPS origins without paths");
    }
    seen.add(url.host);
    return url;
  });
}

export function configuredDownloadNodes(env: Bindings): URL[] {
  const raw = env.DOWNLOAD_NODES?.trim() ?? "";
  if (!raw) return [];
  if (!env.DOWNLOAD_NODE_SECRET || env.DOWNLOAD_NODE_SECRET.length < 32) {
    throw new Error("DOWNLOAD_NODE_SECRET must be at least 32 characters");
  }
  return parseDownloadNodeOrigins(raw.split(",").map(value => value.trim()));
}

/** Sticky by File ID, so resumed ranges use the same node after new authorization. */
export function pickDownloadNode(nodes: URL[], id: string): URL {
  if (!nodes.length) throw new Error("No download nodes configured");
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return nodes[(hash >>> 0) % nodes.length];
}

export async function redirectedDownload(
  env: Bindings, record: FileRecord, shareExpiresAt: string | null = null,
): Promise<Response | null> {
  const nodes = configuredDownloadNodes(env);
  if (!nodes.length) return null;
  if (!validStoredId(record.id) || !Number.isSafeInteger(record.size) || record.size < 1) {
    throw new Error("Invalid file for download offload");
  }
  const now = Date.now();
  let expiry = now + grantTtlMs;
  for (const deadline of [record.expiresAt, shareExpiresAt]) {
    if (deadline !== null) {
      const timestamp = Date.parse(deadline);
      if (!Number.isFinite(timestamp) || timestamp <= now) {
        throw new Error("Expired file or share");
      }
      expiry = Math.min(expiry, timestamp);
    }
  }
  // Allow for signature timestamp rounding and the time spent generating both URLs.
  const ttlSeconds = Math.floor((expiry - Date.now()) / 1000) - 2;
  if (ttlSeconds < 1) throw new Error("Download grant expires too soon");
  const node = pickDownloadNode(nodes, record.id);
  const source = await encryptedSource(
    env.DOWNLOAD_NODE_SECRET!, await presignedSource(env, record.storageId, dataKey(record.id), ttlSeconds),
  );
  const signed = await signToken(env.DOWNLOAD_NODE_SECRET!, {
    scope: "tuckbox-download/v1",
    key: dataKey(record.id),
    storageId: record.storageId,
    source,
    filename: record.filename,
    mime: record.mime,
    size: record.size,
    aud: node.host,
    exp: expiry,
  });
  const target = new URL("/v1/download", node);
  target.searchParams.set("token", signed);
  // The redirect contains neither bucket credentials nor plaintext presigned URLs.
  return new Response(null, {
    status: 307,
    headers: {
      Location: target.toString(),
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
