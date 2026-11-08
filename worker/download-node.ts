import { signToken } from "./crypto";
import { dataKey, validStoredId, type Bindings, type FileRecord } from "./model";

/** Optional download offload nodes. Absence keeps the original Worker streaming behavior. */
const maxNodes = 16;
const grantTtlMs = 90_000;

export function configuredDownloadNodes(env: Bindings): URL[] {
  const raw = env.DOWNLOAD_NODES?.trim() ?? "";
  if (!raw) return [];
  if (!env.DOWNLOAD_NODE_SECRET || env.DOWNLOAD_NODE_SECRET.length < 32) {
    throw new Error("DOWNLOAD_NODE_SECRET must be at least 32 characters");
  }
  const entries = raw.split(",").map(value => value.trim());
  if (entries.length > maxNodes || entries.some(value => !value)) {
    throw new Error("Invalid DOWNLOAD_NODES list");
  }
  const seen = new Set<string>();
  return entries.map(value => {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error("Invalid DOWNLOAD_NODES endpoint"); }
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash || !url.hostname ||
        seen.has(url.host)) {
      throw new Error("DOWNLOAD_NODES must contain unique HTTPS origins without paths");
    }
    seen.add(url.host);
    return url;
  });
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
  const node = pickDownloadNode(nodes, record.id);
  const signed = await signToken(env.DOWNLOAD_NODE_SECRET!, {
    scope: "tuckbox-download/v1",
    key: dataKey(record.id),
    storageId: record.storageId,
    filename: record.filename,
    mime: record.mime,
    size: record.size,
    aud: node.host,
    exp: expiry,
  });
  const target = new URL("/v1/download", node);
  target.searchParams.set("token", signed);
  // No Worker file bytes traverse this redirect. The node validates the
  // short-lived grant and privately fetches the object from its configured S3.
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
