import { AwsClient } from "aws4fetch";
import { validObjectKey, validStorageId, type Bindings, type StorageConfig } from "./model";

export interface ObjectInfo {
  size: number;
  uploaded: Date;
}
export interface ObjectBody extends ObjectInfo {
  body: ReadableStream<Uint8Array>;
  status?: 200 | 206;
  contentRange?: string;
}
export interface ObjectPage {
  objects: { key: string; uploaded: Date }[];
  truncated: boolean;
  cursor?: string;
}
export interface ObjectStore {
  get(key: string, range?: string): Promise<ObjectBody | null>;
  head(key: string): Promise<ObjectInfo | null>;
  put(key: string, body: string | ReadableStream<Uint8Array>, contentType: string, length: number): Promise<ObjectInfo>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; limit: number; cursor?: string }): Promise<ObjectPage>;
}

/** Escape only XML character references used by S3 ListObjectsV2. */
export function xmlText(value: string): string {
  return value.replace(/&#(x[0-9a-fA-F]+|\d+);|&(amp|lt|gt|quot|apos);/g, (_match, numeric: string | undefined, name: string | undefined) => {
    if (numeric) {
      const value = numeric.startsWith("x") ? parseInt(numeric.slice(1), 16) : Number(numeric);
      return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[name ?? ""] ?? "";
  });
}

function tag(text: string, name: string): string | undefined {
  const match = new RegExp("<(?:[A-Za-z0-9_]+:)?" + name + ">([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?" + name + ">").exec(text);
  return match ? xmlText(match[1]) : undefined;
}

export function parseListObjectsV2(xml: string): ObjectPage {
  if (!/<(?:\w+:)?ListBucketResult(?:\s|>)/.test(xml)) throw new Error("Invalid S3 list response");
  const objects: ObjectPage["objects"] = [];
  const pattern = /<(?:\w+:)?Contents>([\s\S]*?)<\/(?:\w+:)?Contents>/g;
  for (const match of xml.matchAll(pattern)) {
    const key = tag(match[1], "Key");
    const date = tag(match[1], "LastModified");
    if (!key || !date || !Number.isFinite(Date.parse(date))) throw new Error("Invalid S3 object entry");
    objects.push({ key, uploaded: new Date(date) });
  }
  const truncated = tag(xml, "IsTruncated") === "true";
  const cursor = truncated ? tag(xml, "NextContinuationToken") : undefined;
  if (truncated && !cursor) throw new Error("Missing S3 continuation token");
  return { objects, truncated, cursor };
}

export function b2ObjectUrl(region: string, bucket: string, key = ""): string {
  // The region is deliberately constrained: never allow an arbitrary upstream host.
  if (!/^[a-z]{2}-[a-z0-9-]+-\d{3}$/.test(region)) throw new Error("Invalid B2 region");
  if (!/^[a-z0-9][a-z0-9.-]{4,61}[a-z0-9]$/.test(bucket)) throw new Error("Invalid B2 bucket name");
  if (key && !validObjectKey(key)) {
    throw new Error("Invalid storage object key");
  }
  return `https://s3.${region}.backblazeb2.com/${bucket}${key ? "/" + key : ""}`;
}

export function r2ObjectUrl(accountId: string, bucket: string, key = ""): string {
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("Invalid R2 account ID");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("Invalid R2 bucket name");
  if (key && !validObjectKey(key)) {
    throw new Error("Invalid storage object key");
  }
  return `https://${accountId.toLowerCase()}.r2.cloudflarestorage.com/${bucket}${key ? "/" + key : ""}`;
}

export function validAwsBucket(bucket: unknown): bucket is string {
  return typeof bucket === "string" &&
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) &&
    !/(?:\.\.|\.-|-\.)/.test(bucket) &&
    !/^\d+\.\d+\.\d+\.\d+$/.test(bucket);
}

export function awsS3ObjectUrl(region: string, bucket: string, key = ""): string {
  if (typeof region !== "string" || !region) throw new Error("AWS region is required");
  if (!validAwsBucket(bucket)) throw new Error("Invalid AWS S3 bucket");
  if (key && !validObjectKey(key)) throw new Error("Invalid storage object key");
  // Do not restrict AWS regions. Resolve only under the fixed AWS commercial
  // domain, and prevent a region string from injecting URL authority or path.
  const hostname = `s3.${region}.amazonaws.com`;
  let url: URL;
  try {
    url = new URL(`https://${hostname}/${bucket}${key ? "/" + key : ""}`);
  } catch {
    throw new Error("Invalid AWS S3 endpoint");
  }
  if (url.hostname !== hostname || url.username || url.password || url.port ||
      url.pathname !== `/${bucket}${key ? "/" + key : ""}` || url.search || url.hash) {
    throw new Error("Invalid AWS S3 endpoint");
  }
  return url.toString();
}

/**
 * B2, R2, and AWS S3 use a private S3-compatible API, with authenticated Worker-side
 * requests. Credentials and URLs are never exposed to browsers.
 */
