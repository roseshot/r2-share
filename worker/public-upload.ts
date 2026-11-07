import type { Bindings, FileRecord } from "./model";
import { validId } from "./model";
import { initialShare } from "./shares";

export interface PublicUploadPage {
  id: string;
  label: string;
  storageId: string;
  expiresAt: string | null;
  maxUploads: number | null;
  completedUploads: number;
  createdAt: string;
}
interface PageRow {
  id: string; label: string; storage_id: string; expires_at: string | null;
  max_uploads: number | null; completed_uploads: number; created_at: string;
}

const toPage = (row: PageRow): PublicUploadPage => ({
  id: row.id, label: row.label, storageId: row.storage_id,
  expiresAt: row.expires_at, maxUploads: row.max_uploads,
  completedUploads: row.completed_uploads, createdAt: row.created_at,
});
const pendingCutoff = () => Date.now() - 600000;
const uploadingCutoff = () => Date.now() - 86400000;

export async function getPublicUploadPage(env: Bindings, id: string): Promise<PublicUploadPage | null> {
  if (!validId(id)) return null;
  const row = await env.DB.prepare(
    "SELECT id, label, storage_id, expires_at, max_uploads, completed_uploads, created_at " +
    "FROM public_upload_pages WHERE id = ?"
  ).bind(id).first<PageRow>();
  return row ? toPage(row) : null;
}

export async function listPublicUploadPages(env: Bindings): Promise<PublicUploadPage[]> {
  const rows = await env.DB.prepare(
    "SELECT id, label, storage_id, expires_at, max_uploads, completed_uploads, created_at " +
    "FROM public_upload_pages ORDER BY created_at DESC, id DESC LIMIT 100"
  ).all<PageRow>();
  return rows.results.map(toPage);
}

export async function createPublicUploadPage(env: Bindings, page: PublicUploadPage): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO public_upload_pages (id, label, storage_id, expires_at, max_uploads, " +
    "completed_uploads, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)"
  ).bind(page.id, page.label, page.storageId, page.expiresAt, page.maxUploads, page.createdAt).run();
}

export async function revokePublicUploadPage(env: Bindings, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM public_upload_pages WHERE id = ?").bind(id).run();
}

/** A single conditional INSERT arbitrates concurrent upload reservations in D1. */
export async function reservePublicUpload(env: Bindings, fileId: string, page: PublicUploadPage): Promise<boolean> {
  const now = Date.now();
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO upload_sessions " +
    "(id, storage_id, created_at, status, public_page_id) " +
    "SELECT ?, ?, ?, 'pending', ? WHERE EXISTS (" +
    "SELECT 1 FROM public_upload_pages p WHERE p.id = ? AND p.storage_id = ? " +
    "AND (p.expires_at IS NULL OR p.expires_at > ?) " +
    "AND (p.max_uploads IS NULL OR p.completed_uploads + (" +
    "SELECT COUNT(*) FROM upload_sessions s WHERE s.public_page_id = p.id " +
    "AND ((s.status = 'pending' AND s.created_at > ?) OR " +
    "(s.status = 'uploading' AND s.created_at > ?))" +
    ") < p.max_uploads))"
  ).bind(fileId, page.storageId, now, page.id, page.id, page.storageId,
    new Date(now).toISOString(), pendingCutoff(), uploadingCutoff()).run();
  return result.meta.changes === 1;
}

/** Only the token owner can claim a reserved page upload. */
export async function claimPublicUpload(env: Bindings, fileId: string, pageId: string, storageId: string) {
  const result = await env.DB.prepare(
    "UPDATE upload_sessions SET status = 'uploading' WHERE id = ? " +
    "AND public_page_id = ? AND storage_id = ? AND status = 'pending' AND created_at > ? " +
    "AND EXISTS (SELECT 1 FROM public_upload_pages WHERE id = ? " +
    "AND (expires_at IS NULL OR expires_at > ?))"
  ).bind(fileId, pageId, storageId, pendingCutoff(), pageId, new Date().toISOString()).run();
  return result.meta.changes === 1;
}

/**
 * Atomically increment completed count and persist the file + protected share.
 * Every following write is conditional on the previous write's changes() count;
 * if a page expired/revoked mid-upload, nothing is committed.
 */
export async function finishPublicUpload(env: Bindings, pageId: string, record: FileRecord): Promise<boolean> {
  const share = initialShare(record);
  const outcome = await env.DB.batch([
    env.DB.prepare(
      "UPDATE public_upload_pages SET completed_uploads = completed_uploads + 1 " +
      "WHERE id = ? AND storage_id = ? AND (expires_at IS NULL OR expires_at > ?) " +
      "AND (max_uploads IS NULL OR completed_uploads < max_uploads) " +
      "AND EXISTS (SELECT 1 FROM upload_sessions WHERE id = ? AND public_page_id = ? " +
      "AND storage_id = ? AND status = 'uploading')"
    ).bind(pageId, record.storageId, new Date().toISOString(),
      record.id, pageId, record.storageId),
    env.DB.prepare(
      "INSERT INTO files (id, record_json, created_at, expires_at) " +
      "SELECT ?, ?, ?, ? WHERE changes() = 1"
    ).bind(record.id, JSON.stringify(record), record.createdAt, record.expiresAt),
    env.DB.prepare(
      "INSERT INTO shares (id, file_id, label, mode, revision, encrypted_code_json, expires_at, created_at) " +
      "SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1"
    ).bind(share.id, share.fileId, share.label ?? "", share.mode, share.revision,
      share.encryptedCode ? JSON.stringify(share.encryptedCode) : null,
      share.expiresAt, share.createdAt),
    env.DB.prepare("DELETE FROM upload_sessions WHERE id = ? AND changes() = 1").bind(record.id),
  ]);
  return outcome.every(result => result.meta.changes === 1);
}

export async function publicPageAvailability(env: Bindings, page: PublicUploadPage) {
  const reserved = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM upload_sessions WHERE public_page_id = ? AND " +
    "((status = 'pending' AND created_at > ?) OR (status = 'uploading' AND created_at > ?))"
  ).bind(page.id, pendingCutoff(), uploadingCutoff()).first<{ count: number }>();
  const expired = page.expiresAt !== null && Date.parse(page.expiresAt) <= Date.now();
  const remaining = page.maxUploads === null ? null :
    Math.max(0, page.maxUploads - page.completedUploads - (reserved?.count ?? 0));
  return { active: !expired && (remaining === null || remaining > 0),
    expired, remaining, completedUploads: page.completedUploads };
}
