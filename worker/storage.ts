import type { Bindings, FileRecord } from "./model";
import { dataKey, validStorageId, validChecksums, validStoredId } from "./model";
import { getObjectStore, isStorageConfigured } from "./object-store";
import { createInitialShareStatement } from "./shares";
import { queueVirusTotalStatement } from "./virustotal";

interface FileRow { record_json: string }
interface FileIdRow { id: string }
interface UploadSessionRow { id: string; storage_id: string }
interface StorageUsageRow {
  storage_id: string;
  used_bytes: number;
  file_count: number;
  calculated_at: string;
}
export interface StorageUsage {
  storageId: string;
  usedBytes: number | null;
  fileCount: number | null;
  calculatedAt: string | null;
}

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
  await env.DB.batch([
    env.DB.prepare("DELETE FROM shares WHERE file_id = ?").bind(id),
    env.DB.prepare("DELETE FROM files WHERE id = ?").bind(id),
    ...(validChecksums(record.checksums) ? [
      env.DB.prepare(
        "DELETE FROM virustotal_queue WHERE sha256 = ? AND NOT EXISTS " +
        "(SELECT 1 FROM files WHERE json_extract(record_json, '$.checksums.sha256') = ?)"
      ).bind(record.checksums.sha256, record.checksums.sha256),
    ] : []),
  ]);
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

export async function finishUpload(env: Bindings, record: FileRecord, shareId: string): Promise<void> {
  if (!parseRecord(record)) throw new Error("Invalid file record");
  await env.DB.batch([
    recordStatement(env, record),
    createInitialShareStatement(env, record, shareId),
    env.DB.prepare("DELETE FROM upload_sessions WHERE id = ?").bind(record.id),
    ...(validChecksums(record.checksums) ?
      [queueVirusTotalStatement(env, record.checksums.sha256)] : []),
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

/**
 * Recalculate managed-file bytes from D1 for every configured storage ID.
 * The entire snapshot is replaced atomically, so deleted files and empty
 * storages are reflected after cleanup. Bucket objects outside files are
 * intentionally not counted.
 */
export async function recalculateStorageUsage(env: Bindings): Promise<void> {
  const now = new Date().toISOString();
  const totals = await env.DB.prepare(
    "SELECT json_extract(record_json, '$.storageId') AS storage_id, " +
    "COALESCE(SUM(CAST(json_extract(record_json, '$.size') AS INTEGER)), 0) AS used_bytes, " +
    "COUNT(*) AS file_count FROM files " +
    "WHERE json_type(record_json, '$.storageId') = 'text' " +
    "AND json_type(record_json, '$.size') = 'integer' " +
    "GROUP BY json_extract(record_json, '$.storageId')"
  ).all<{ storage_id: string; used_bytes: number; file_count: number }>();
  const byId = new Map(totals.results.map(row => [row.storage_id, row]));
  const storageIds = [...new Set((env.STORAGES ?? []).map(storage => storage.id))];
  await env.DB.batch([
    env.DB.prepare("DELETE FROM storage_usage"),
    ...storageIds.map(id => {
      const total = byId.get(id);
      return env.DB.prepare(
        "INSERT INTO storage_usage (storage_id, used_bytes, file_count, calculated_at) " +
        "VALUES (?, ?, ?, ?)"
      ).bind(id, total?.used_bytes ?? 0, total?.file_count ?? 0, now);
    }),
  ]);
}

/** Return the persisted cleanup snapshot; missing rows mean no cleanup has run yet. */
export async function getStorageUsage(env: Bindings, storageIds: string[]): Promise<StorageUsage[]> {
  if (!storageIds.length) return [];
  const rows = await env.DB.prepare(
    "SELECT storage_id, used_bytes, file_count, calculated_at FROM storage_usage"
  ).all<StorageUsageRow>();
  const byId = new Map(rows.results.map(row => [row.storage_id, row]));
  return storageIds.map(id => {
    const row = byId.get(id);
    return {
      storageId: id,
      usedBytes: row?.used_bytes ?? null,
      fileCount: row?.file_count ?? null,
      calculatedAt: row?.calculated_at ?? null,
    };
  });
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
  await recalculateStorageUsage(env);
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

export interface FilePageOptions {
  page: number;
  query?: string;
  storageId?: string;
  sort?: "newest" | "oldest";
}

export async function listFilePage(env: Bindings, { page, query = "", storageId = "", sort = "newest" }: FilePageOptions) {
  const pageSize = 25;
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 ||
      query.length > 100 || (storageId !== "" && !validStorageId(storageId)) ||
      !["newest", "oldest"].includes(sort)) throw new Error("Invalid file search");
  const where = ["(expires_at IS NULL OR expires_at > ?)"];
  const values: unknown[] = [new Date().toISOString()];
  if (query) {
    const escaped = query.replace(/[\\%_]/g, character => "\\" + character);
    where.push("LOWER(json_extract(record_json, '$.filename')) LIKE LOWER(?) ESCAPE '\\'");
    values.push("%" + escaped + "%");
  }
  if (storageId) {
    where.push("json_extract(record_json, '$.storageId') = ?");
    values.push(storageId);
  }
  const clause = where.join(" AND ");
  const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM files WHERE " + clause)
    .bind(...values).first<{ total: number }>();
  const total = count?.total ?? 0;
  const direction = sort === "oldest" ? "ASC" : "DESC";
  const rows = await env.DB.prepare(
    "SELECT record_json FROM files WHERE " + clause +
    " ORDER BY created_at " + direction + ", id " + direction + " LIMIT ? OFFSET ?"
  ).bind(...values, pageSize, (page - 1) * pageSize).all<FileRow>();
  const records = rows.results.map(row => parseRecord(JSON.parse(row.record_json)))
    .filter((record): record is FileRecord => record !== null);
  return { records, total, page, pageSize, hasMore: page * pageSize < total };
}