function s3Store(options: {
  root: string;
  urlFor: (key: string) => string;
  region: string;
  keyId: string;
  secret: string;
  label: string;
}): ObjectStore {
  const { root, urlFor, region, keyId, secret, label } = options;
  const client = new AwsClient({
    accessKeyId: keyId,
    secretAccessKey: secret,
    service: "s3",
    region,
    // Retrying a consumed streaming PUT body is unsafe.
    retries: 0,
  });
  async function signed(method: string, url: string, init: RequestInit = {}): Promise<Response> {
    return client.fetch(url, {
      ...init,
      method,
      headers: { ...(init.headers as Record<string, string> | undefined),
        "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" },
    });
  }
  async function requireOk(response: Response, action: string): Promise<Response> {
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${label} ${action} failed (HTTP ${response.status})`);
    }
    return response;
  }
  return {
    async get(key, range) {
      const result = await signed("GET", urlFor(key),
        range ? { headers: { Range: range } } : {});
      if (result.status === 404) return null;
      await requireOk(result, "GET");
      if (!result.body) throw new Error(`Empty ${label} download stream`);
      const size = Number(result.headers.get("content-length"));
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid ${label} download length`);
      return {
        body: result.body,
        size,
        status: result.status === 206 ? 206 : 200,
        contentRange: result.headers.get("content-range") ?? undefined,
        uploaded: result.headers.get("last-modified") ? new Date(result.headers.get("last-modified")!) : new Date(),
      };
    },
    async head(key) {
      const result = await signed("HEAD", urlFor(key));
      if (result.status === 404) return null;
      await requireOk(result, "HEAD");
      const size = Number(result.headers.get("content-length"));
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid ${label} object size`);
      return { size, uploaded: result.headers.get("last-modified") ? new Date(result.headers.get("last-modified")!) : new Date() };
    },
    async put(key, body, contentType, length) {
      if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid upload length");
      let uploadBody: string | ReadableStream<Uint8Array> = body;
      let piping: Promise<void> | undefined;
      if (typeof body !== "string") {
        // FixedLengthStream avoids buffering large files in Worker memory.
        const fixed = new FixedLengthStream(length);
        piping = body.pipeTo(fixed.writable);
        void piping.catch(() => undefined);
        uploadBody = fixed.readable;
      }
      const result = await signed("PUT", urlFor(key), {
        headers: { "Content-Type": contentType, "Content-Length": String(length) },
        body: uploadBody,
      });
      await requireOk(result, "PUT");
      if (piping) await piping;
      const head = await this.head(key);
      if (!head) throw new Error(`${label} object disappeared after PUT`);
      return head;
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        await requireOk(await signed("DELETE", urlFor(key)), "DELETE");
      }
    },
    async list({ prefix, limit, cursor }) {
      if (prefix !== "files/" && prefix !== "tuckbox/") throw new Error("Invalid list prefix");
      const query = new URL(root);
      query.searchParams.set("list-type", "2");
      query.searchParams.set("prefix", prefix);
      query.searchParams.set("max-keys", String(Math.max(1, Math.min(1000, limit))));
      if (cursor) query.searchParams.set("continuation-token", cursor);
      const response = await requireOk(await signed("GET", query.toString()), "LIST");
      return parseListObjectsV2(await response.text());
    },
  };
}

export function getStorageConfig(env: Bindings, storageId: string): StorageConfig | null {
  if (!validStorageId(storageId)) return null;
  return env.STORAGES?.find(storage => storage.id === storageId) ?? null;
}

export function isStorageConfigured(env: Bindings, storageId: string): boolean {
  return getStorageConfig(env, storageId) !== null;
}

function configuredStore(storage: StorageConfig): ObjectStore {
  if (storage.backend === "b2") {
    return s3Store({
      root: b2ObjectUrl(storage.region, storage.bucket),
      urlFor: key => b2ObjectUrl(storage.region, storage.bucket, key),
      region: storage.region, keyId: storage.keyId, secret: storage.applicationKey,
      label: "Backblaze B2",
    });
  }
  if (storage.backend === "s3") {
    return s3Store({
      root: awsS3ObjectUrl(storage.region, storage.bucket),
      urlFor: key => awsS3ObjectUrl(storage.region, storage.bucket, key),
      region: storage.region, keyId: storage.accessKeyId, secret: storage.secretAccessKey,
      label: "AWS S3",
    });
  }
  return s3Store({
    root: r2ObjectUrl(storage.accountId, storage.bucket),
    urlFor: key => r2ObjectUrl(storage.accountId, storage.bucket, key),
    region: "auto", keyId: storage.accessKeyId, secret: storage.secretAccessKey,
    label: "Cloudflare R2",
  });
}

/** Test stores are isolated by environment and stable storage ID. */
const stores = new WeakMap<Bindings, Map<string, ObjectStore>>();
export function bindObjectStore(env: Bindings, store: ObjectStore, storageId: string): void {
  const configured = stores.get(env) ?? new Map<string, ObjectStore>();
  configured.set(storageId, store);
  stores.set(env, configured);
}

export function getObjectStore(env: Bindings, storageId: string): ObjectStore {
  if (!isStorageConfigured(env, storageId)) throw new Error("Storage ID is not configured");
  let candidate: object | null = env;
  while (candidate) {
    const mock = stores.get(candidate as Bindings)?.get(storageId);
    if (mock) return mock;
    candidate = Object.getPrototypeOf(candidate) as object | null;
  }
  return configuredStore(getStorageConfig(env, storageId)!);
}
