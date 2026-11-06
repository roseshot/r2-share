import { Hono } from "hono";
import { monitorUpload } from "./integrity";
import { previewFormat } from "../src/preview-types";
import { getVirusTotalReport } from "./virustotal";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Bindings, FileRecord, Mode, StorageConfig } from "./model";
import { MAX_FILE_BYTES, EXPIRATIONS, validId, validStorageId, dataKey, expired, shareExpired, shareExpiry, expirationDate, validChecksums, validStoredId } from "./model";
import { randomId, randomRevision, randomCode, signToken, readToken, equalText, encryptCode, decryptCode } from "./crypto";
import { getRecord, saveRecord, deleteRecord, listRecords, cleanupExpired, reserveUpload, claimUpload, finishUpload, abandonUpload, storageInUse } from "./storage";
import { getObjectStore, isStorageConfigured } from "./object-store";
import { resolveBindings, readAppSettings, saveAppSettings, validateSettings, validateStorage, publicStorage, type AppSettings } from "./app-config";

type Environment = { Bindings: Bindings };
const app = new Hono<Environment>();

const jsonError = (message: string, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503 = 400) =>
  new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const cookieName = "r2_share_admin";
const downloadCookie = (id: string) => "r2_access_" + id;
const shareAuthorizationDuration = 86400;
function clearShareAuthorization(c: import("hono").Context<Environment>, id: string) {
  deleteCookie(c, downloadCookie(id), { path: "/" });
}
const validEntry = (entry: string | undefined, env: Bindings): boolean =>
  !!entry && /^[a-zA-Z0-9_-]+$/.test(env.ADMIN_PATH ?? "") && entry === env.ADMIN_PATH;
const age = (seconds: number) => Date.now() + seconds * 1000;
const serialize = (record: FileRecord) => {
  const { encryptedCode: _private, expiresAt: _fileExpiry, ...publicRecord } = record;
  void _private;
  void _fileExpiry;
  return { ...publicRecord,
    fileExpiresAt: record.expiresAt, shareExpiresAt: shareExpiry(record) };
};

app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header("Cache-Control", "no-store");
  await next();
});

