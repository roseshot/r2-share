import { b64, unb64 } from "./crypto";
import { validStorageId, type Bindings, type StorageConfig } from "./model";
import { validAwsBucket, awsS3ObjectUrl } from "./object-store";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const salt = new Uint8Array(32);
const context = "tuckbox/app-settings/v1";

export interface AppSettings {
  storages: StorageConfig[];
  virusTotalApiKey?: string;
}

export function validateStorage(storage: StorageConfig): void {
  if (!storage || typeof storage !== "object" || !validStorageId(storage.id)) {
    throw new Error("Invalid storage ID");
  }
  if (storage.backend !== "b2" && storage.backend !== "r2" && storage.backend !== "s3")
    throw new Error("Invalid storage provider");
  if (typeof storage.bucket !== "string") throw new Error("Invalid bucket");
  if (storage.backend === "b2") {
    if (!/^[a-z]{2}-[a-z0-9-]+-[0-9]{3}$/.test(storage.region)) throw new Error("Invalid B2 region");
    if (!/^[a-z0-9][a-z0-9.-]{4,61}[a-z0-9]$/.test(storage.bucket)) throw new Error("Invalid B2 bucket");
    if (typeof storage.keyId !== "string" || storage.keyId.length < 4 || storage.keyId.length > 256 ||
        typeof storage.applicationKey !== "string" || storage.applicationKey.length < 4 ||
        storage.applicationKey.length > 256) throw new Error("Invalid B2 credentials");
  } else if (storage.backend === "r2") {
    if (typeof storage.accountId !== "string" ||
        !/^[a-f0-9]{32}$/i.test(storage.accountId)) throw new Error("Invalid R2 account ID");
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(storage.bucket)) throw new Error("Invalid R2 bucket");
    if (typeof storage.accessKeyId !== "string" || storage.accessKeyId.length < 4 ||
        storage.accessKeyId.length > 256 || typeof storage.secretAccessKey !== "string" ||
        storage.secretAccessKey.length < 4 || storage.secretAccessKey.length > 256) {
      throw new Error("Invalid R2 credentials");
    }
  } else {
    if (!validAwsBucket(storage.bucket)) throw new Error("Invalid AWS S3 bucket");
    // No AWS region allowlist. Validate endpoint construction without making
    // requests to any user-supplied hostname.
    awsS3ObjectUrl(storage.region, storage.bucket);
    if (typeof storage.accessKeyId !== "string" || storage.accessKeyId.length < 4 ||
        storage.accessKeyId.length > 256 || typeof storage.secretAccessKey !== "string" ||
        storage.secretAccessKey.length < 4 || storage.secretAccessKey.length > 256) {
      throw new Error("Invalid AWS S3 credentials");
    }
  }
}

export function publicStorage(storage: StorageConfig) {
  if (storage.backend === "b2") {
    return { id: storage.id, backend: storage.backend, bucket: storage.bucket,
      region: storage.region, keyId: storage.keyId };
  }
  if (storage.backend === "r2") {
    return { id: storage.id, backend: storage.backend, bucket: storage.bucket,
      accountId: storage.accountId, accessKeyId: storage.accessKeyId };
  }
  return { id: storage.id, backend: storage.backend, bucket: storage.bucket,
    region: storage.region, accessKeyId: storage.accessKeyId };
}

function masterBytes(master: string): Uint8Array<ArrayBuffer> {
  try {
    const bytes = unb64(master);
    if (bytes.length === 32) return bytes;
  } catch { /* Invalid master key encoding. */ }
  throw new Error("APP_MASTER_KEY must be 32 base64-encoded bytes");
}

export function validateSettings(settings: AppSettings): void {
  if (!Array.isArray(settings.storages) || settings.storages.length > 32) {
    throw new Error("Invalid storage list");
  }
  const ids = new Set<string>();
  for (const storage of settings.storages) {
    validateStorage(storage);
    if (ids.has(storage.id)) throw new Error("Duplicate storage ID");
    ids.add(storage.id);
  }
  if (settings.virusTotalApiKey !== undefined &&
      (typeof settings.virusTotalApiKey !== "string" || settings.virusTotalApiKey.length > 256)) {
    throw new Error("Invalid VirusTotal key");
  }
}

