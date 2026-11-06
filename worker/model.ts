export interface Bindings {
  DB: D1Database;
  APP_MASTER_KEY: string;
  ADMIN_AUTH_REVISION?: string;
  B2_REGION?: string;
  B2_BUCKET?: string;
  B2_KEY_ID?: string;
  B2_APPLICATION_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
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
export const validBackend = (value: unknown): value is StorageBackend =>
  value === "b2" || value === "r2";
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
export interface FileRecord {
  id: string;
  backend: StorageBackend;
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
export const validId = (id: string): boolean => /^[A-Za-z0-9_-]{16}$/.test(id);
export const validStoredId = validId;
export const dataKey = (id: string): string => "files/" + id;
export const expired = (f: FileRecord): boolean =>
  f.expiresAt !== null && Date.parse(f.expiresAt) <= Date.now();