app.get("/", c => serveHtml(c.req.raw, c.env));
async function serveHtml(request: Request, env: Bindings): Promise<Response> {
  const target = new URL("/index.html", request.url);
  const response = await env.ASSETS.fetch(new Request(target, request));
  if (response.status >= 300 && response.status < 400) {
    return new Response("Unable to serve the HTML asset", { status: 502 });
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(response.body, { status: response.status, headers });
}

app.get("/api/files/:id", async c => {
  const id = c.req.param("id");
  if (!validId(id)) return jsonError("File not found", 404);
  const record = await getRecord(c.env, id);
  if (!record || shareExpired(record)) {
    clearShareAuthorization(c, id);
    return c.json({ error: "File not found or expired" }, 404);
  }
  if (record.mode === "protected") {
    const claims = await readToken(c.env.SESSION_SECRET, getCookie(c, downloadCookie(id)));
    if (!claims || claims.scope !== "download" || claims.id !== id || claims.revision !== record.revision) {
      if (getCookie(c, downloadCookie(id))) clearShareAuthorization(c, id);
      return c.json({ id: record.id, mode: "protected" });
    }
  }
  return c.json({ id: record.id, filename: record.filename, size: record.size, mime: record.mime,
    ...(validChecksums(record.checksums) ? { checksums: record.checksums } : {}),
    ...(record.originalModifiedAt ? { originalModifiedAt: record.originalModifiedAt } : {}),
    mode: record.mode });
});

app.post("/api/files/:id/unlock", async c => {
  if (!sameOrigin(c.req.raw)) return jsonError("Invalid request origin", 403);
  const id = c.req.param("id");
  if (!validId(id)) return jsonError("File not found", 404);
  const record = await getRecord(c.env, id);
  if (!record || shareExpired(record)) {
    clearShareAuthorization(c, id);
    return c.json({ error: "File not found or expired" }, 404);
  }
  if (record.mode !== "protected") return jsonError("This file does not require an access code");
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const limit = await c.env.CODE_LIMITER.limit({ key: (ip + ":" + id).slice(0, 220) });
  if (!limit.success) return jsonError("Too many attempts. Try again later.", 429);
  const body = await readJson<{ code?: string }>(c.req.raw);
  if (!body || typeof body.code !== "string" || body.code.length > 64) return jsonError("Invalid access code", 403);
  const original = await decryptCode(record, c.env.CODE_ENCRYPTION_KEY);
  if (!await equalText(body.code, original)) return jsonError("Invalid access code", 403);
  const token = await signToken(c.env.SESSION_SECRET, {
    scope: "download", id, revision: record.revision, exp: age(shareAuthorizationDuration)
  });
  setCookie(c, downloadCookie(id), token, { path: "/",
    httpOnly: true, secure: true, sameSite: "Strict", maxAge: shareAuthorizationDuration });
  return c.json({ ok: true });
});

async function streamFile(env: Bindings, record: FileRecord, preview = false): Promise<Response> {
  if (!isStorageConfigured(env, record.storageId)) return jsonError("Storage ID is not configured", 503);
  const object = await getObjectStore(env, record.storageId).get(dataKey(record.id));
  if (!object) return jsonError("File not found", 404);
  const filename = encodeURIComponent(record.filename);
  const format = previewFormat(record.filename, record.mime);
  if (preview && (!format || !format.contentType)) {
    await object.body.cancel();
    return jsonError("Preview not supported for this file type", 400);
  }
  return new Response(object.body, {
    headers: {
      "Content-Type": preview ? format!.contentType! : record.mime || "application/octet-stream",
      "Content-Disposition": preview ? "inline" :
        "attachment; filename=\"download\"; filename*=UTF-8''" + filename,
      "Content-Length": String(object.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...(preview ? { "Content-Security-Policy": "sandbox; default-src 'none'" } : {}),
    }
  });
}

app.get("/api/files/:id/preview", async c => {
  const id = c.req.param("id");
  if (!validId(id)) return jsonError("File not found", 404);
  const record = await getRecord(c.env, id);
  if (!record || shareExpired(record)) {
    clearShareAuthorization(c, id);
    return c.json({ error: "File not found or expired" }, 404);
  }
  if (record.mode === "protected") {
    const token = await readToken(c.env.SESSION_SECRET, getCookie(c, downloadCookie(id)));
    if (!token || token.scope !== "download" || token.id !== id || token.revision !== record.revision) {
      if (getCookie(c, downloadCookie(id))) clearShareAuthorization(c, id);
      return c.json({ error: "Enter the access code first" }, 403);
    }
  }
  return streamFile(c.env, record, true);
});

app.get("/api/files/:id/download", async c => {
  const id = c.req.param("id");
  if (!validId(id)) return jsonError("File not found", 404);
  const record = await getRecord(c.env, id);
  if (!record || shareExpired(record)) {
    clearShareAuthorization(c, id);
    return c.json({ error: "File not found or expired" }, 404);
  }
  if (record.mode === "protected") {
    const token = await readToken(c.env.SESSION_SECRET, getCookie(c, downloadCookie(id)));
    if (!token || token.scope !== "download" || token.id !== id || token.revision !== record.revision) {
      if (getCookie(c, downloadCookie(id))) clearShareAuthorization(c, id);
      return c.json({ error: "Enter the access code first" }, 403);
    }
  }
  return streamFile(c.env, record);
});

app.use("/:entry/api/*", async (c, next) => {
  const entry = c.req.param("entry");
  if (!validEntry(entry, c.env)) return c.notFound();
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !sameOrigin(c.req.raw)) {
    return jsonError("Invalid request origin", 403);
  }
  if (c.req.method === "POST" && c.req.path.endsWith("/login")) return next();
  const claims = await readToken(c.env.SESSION_SECRET, getCookie(c, cookieName));
  if (!claims || claims.scope !== "admin" || claims.entry !== entry ||
      (c.env.ADMIN_AUTH_REVISION && claims.revision !== c.env.ADMIN_AUTH_REVISION)) {
    return jsonError("Administrator sign-in required", 401);
  }
  await next();
});

app.post("/:entry/api/login", async c => {
  if (!c.env.ADMIN_PASSWORD || c.env.ADMIN_PASSWORD.length < 6 ||
      !c.env.SESSION_SECRET || c.env.SESSION_SECRET.length < 32 ||
      !c.env.CODE_ENCRYPTION_KEY) return jsonError("Service is not securely configured", 503);
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const limit = await c.env.LOGIN_LIMITER.limit({ key: ip });
  if (!limit.success) return jsonError("Too many sign-in attempts", 429);
  const payload = await readJson<{ password?: string }>(c.req.raw);
  if (typeof payload?.password !== "string" || payload.password.length > 256 ||
      !await equalText(payload.password, c.env.ADMIN_PASSWORD)) {
    return jsonError("Incorrect password", 401);
  }
  const entry = c.req.param("entry");
  const token = await signToken(c.env.SESSION_SECRET, {
    scope: "admin", entry, revision: c.env.ADMIN_AUTH_REVISION, exp: age(86400)
  });
  setCookie(c, cookieName, token, { path: "/" + entry, httpOnly: true,
    secure: true, sameSite: "Strict", maxAge: 86400 });
  return c.json({ ok: true });
});

app.get("/:entry/api/session", c => c.json({ authenticated: true, storage: "configured" }));

app.post("/:entry/api/logout", c => {
  deleteCookie(c, cookieName, { path: "/" + c.req.param("entry") });
  return c.json({ ok: true });
});

app.get("/:entry/api/settings", async c => {
  const settings = await readAppSettings(c.env);
  return c.json({
    storages: (settings?.storages ?? []).map(publicStorage),
    virusTotalEnabled: !!settings?.virusTotalApiKey,
  });
});

app.patch("/:entry/api/settings", async c => {
  const body = await readJson<Record<string, unknown>>(c.req.raw);
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => key !== "virusTotalApiKey") ||
      typeof body.virusTotalApiKey !== "string") return jsonError("Invalid settings request");
  const current = await readAppSettings(c.env) ?? { storages: [] };
  const updated: AppSettings = { ...current,
    virusTotalApiKey: body.virusTotalApiKey || undefined };
  try { validateSettings(updated); } catch { return jsonError("Invalid settings"); }
  await saveAppSettings(c.env, updated);
  return c.json({ ok: true });
});

