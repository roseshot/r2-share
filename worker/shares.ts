import type { Bindings, FileRecord, ShareRecord, EncryptedCode } from "./model";
import { validId, validStoredId } from "./model";

interface ShareRow {
  id: string; file_id: string; mode: "public" | "protected"; revision: string;
  label: string; show_virustotal: number;
  encrypted_code_json: string | null; expires_at: string | null; created_at: string;
}

function parseShare(row: ShareRow): ShareRecord {
  if (!validId(row.id) || !validStoredId(row.file_id) ||
      (row.mode !== "public" && row.mode !== "protected") ||
      typeof row.revision !== "string") throw new Error("Invalid share record");
  const encryptedCode = row.encrypted_code_json
    ? JSON.parse(row.encrypted_code_json) as EncryptedCode : undefined;
  return {
    id: row.id, fileId: row.file_id, label: row.label,
    showVirusTotal: row.show_virustotal === 1,
    mode: row.mode, revision: row.revision,
    encryptedCode, expiresAt: row.expires_at, createdAt: row.created_at,
  };
}

function insertShareStatement(env: Bindings, share: ShareRecord) {
  if (!validId(share.id) || !validStoredId(share.fileId)) throw new Error("Invalid share ID");
  return env.DB.prepare(
    "INSERT INTO shares (id, file_id, label, mode, revision, encrypted_code_json, expires_at, created_at, show_virustotal) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(share.id, share.fileId, share.label ?? "", share.mode, share.revision,
    share.encryptedCode ? JSON.stringify(share.encryptedCode) : null,
    share.expiresAt, share.createdAt, share.showVirusTotal ? 1 : 0);
}

export function initialShare(record: FileRecord, shareId: string): ShareRecord {
  return {
    id: shareId, fileId: record.id, label: "", showVirusTotal: false, mode: record.mode,
    revision: record.revision, encryptedCode: record.encryptedCode,
    expiresAt: record.shareExpiresAt, createdAt: record.createdAt,
  };
}

export async function getPrimaryShare(env: Bindings, fileId: string): Promise<ShareRecord | null> {
  if (!validStoredId(fileId)) return null;
  const rows = await listShares(env, fileId);
  return rows.at(-1) ?? null;
}

export async function getShare(env: Bindings, id: string): Promise<ShareRecord | null> {
  if (!validId(id)) return null;
  const row = await env.DB.prepare(
    "SELECT id, file_id, label, mode, revision, encrypted_code_json, expires_at, created_at, show_virustotal " +
    "FROM shares WHERE id = ?"
  ).bind(id).first<ShareRow>();
  return row ? parseShare(row) : null;
}

export async function listShares(env: Bindings, fileId: string): Promise<ShareRecord[]> {
  const result = await env.DB.prepare(
    "SELECT id, file_id, label, mode, revision, encrypted_code_json, expires_at, created_at, show_virustotal " +
    "FROM shares WHERE file_id = ? ORDER BY created_at DESC, id DESC"
  ).bind(fileId).all<ShareRow>();
  return result.results.filter(row => validId(row.id)).map(parseShare);
}

export async function listSharesForFiles(env: Bindings, maximum = 500): Promise<ShareRecord[]> {
  const result = await env.DB.prepare(
    "SELECT id, file_id, label, mode, revision, encrypted_code_json, expires_at, created_at, show_virustotal FROM shares " +
    "WHERE file_id IN (SELECT id FROM files ORDER BY created_at DESC, id DESC LIMIT ?) " +
    "ORDER BY created_at DESC, id DESC"
  ).bind(maximum).all<ShareRow>();
  return result.results.filter(row => validId(row.id)).map(parseShare);
}

export async function createShare(env: Bindings, share: ShareRecord): Promise<void> {
  await insertShareStatement(env, share).run();
}

export async function updateShare(env: Bindings, share: ShareRecord): Promise<void> {
  await env.DB.prepare(
    "UPDATE shares SET label = ?, mode = ?, revision = ?, encrypted_code_json = ?, expires_at = ?, show_virustotal = ? " +
    "WHERE id = ? AND file_id = ?"
  ).bind(share.label ?? "", share.mode, share.revision,
    share.encryptedCode ? JSON.stringify(share.encryptedCode) : null,
    share.expiresAt, share.showVirusTotal ? 1 : 0, share.id, share.fileId).run();
}

export async function deleteShare(env: Bindings, fileId: string, shareId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM shares WHERE id = ? AND file_id = ?")
    .bind(shareId, fileId).run();
}

/** Save a completed upload and its first link atomically. */
export function createInitialShareStatement(env: Bindings, record: FileRecord, shareId: string) {
  return insertShareStatement(env, initialShare(record, shareId));
}

/** Fetch only the links associated with the current (possibly filtered) file page. */
export async function listSharesForFileIds(env: Bindings, fileIds: string[]): Promise<ShareRecord[]> {
  if (fileIds.length === 0) return [];
  if (fileIds.length > 50 || fileIds.some(id => !validStoredId(id))) throw new Error("Invalid file IDs");
  const placeholders = fileIds.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    "SELECT id, file_id, label, mode, revision, encrypted_code_json, expires_at, created_at, show_virustotal " +
    "FROM shares WHERE file_id IN (" + placeholders + ") ORDER BY created_at DESC, id DESC"
  ).bind(...fileIds).all<ShareRow>();
  return result.results.filter(row => validId(row.id)).map(parseShare);
}
