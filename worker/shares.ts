import type { Bindings, FileRecord, ShareRecord, EncryptedCode } from "./model";
import { validId } from "./model";

interface ShareRow {
  id: string; file_id: string; mode: "public" | "protected"; revision: string;
  encrypted_code_json: string | null; expires_at: string | null; created_at: string;
}

function parseShare(row: ShareRow): ShareRecord {
  if (!validId(row.id) || !validId(row.file_id) ||
      (row.mode !== "public" && row.mode !== "protected") ||
      typeof row.revision !== "string") throw new Error("Invalid share record");
  const encryptedCode = row.encrypted_code_json
    ? JSON.parse(row.encrypted_code_json) as EncryptedCode : undefined;
  return {
    id: row.id, fileId: row.file_id, mode: row.mode, revision: row.revision,
    encryptedCode, expiresAt: row.expires_at, createdAt: row.created_at,
  };
}

function insertShareStatement(env: Bindings, share: ShareRecord) {
  if (!validId(share.id) || !validId(share.fileId)) throw new Error("Invalid share ID");
  return env.DB.prepare(
    "INSERT INTO shares (id, file_id, mode, revision, encrypted_code_json, expires_at, created_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(share.id, share.fileId, share.mode, share.revision,
    share.encryptedCode ? JSON.stringify(share.encryptedCode) : null,
    share.expiresAt, share.createdAt);
}

export function initialShare(record: FileRecord): ShareRecord {
  return {
    id: record.id, fileId: record.id, mode: record.mode,
    revision: record.revision, encryptedCode: record.encryptedCode,
    expiresAt: record.shareExpiresAt, createdAt: record.createdAt,
  };
}

export async function getShare(env: Bindings, id: string): Promise<ShareRecord | null> {
  if (!validId(id)) return null;
  const row = await env.DB.prepare(
    "SELECT id, file_id, mode, revision, encrypted_code_json, expires_at, created_at " +
    "FROM shares WHERE id = ?"
  ).bind(id).first<ShareRow>();
  return row ? parseShare(row) : null;
}

export async function listShares(env: Bindings, fileId: string): Promise<ShareRecord[]> {
  const result = await env.DB.prepare(
    "SELECT id, file_id, mode, revision, encrypted_code_json, expires_at, created_at " +
    "FROM shares WHERE file_id = ? ORDER BY created_at DESC, id DESC"
  ).bind(fileId).all<ShareRow>();
  return result.results.map(parseShare);
}

export async function listSharesForFiles(env: Bindings, maximum = 500): Promise<ShareRecord[]> {
  const result = await env.DB.prepare(
    "SELECT id, file_id, mode, revision, encrypted_code_json, expires_at, created_at FROM shares " +
    "WHERE file_id IN (SELECT id FROM files ORDER BY created_at DESC, id DESC LIMIT ?) " +
    "ORDER BY created_at DESC, id DESC"
  ).bind(maximum).all<ShareRow>();
  return result.results.map(parseShare);
}

export async function createShare(env: Bindings, share: ShareRecord): Promise<void> {
  await insertShareStatement(env, share).run();
}

export async function updateShare(env: Bindings, share: ShareRecord): Promise<void> {
  await env.DB.prepare(
    "UPDATE shares SET mode = ?, revision = ?, encrypted_code_json = ?, expires_at = ? " +
    "WHERE id = ? AND file_id = ?"
  ).bind(share.mode, share.revision,
    share.encryptedCode ? JSON.stringify(share.encryptedCode) : null,
    share.expiresAt, share.id, share.fileId).run();
}

export async function deleteShare(env: Bindings, fileId: string, shareId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM shares WHERE id = ? AND file_id = ?")
    .bind(shareId, fileId).run();
}

/** Save a completed upload and its first link atomically. */
export function createInitialShareStatement(env: Bindings, record: FileRecord) {
  return insertShareStatement(env, initialShare(record));
}