async function verifyStorage(env: Bindings, storage: StorageConfig): Promise<boolean> {
  const candidate = Object.assign(Object.create(env) as Bindings, { STORAGES: [storage] });
  try {
    await getObjectStore(candidate, storage.id).list({ prefix: "files/", limit: 1 });
    return true;
  } catch { return false; }
}

app.post("/:entry/api/settings/storages", async c => {
  const body = await readJson<StorageConfig>(c.req.raw);
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("Invalid storage configuration");
  try { validateStorage(body); } catch { return jsonError("Invalid storage configuration"); }
  const current = await readAppSettings(c.env) ?? { storages: [] };
  if (current.storages.some(storage => storage.id === body.id)) return jsonError("Storage ID already exists", 409);
  const updated: AppSettings = { ...current, storages: [...current.storages, body] };
  try { validateSettings(updated); } catch { return jsonError("Invalid storage configuration"); }
  if (!await verifyStorage(c.env, body)) return jsonError("Unable to verify storage access", 503);
  await saveAppSettings(c.env, updated);
  return c.json({ ok: true, storage: publicStorage(body) }, 201);
});

app.patch("/:entry/api/settings/storages/:storageId", async c => {
  const id = c.req.param("storageId");
  if (!validStorageId(id)) return jsonError("Invalid storage ID");
  const body = await readJson<Record<string, unknown>>(c.req.raw);
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("Invalid storage configuration");
  const current = await readAppSettings(c.env);
  const existing = current?.storages.find(storage => storage.id === id);
  if (!current || !existing) return jsonError("Storage ID not found", 404);
  const allowed = existing.backend === "b2"
    ? ["bucket", "region", "keyId", "applicationKey"]
    : ["bucket", "accountId", "accessKeyId", "secretAccessKey"];
  if (Object.keys(body).some(key => !allowed.includes(key)) ||
      Object.values(body).some(value => typeof value !== "string")) {
    return jsonError("Invalid storage configuration");
  }
  const updatedStorage = { ...existing, ...body } as StorageConfig;
  try { validateStorage(updatedStorage); } catch { return jsonError("Invalid storage configuration"); }
  const changedLocation = existing.bucket !== updatedStorage.bucket ||
    (existing.backend === "b2" && updatedStorage.backend === "b2" &&
      existing.region !== updatedStorage.region) ||
    (existing.backend === "r2" && updatedStorage.backend === "r2" &&
      existing.accountId !== updatedStorage.accountId);
  if (changedLocation && await storageInUse(c.env, id)) {
    return jsonError("Storage contains files or active uploads; location cannot be changed", 409);
  }
  if (!await verifyStorage(c.env, updatedStorage)) return jsonError("Unable to verify storage access", 503);
  await saveAppSettings(c.env, { ...current, storages: current.storages.map(storage =>
    storage.id === id ? updatedStorage : storage) });
  return c.json({ ok: true, storage: publicStorage(updatedStorage) });
});

