export interface Bindings {
  DB: D1Database;
  APP_MASTER_KEY: string;
  ADMIN_AUTH_REVISION?: string;
  STORAGES?: StorageConfig[];
  ASSETS: Fetcher;
  ADMIN_PATH: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  CODE_ENCRYPTION_KEY: string;
  VIRUSTOTAL_API_KEY?: string;
  LOGIN_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
  CODE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

export type Mode = "public" | "protected";
export type StorageBackend = "b2" | "r2";
export type StorageConfig =
  | { id: string; backend: "b2"; bucket: string; region: string; keyId: string; applicationKey: string }
  | { id: string; backend: "r2"; bucket: string; accountId: string; accessKeyId: string; secretAccessKey: string };
export const validStorageId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9_-]{1,31}$/.test(value);
export interface EncryptedCode { iv: string; data: string }
export interface FileChecksums {
  sha256: string;
}
export const validSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const validChecksums = (value: unknown): value is FileChecksums => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const checksums = value as Record<string, unknown>;
  return Object.keys(checksums).length === 1 && validSha256(checksums.sha256);
};
export interface ShareRecord {
  id: string;
  fileId: string;
  label?: string;
  mode: Mode;
  revision: string;
  encryptedCode?: EncryptedCode;
  expiresAt: string | null;
  createdAt: string;
}

export const shareLinkExpired = (file: FileRecord, share: ShareRecord): boolean =>
  expired(file) || (share.expiresAt !== null && Date.parse(share.expiresAt) <= Date.now());

export interface FileRecord {
  id: string;
  storageId: string;
  filename: string;
  size: number;
  mime: string;
  checksums?: FileChecksums;
  /** Original file modification timestamp supplied by the uploading browser. */
  originalModifiedAt?: string;
  createdAt: string;
  expiresAt: string | null;
  shareExpiresAt: string | null;
  mode: Mode;
  revision: string;
  encryptedCode?: EncryptedCode;
}
export const MAX_FILE_BYTES = 90 * 1024 * 1024;
export const EXPIRATIONS = [0, 3600, 86400, 259200, 604800] as const;
export const expirationDate = (seconds: number): string | null =>
  seconds === 0 ? null : new Date(Date.now() + seconds * 1000).toISOString();
export const shareExpiry = (record: FileRecord): string | null => record.shareExpiresAt;
export const shareExpired = (record: FileRecord): boolean =>
  expired(record) || (shareExpiry(record) !== null && Date.parse(shareExpiry(record)!) <= Date.now());
export const validId = (id: string): boolean => /^[A-Za-z0-9_-]{8,10}$/.test(id);
const legacyFileId = (id: string): boolean => /^[A-Za-z0-9_-]{16}$/.test(id);
export const validUuidV4 = (id: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
// Accept existing 16-character file records; never generate new legacy IDs.
export const validStoredId = (id: string): boolean => validUuidV4(id) || legacyFileId(id);
// S3 object keys are relative to the bucket root, without a leading slash.
export const dataKey = (id: string): string =>
  (validUuidV4(id) ? "tuckbox/" : "files/") + id;
export const validObjectKey = (key: string): boolean =>
  (key.startsWith("tuckbox/") && validUuidV4(key.slice("tuckbox/".length))) ||
  (key.startsWith("files/") && legacyFileId(key.slice("files/".length)));
export const expired = (f: FileRecord): boolean =>
  f.expiresAt !== null && Date.parse(f.expiresAt) <= Date.now();
