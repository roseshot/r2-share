import type { EncryptedCode } from "./model";

const enc = new TextEncoder();
const dec = new TextDecoder();
export function b64(bytes: Uint8Array): string {
  let out = "";
  for (const n of bytes) out += String.fromCharCode(n);
  return btoa(out).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
export function unb64(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const text = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(text.length));
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}
// Each generated ID has 8, 9, or 10 Base64URL characters (48-60 random bits).
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return b64(bytes.subarray(1)).slice(0, 8 + bytes[0] % 3);
}
export const randomFileId = (): string => b64(crypto.getRandomValues(new Uint8Array(12)));
export const randomRevision = (): string => b64(crypto.getRandomValues(new Uint8Array(16)));
export function randomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, byte => alphabet[byte & 31]).join("");
}
async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function signToken(secret: string, claims: Record<string, unknown>): Promise<string> {
  const body = b64(enc.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret), enc.encode(body));
  return body + "." + b64(new Uint8Array(signature));
}
export async function readToken(secret: string, token: string | undefined): Promise<Record<string, unknown> | null> {
  if (!token || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", await signingKey(secret), unb64(parts[1]), enc.encode(parts[0]));
    if (!valid) return null;
    const result: unknown = JSON.parse(dec.decode(unb64(parts[0])));
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;
    const claims = result as Record<string, unknown>;
    return typeof claims.exp === "number" && claims.exp > Date.now() ? claims : null;
  } catch { return null; }
}
export async function equalText(a: string, b: string): Promise<boolean> {
  const [aa, bb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(aa), y = new Uint8Array(bb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = unb64(secret);
  if (raw.length !== 32) throw new Error("CODE_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptCode(code: string, id: string, revision: string, secret: string): Promise<EncryptedCode> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(id + ":" + revision) },
    await aesKey(secret),
    enc.encode(code),
  );
  return { iv: b64(iv), data: b64(new Uint8Array(data)) };
}
export async function decryptCode(record: { id: string; revision: string; encryptedCode?: EncryptedCode }, secret: string): Promise<string> {
  if (!record.encryptedCode) throw new Error("No encrypted code");
  const bytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(record.encryptedCode.iv), additionalData: enc.encode(record.id + ":" + record.revision) },
    await aesKey(secret),
    unb64(record.encryptedCode.data),
  );
  return dec.decode(bytes);
}