app.delete("/:entry/api/settings/storages/:storageId", async c => {
  const id = c.req.param("storageId");
  if (!validStorageId(id)) return jsonError("Invalid storage ID");
  const current = await readAppSettings(c.env);
  if (!current?.storages.some(storage => storage.id === id)) return jsonError("Storage ID not found", 404);
  if (await storageInUse(c.env, id)) {
    return jsonError("Storage contains files or active uploads; delete those first", 409);
  }
  await saveAppSettings(c.env, { ...current,
    storages: current.storages.filter(storage => storage.id !== id) });
  return c.json({ ok: true });
});

app.get("/:entry/api/files", async c => {
  const { records, truncated } = await listRecords(c.env);
  return c.json({ files: records.filter(r => !expired(r)).map(serialize), truncated });
});

app.post("/:entry/api/uploads", async c => {
  const body = await readJson<{
    filename?: string; size?: number; mime?: string; shareExpiresIn?: number; fileExpiresIn?: unknown;
    originalModifiedAt?: unknown;
    mode?: Mode; code?: string; storageId?: string;
  }>(c.req.raw);
  if (!body || typeof body.filename !== "string" || body.filename.length < 1 ||
      body.filename.length > 240 || /[\x00-\x1f\x7f]/.test(body.filename) ||
      !Number.isSafeInteger(body.size) || (body.size ?? 0) <= 0 || (body.size ?? 0) > MAX_FILE_BYTES ||
      body.fileExpiresIn !== undefined ||
      (body.originalModifiedAt !== undefined && (
        typeof body.originalModifiedAt !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(body.originalModifiedAt) ||
        !Number.isFinite(Date.parse(body.originalModifiedAt)) ||
        new Date(body.originalModifiedAt).toISOString() !== body.originalModifiedAt
      )) ||
      !EXPIRATIONS.some(x => x === body.shareExpiresIn) ||
      !["public", "protected"].includes(body.mode ?? "") ||
      !validStorageId(body.storageId)) {
    return jsonError("Invalid file parameters");
  }
  const mode = body.mode as Mode;
  const storageId = body.storageId!;
  if (!isStorageConfigured(c.env, storageId)) {
    return jsonError("Storage ID is not configured", 503);
  }
  if (body.code !== undefined && (typeof body.code !== "string" || body.code.length > 64)) {
    return jsonError("Access code is too long");
  }
  const code = mode === "protected" ? (body.code?.trim() || randomCode()) : undefined;
  if (code && code.length < 4) return jsonError("Access code must contain at least 4 characters");
  // Keep share links distinct from the private admin entry if it is 16 characters.
  let id = randomId();
  while (id === c.env.ADMIN_PATH || !await reserveUpload(c.env, id, storageId)) id = randomId();
  const revision = randomRevision();
  const mime = typeof body.mime === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(body.mime)
    ? body.mime : "application/octet-stream";
  const record: FileRecord = {
    id, revision, storageId, mode, mime, filename: body.filename, size: body.size!,
    ...(typeof body.originalModifiedAt === "string" ? { originalModifiedAt: body.originalModifiedAt } : {}),
    createdAt: new Date().toISOString(),
    expiresAt: null,
    shareExpiresAt: expirationDate(body.shareExpiresIn!),
    encryptedCode: code ? await encryptCode(code, id, revision, c.env.CODE_ENCRYPTION_KEY) : undefined
  };
  const token = await signToken(c.env.SESSION_SECRET, {
    scope: "upload", record, exp: age(600)
  });
  return c.json({ id, token, code: code ?? null });
});

