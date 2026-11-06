import { b64, unb64 } from "./crypto";
import type { Bindings } from "./model";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const salt = new Uint8Array(32);
const context = "tuckbox/app-settings/v1";

export interface AppSettings {
  b2Bucket: string;
  b2Region: string;
  b2KeyId: string;
  b2ApplicationKey: string;
  r2AccountId?: string;
  r2Bucket?: string;
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
  virusTotalApiKey?: string;
}

function masterBytes(master: string): Uint8Array<ArrayBuffer> {
  try {
    const bytes = unb64(master);
    if (bytes.length === 32) return bytes;
  } catch { /* Invalid master key encoding. */ }
  throw new Error("APP_MASTER_KEY must be 32 base64-encoded bytes");
}

export function validateSettings(settings: AppSettings): void {
  const b2 = [settings.b2Region, settings.b2Bucket, settings.b2KeyId, settings.b2ApplicationKey];
  if (b2.some(value => typeof value !== "string")) throw new Error("Invalid B2 configuration");
  if (b2.some(Boolean)) {
    if (!/^[a-z]{2}-[a-z0-9-]+-[0-9]{3}$/.test(settings.b2Region)) throw new Error("Invalid B2 region");
    if (!/^[a-z0-9][a-z0-9.-]{4,61}[a-z0-9]$/.test(settings.b2Bucket)) throw new Error("Invalid B2 bucket");
    if (settings.b2KeyId.length < 4 || settings.b2KeyId.length > 256 ||
        settings.b2ApplicationKey.length < 4 || settings.b2ApplicationKey.length > 256) {
      throw new Error("Invalid B2 credentials");
    }
  }
  const r2 = [settings.r2AccountId ?? "", settings.r2Bucket ?? "",
    settings.r2AccessKeyId ?? "", settings.r2SecretAccessKey ?? ""];
  if (r2.some(value => typeof value !== "string")) throw new Error("Invalid R2 configuration");
  if (r2.some(Boolean)) {
    if (!/^[0-9a-f]{32}$/i.test(r2[0])) throw new Error("Invalid R2 account ID");
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(r2[1])) throw new Error("Invalid R2 bucket");
    if (r2[2].length < 4 || r2[2].length > 256 ||
        r2[3].length < 4 || r2[3].length > 256) {
      throw new Error("Invalid R2 credentials");
    }
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
    b2Bucket: (raw.b2Bucket ?? "") as string,
    b2Region: (raw.b2Region ?? "") as string,
    b2KeyId: (raw.b2KeyId ?? "") as string,
    b2ApplicationKey: (raw.b2ApplicationKey ?? "") as string,
    ...(raw.r2AccountId !== undefined ? { r2AccountId: raw.r2AccountId as string } : {}),
    ...(raw.r2Bucket !== undefined ? { r2Bucket: raw.r2Bucket as string } : {}),
    ...(raw.r2AccessKeyId !== undefined ? { r2AccessKeyId: raw.r2AccessKeyId as string } : {}),
    ...(raw.r2SecretAccessKey !== undefined ? { r2SecretAccessKey: raw.r2SecretAccessKey as string } : {}),
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
    ...(settings ? {
      B2_REGION: settings.b2Region,
      B2_BUCKET: settings.b2Bucket,
      B2_KEY_ID: settings.b2KeyId,
      B2_APPLICATION_KEY: settings.b2ApplicationKey,
      R2_ACCOUNT_ID: settings.r2AccountId,
      R2_BUCKET: settings.r2Bucket,
      R2_ACCESS_KEY_ID: settings.r2AccessKeyId,
      R2_SECRET_ACCESS_KEY: settings.r2SecretAccessKey,
      VIRUSTOTAL_API_KEY: settings.virusTotalApiKey,
    } : {}),
  });
}