async function derive(master: string, purpose: string): Promise<Uint8Array<ArrayBuffer>> {
  const root = await crypto.subtle.importKey("raw", masterBytes(master), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("tuckbox/" + purpose + "/v1"),
  }, root, 256));
}

export async function deriveRuntimeKeys(master: string): Promise<{
  SESSION_SECRET: string;
  CODE_ENCRYPTION_KEY: string;
}> {
  const [session, code] = await Promise.all([derive(master, "session"), derive(master, "code")]);
  return { SESSION_SECRET: b64(session), CODE_ENCRYPTION_KEY: b64(code) };
}

export async function encryptAppSettings(master: string, settings: AppSettings): Promise<string> {
  validateSettings(settings);
  const key = await crypto.subtle.importKey("raw", await derive(master, "app-settings"), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({
    name: "AES-GCM", iv, additionalData: encoder.encode(context),
  }, key, encoder.encode(JSON.stringify(settings)));
  return JSON.stringify({ version: 1, iv: b64(iv), data: b64(new Uint8Array(data)) });
}

async function decryptPayload(master: string, payload: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(payload);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid D1 settings");
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1 || typeof value.iv !== "string" || typeof value.data !== "string") {
    throw new Error("Invalid D1 settings");
  }
  const iv = unb64(value.iv), data = unb64(value.data);
  if (iv.length !== 12) throw new Error("Invalid D1 settings IV");
  const key = await crypto.subtle.importKey("raw", await derive(master, "app-settings"), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({
    name: "AES-GCM", iv, additionalData: encoder.encode(context),
  }, key, data);
  const decoded: unknown = JSON.parse(decoder.decode(plain));
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Invalid D1 settings");
  return decoded as Record<string, unknown>;
}

function toSettings(raw: Record<string, unknown>): AppSettings {
  const settings: AppSettings = {
    storages: raw.storages as StorageConfig[],
    ...(raw.virusTotalApiKey ? { virusTotalApiKey: raw.virusTotalApiKey as string } : {}),
  };
  validateSettings(settings);
  return settings;
}

export async function decryptAppSettings(master: string, payload: string): Promise<AppSettings> {
  return toSettings(await decryptPayload(master, payload));
}

export async function readAppSettings(env: Bindings): Promise<AppSettings | null> {
  if (!env.APP_MASTER_KEY) throw new Error("APP_MASTER_KEY is missing");
  const row = await env.DB.prepare("SELECT payload FROM app_settings WHERE id = 1")
    .first<{ payload: string }>();
  if (!row) return null;
  return toSettings(await decryptPayload(env.APP_MASTER_KEY, row.payload));
}

export async function saveAppSettings(env: Bindings, settings: AppSettings): Promise<void> {
  const encrypted = await encryptAppSettings(env.APP_MASTER_KEY, settings);
  await env.DB.prepare(
    "INSERT INTO app_settings (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload"
  ).bind(encrypted).run();
}

// Test fixtures can inject request-specific resolved bindings without network access.
const testBindings = new WeakSet<Bindings>();
export function bindTestSettings(env: Bindings): void { testBindings.add(env); }

export async function resolveBindings(env: Bindings): Promise<Bindings> {
  if (testBindings.has(env)) return env;
  if (!env.APP_MASTER_KEY || !env.ADMIN_PATH || !env.ADMIN_PASSWORD) {
    throw new Error("Required runtime secrets are missing");
  }
  const [settings, keys, revision] = await Promise.all([
    readAppSettings(env),
    deriveRuntimeKeys(env.APP_MASTER_KEY),
    crypto.subtle.digest("SHA-256", encoder.encode(env.ADMIN_PASSWORD)),
  ]);
  return Object.assign(Object.create(env) as Bindings, {
    ...keys,
    ADMIN_AUTH_REVISION: b64(new Uint8Array(revision)),
    STORAGES: settings?.storages ?? [],
    VIRUSTOTAL_API_KEY: settings?.virusTotalApiKey,
  });
}