app.put("/:entry/api/uploads/:id", async c => {
  const id = c.req.param("id");
  if (!validId(id)) return jsonError("Invalid upload request");
  const token = await readToken(c.env.SESSION_SECRET, c.req.header("X-Upload-Token"));
  if (!token || token.scope !== "upload" ||
      !token.record || typeof token.record !== "object" ||
      (token.record as FileRecord).id !== id) return jsonError("Invalid upload authorization", 403);
  const record = token.record as FileRecord;
  if (!validStorageId(record.storageId)) return jsonError("Invalid storage ID", 403);
  if (!isStorageConfigured(c.env, record.storageId)) {
    return jsonError("Storage ID is not configured", 503);
  }
  const lengthHeader = c.req.header("Content-Length");
  if (lengthHeader && Number(lengthHeader) !== record.size) return jsonError("File size mismatch");
  if (!c.req.raw.body) return jsonError("File is empty");
  if (!await claimUpload(c.env, id, record.storageId)) return jsonError("Upload already started or expired", 409);
  const store = getObjectStore(c.env, record.storageId);
  const integrity = monitorUpload(c.req.raw.body, record.size);
  try {
    const object = await store.put(dataKey(id), integrity.stream, record.mime, record.size);
    const checksums = await integrity.result();
    if (!object || object.size !== record.size || checksums.size !== record.size) {
      await store.delete(dataKey(id));
      await abandonUpload(c.env, id);
      return jsonError("File size mismatch or exceeds 90 MiB", 413);
    }
    record.checksums = { sha256: checksums.sha256 };
    await finishUpload(c.env, record);
    return c.json({ file: serialize(record) });
  } catch (error) {
    await store.delete(dataKey(id));
    await abandonUpload(c.env, id);
    throw error;
  }
});

app.get("/:entry/api/files/:id/virustotal", async c => {
  const id = c.req.param("id");
  if (!validStoredId(id)) return jsonError("File not found", 404);
  const record = await getRecord(c.env, id);
  if (!record || expired(record)) return jsonError("File not found or expired", 404);
  if (!validChecksums(record.checksums)) {
    return c.json({ status: "unavailable", reason: "No verified SHA-256 for this file" });
  }
  return c.json(await getVirusTotalReport(record.checksums.sha256, c.env.VIRUSTOTAL_API_KEY));
});

app.get("/:entry/api/files/:id/code", async c => {
  const id = c.req.param("id");
  if (!validStoredId(id)) return jsonError("File not found", 404);
  const record = await getRecord(c.env, id);
  if (!record || expired(record)) return jsonError("File not found or expired", 404);
  if (record.mode !== "protected") return c.json({ code: null });
  return c.json({ code: await decryptCode(record, c.env.CODE_ENCRYPTION_KEY) });
});

