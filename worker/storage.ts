import type { Bindings, FileRecord } from "./model";
import { dataKey, validStorageId, validChecksums, validStoredId } from "./model";
import { getObjectStore, isStorageConfigured } from "./object-store";

interface FileRow { record_json: string }
interface FileIdRow { id: string }
interface UploadSessionRow { id: string; storage_id: string }

function parseRecord(value: unknown): FileRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as FileRecord;
  if (!validStoredId(record.id) || typeof record.filename !== "string" ||
      !Number.isSafeInteger(record.size) || record.size < 1 ||
      typeof record.mime !== "string" || typeof record.createdAt !== "string" ||
      (record.mode !== "public" && record.mode !== "protected") ||
      typeof record.revision !== "string" ||
      !validStorageId(record.storageId) ||
      (record.expiresAt !== null && typeof record.expiresAt !== "string") ||
      (record.shareExpiresAt !== null && typeof record.shareExpiresAt !== "string") ||
      (record.checksums !== undefined && !validChecksums(record.checksums))) return null;
  return record;
}

function recordStatement(env: Bindings, record: FileRecord) {
  return env.DB.prepare(
    "INSERT INTO files (id, record_json, created_at, expires_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json, " +
    "created_at = excluded.created_at, expires_at = excluded.expires_at"
  ).bind(record.id, JSON.stringify(record), record.createdAt, record.expiresAt);
}

export async function getRecord(env: Bindings, id: string): Promise<FileRecord | null> {
  if (!validStoredId(id)) return null;
  const row = await env.DB.prepare("SELECT record_json FROM files WHERE id = ?").bind(id).first<FileRow>();
  return row ? parseRecord(JSON.parse(row.record_json)) : null;
}

export async function saveRecord(env: Bindings, record: FileRecord): Promise<void> {
  if (!parseRecord(record)) throw new Error("Invalid file record");
  await recordStatement(env, record).run();
}

export async function deleteRecord(env: Bindings, id: string): Promise<void> {
  const record = await getRecord(env, id);
  if (!record) return;
  await getObjectStore(env, record.storageId).delete(dataKey(id));
  await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(id).run();
}

export async function reserveUpload(env: Bindings, id: string, storageId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO upload_sessions (id, storage_id, created_at, status) VALUES (?, ?, ?, 'pending')"
  ).bind(id, storageId, Date.now()).run();
  return result.meta.changes === 1;
}

export async function claimUpload(env: Bindings, id: string, storageId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE upload_sessions SET status = 'uploading' " +
    "WHERE id = ? AND storage_id = ? AND status = 'pending' AND created_at > ?"
  ).bind(id, storageId, Date.now() - 600000).run();
  return result.meta.changes === 1;
}

export async function finishUpload(env: Bindings, record: FileRecord): Promise<void> {
  if (!parseRecord(record)) throw new Error("Invalid file record");
  await env.DB.batch([
    recordStatement(env, record),
    env.DB.prepare("DELETE FROM upload_sessions WHERE id = ?").bind(record.id),
  ]);
}

export async function abandonUpload(env: Bindings, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM upload_sessions WHERE id = ?").bind(id).run();
}

export async function listRecords(env: Bindings, maximum = 500):
  Promise<{ records: FileRecord[]; truncated: boolean }> {
  const result = await env.DB.prepare(
    "SELECT record_json FROM files ORDER BY created_at DESC, id DESC LIMIT ?"
  ).bind(maximum + 1).all<FileRow>();
  const records = result.results.slice(0, maximum)
    .map(row => parseRecord(JSON.parse(row.record_json)))
    .filter((record): record is FileRecord => record !== null);
  return { records, truncated: result.results.length > maximum };
}

export async function cleanupExpired(env: Bindings): Promise<number> {
  const expired = await env.DB.prepare(
    "SELECT id FROM files WHERE expires_at IS NOT NULL AND expires_at <= ? " +
    "ORDER BY expires_at LIMIT 10"
  ).bind(new Date().toISOString()).all<FileIdRow>();
  let removed = 0;
  for (const { id } of expired.results) {
    await deleteRecord(env, id);
    removed++;
  }

  const abandoned = await env.DB.prepare(
    "SELECT id, storage_id FROM upload_sessions WHERE created_at < ? ORDER BY created_at LIMIT 10"
  ).bind(Date.now() - 86400000).all<UploadSessionRow>();
  for (const { id, storage_id } of abandoned.results) {
    if (!validStorageId(storage_id)) throw new Error("Invalid upload session storage ID");
    if (!await getRecord(env, id) && isStorageConfigured(env, storage_id)) {
      await getObjectStore(env, storage_id).delete(dataKey(id));
    }
    await abandonUpload(env, id);
  }
  return removed;
}


/** Prevent removal or endpoint reassignment while files or uploads still reference a storage ID. */
export async function storageInUse(env: Bindings, storageId: string): Promise<boolean> {
  const file = await env.DB.prepare(
    "SELECT id FROM files WHERE json_extract(record_json, '$.storageId') = ? LIMIT 1"
  ).bind(storageId).first<FileIdRow>();
  if (file) return true;
  const session = await env.DB.prepare(
    "SELECT id FROM upload_sessions WHERE storage_id = ? LIMIT 1"
  ).bind(storageId).first<FileIdRow>();
  return session !== null;
}