app.patch("/:entry/api/files/:id", async c => {
  const id = c.req.param("id");
  if (!validStoredId(id)) return jsonError("File not found", 404);
  const record = await getRecord(c.env, id);
  if (!record || expired(record)) return jsonError("File not found or expired", 404);
  const body = await readJson<{
    mode?: Mode; code?: string; fileExpiresIn?: number; shareExpiresIn?: number;
  }>(c.req.raw);
  if (!body || !["public", "protected"].includes(body.mode ?? "") ||
      (body.fileExpiresIn !== undefined && !EXPIRATIONS.some(x => x === body.fileExpiresIn)) ||
      (body.shareExpiresIn !== undefined && !EXPIRATIONS.some(x => x === body.shareExpiresIn)) ||
      (body.code !== undefined && (typeof body.code !== "string" || body.code.length > 64))) {
    return jsonError("Invalid update parameters");
  }
  const mode = body.mode as Mode;
  let code: string | null = null;
  if (mode === "protected") {
    code = body.code?.trim() || (record.mode === "protected"
      ? await decryptCode(record, c.env.CODE_ENCRYPTION_KEY) : randomCode());
    if (code.length < 4) return jsonError("Access code must contain at least 4 characters");
  }
  const revision = randomRevision(); // Invalidates every previous download token.
  record.mode = mode;
  record.revision = revision;
  record.encryptedCode = code ? await encryptCode(code, id, revision, c.env.CODE_ENCRYPTION_KEY) : undefined;
  if (body.fileExpiresIn !== undefined) record.expiresAt = expirationDate(body.fileExpiresIn);
  if (body.shareExpiresIn !== undefined) record.shareExpiresAt = expirationDate(body.shareExpiresIn);
  await saveRecord(c.env, record);
  return c.json({ file: serialize(record), code });
});

app.delete("/:entry/api/files/:id", async c => {
  const id = c.req.param("id");
  if (!validStoredId(id)) return jsonError("File not found", 404);
  await deleteRecord(c.env, id);
  return c.json({ ok: true });
});

app.get("/:entry/api/files/:id/download", async c => {
  const id = c.req.param("id");
  if (!validStoredId(id)) return jsonError("File not found", 404);
  const record = await getRecord(c.env, id);
  if (!record || expired(record)) return jsonError("File not found or expired", 404);
  return streamFile(c.env, record);
});

app.get("/tuckbox-mark.svg", c => c.env.ASSETS.fetch(c.req.raw));

app.get("/:entry", async c => {
  const entry = c.req.param("entry");
  // The private admin entry always takes precedence over a sharing ID.
  if (validEntry(entry, c.env)) return serveHtml(c.req.raw, c.env);
  if (!validId(entry)) return c.notFound();
  const record = await getRecord(c.env, entry);
  if (!record || shareExpired(record)) {
    clearShareAuthorization(c, entry);
    return c.text("Not found", 404);
  }
  return serveHtml(c.req.raw, c.env);
});
app.get("/assets/*", c => c.env.ASSETS.fetch(c.req.raw));
// Vite dev server assets. No application HTML route is exposed here.
app.get("/@vite/*", c => c.env.ASSETS.fetch(c.req.raw));
app.get("/@react-refresh", c => c.env.ASSETS.fetch(c.req.raw));
app.get("/src/*", c => c.env.ASSETS.fetch(c.req.raw));
app.get("/node_modules/*", c => c.env.ASSETS.fetch(c.req.raw));

app.notFound(c => c.text("Not found", 404));
app.onError((error) => { console.error("Internal server error:", error.name); return jsonError("Internal server error", 500); });

async function readJson<T>(request: Request): Promise<T | null> {
  if (!(request.headers.get("Content-Type") ?? "").startsWith("application/json")) return null;
  try { return await request.json() as T; } catch { return null; }
}
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return !!origin && origin === new URL(request.url).origin;
}

export default {
  async fetch(request: Request, env: Bindings, context: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    const staticPage = path === "/" || path === "/tuckbox-mark.svg" ||
      ["/assets/", "/@vite/", "/src/", "/node_modules/"].some(prefix => path.startsWith(prefix)) ||
      path === "/@react-refresh";
    try {
      return await app.fetch(request, staticPage ? env : await resolveBindings(env), context);
    } catch {
      return jsonError("Service is not configured", 503);
    }
  },
  async scheduled(controller: ScheduledController, env: Bindings): Promise<void> {
    const configured = await resolveBindings(env);
    if (!await readAppSettings(env)) return;
    if (controller.cron === "0 */6 * * *") await cleanupExpired(configured);
  }
} satisfies ExportedHandler<Bindings>;
