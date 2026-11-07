import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import handler from "../worker/index";
import { encryptCode, signToken } from "../worker/crypto";
import { EXPIRATIONS, dataKey, expired, shareExpired, type Bindings, type FileRecord } from "../worker/model";
import { bindObjectStore } from "../worker/object-store";
import { bindTestSettings } from "../worker/app-config";
import { cleanupExpired, deleteRecord, getRecord, saveRecord as saveFileRecord } from "../worker/storage";
import { initialShare, getShare, createShare, updateShare } from "../worker/shares";
import { createTestDatabase } from "./d1-helper";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const origin = "https://files.example.test";
const id = "A_-a".repeat(2);

async function saveRecord(env: Bindings, record: FileRecord): Promise<void> {
  await saveFileRecord(env, record);
  const primary = initialShare(record);
  if (await getShare(env, record.id)) await updateShare(env, primary);
  else await createShare(env, primary);
}


function setup() {
  const objects = new Map<string, string>();
  const stored = (name: string) => {
    const content = objects.get(name);
    return content === undefined ? null : {
      body: new Response(content).body!,
      size: new TextEncoder().encode(content).length,
      uploaded: new Date(Date.now() - 5000),
    };
  };
  const bucket = {
    get: async (name: string) => stored(name),
    head: async (name: string) => {
      const found = stored(name);
      return found && { size: found.size, uploaded: found.uploaded };
    },
    put: async (name: string, content: string | ReadableStream<Uint8Array>) => {
      const value = typeof content === "string" ? content : await new Response(content).text();
      objects.set(name, value);
      return { size: new TextEncoder().encode(value).length, uploaded: new Date() };
    },
    delete: async (names: string | string[]) => {
      for (const name of Array.isArray(names) ? names : [names]) objects.delete(name);
    },
    list: async (options: { prefix: string; limit: number }) => {
      const matched = [...objects.keys()].filter(name => name.startsWith(options.prefix)).sort();
      return {
        objects: matched.slice(0, options.limit)
          .map(name => ({ key: name, uploaded: new Date(Date.now() - 86400000 * 2) })),
        truncated: matched.length > options.limit,
      };
    },
  };
  const env = {
    DB: createTestDatabase(),
    STORAGES: [{ id: "main-b2", backend: "b2", bucket: "test-private-bucket",
      region: "us-west-004", keyId: "test-key-id", applicationKey: "test-application-key" }],
    ADMIN_PATH: "secret",
    ADMIN_PASSWORD: "password123",
    SESSION_SECRET: "s".repeat(48),
    CODE_ENCRYPTION_KEY: key,
    CODE_LIMITER: { limit: async () => ({ success: true }) },
    LOGIN_LIMITER: { limit: async () => ({ success: true }) },
    ASSETS: {
      fetch: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
    },
  } as unknown as Bindings;
  bindObjectStore(env, bucket, "main-b2");
  bindTestSettings(env);

  async function request(path: string, options: RequestInit = {}) {
    return handler.fetch(new Request(origin + path, options), env, {} as ExecutionContext);
  }

  async function adminCookie() {
    const token = await signToken(env.SESSION_SECRET, {
      scope: "admin", entry: "secret", exp: Date.now() + 60000,
    });
    return "r2_share_admin=" + token;
  }

  function record(fields: Partial<FileRecord> = {}): FileRecord {
    return {
      id,
      storageId: "main-b2",
      filename: "private-document.txt",
      size: 6,
      mime: "text/plain",
      mode: "protected",
      createdAt: new Date().toISOString(),
      expiresAt: null,
      shareExpiresAt: null,
      revision: "revision-1",
      ...fields,
    };
  }

  return { env, objects, bucket, request, adminCookie, record };
}

describe("independent file and share expiration", () => {
  test("supports permanent and durations of at least one hour", () => {
    expect(EXPIRATIONS).toEqual([0, 3600, 86400, 259200, 604800]);
    const now = new Date().toISOString();
    const existing = setup().record({
      expiresAt: now,
      shareExpiresAt: null,
    });
    expect(expired(existing)).toBe(true);
    expect(shareExpired(existing)).toBe(true);
    existing.expiresAt = null;
    expect(expired(existing)).toBe(false);
    expect(shareExpired(existing)).toBe(false);
    existing.shareExpiresAt = now;
    expect(expired(existing)).toBe(false);
    expect(shareExpired(existing)).toBe(true);
  });

  test("requires an access code before revealing file information or downloading", async () => {
    const app = setup();
    const entry = app.record();
    entry.encryptedCode = await encryptCode("open1234", id, entry.revision, key);
    await saveRecord(app.env, entry);
    app.objects.set(dataKey(id), "secret");

    const first = await app.request("/api/files/" + id);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ id, mode: "protected" });
    const denied = await app.request("/api/files/" + id + "/download");
    expect(denied.status).toBe(403);

    const wrong = await app.request("/api/files/" + id + "/unlock", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "invalid" }),
    });
    expect(wrong.status).toBe(403);
    expect(wrong.headers.get("Set-Cookie")).toBeNull();

    const unlock = await app.request("/api/files/" + id + "/unlock", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "open1234" }),
    });
    expect(unlock.status).toBe(200);
    const setCookie = unlock.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=86400");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("HttpOnly");
    const cookie = setCookie.split(";")[0];

    const details = await app.request("/api/files/" + id, { headers: { Cookie: cookie } });
    expect(await details.json()).toEqual({
      id, filename: "private-document.txt", size: 6, mime: "text/plain", mode: "protected",
    });
    const download = await app.request("/api/files/" + id + "/download", { headers: { Cookie: cookie } });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("secret");
  });

  test("remembers protected share authorization across visits for 24 hours", async () => {
    const app = setup();
    const entry = app.record();
    entry.encryptedCode = await encryptCode("open1234", id, entry.revision, key);
    await saveRecord(app.env, entry);
    app.objects.set(dataKey(id), "secret");

    const unlock = await app.request("/api/files/" + id + "/unlock", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "open1234" }),
    });
    expect(unlock.status).toBe(200);
    const cookie = unlock.headers.get("Set-Cookie")!.split(";")[0];
    const token = cookie.split("=")[1];
    const claims = await (await import("../worker/crypto")).readToken(app.env.SESSION_SECRET, token);
    expect(claims?.scope).toBe("download");
    expect(claims?.exp).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);
    expect(claims?.exp).toBeLessThanOrEqual(Date.now() + 24 * 3600 * 1000);

    const revisit = await app.request("/" + id, { headers: { Cookie: cookie } });
    expect(revisit.status).toBe(200);
    const file = await app.request("/api/files/" + id, { headers: { Cookie: cookie } });
    expect((await file.json() as { filename: string }).filename).toBe(entry.filename);
    const download = await app.request("/api/files/" + id + "/download", { headers: { Cookie: cookie } });
    expect(download.status).toBe(200);
  });

  test("clears remembered authorization when a share expires or is deleted", async () => {
    const app = setup();
    const entry = app.record({
      shareExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    entry.encryptedCode = await encryptCode("open1234", id, entry.revision, key);
    await saveRecord(app.env, entry);
    const token = await signToken(app.env.SESSION_SECRET, {
      scope: "download", id, revision: entry.revision, exp: Date.now() + 60000,
    });
    const cookie = "r2_access_" + id + "=" + token;
    entry.shareExpiresAt = new Date(Date.now() - 1000).toISOString();
    await saveRecord(app.env, entry);

    const expiredPage = await app.request("/" + id, { headers: { Cookie: cookie } });
    expect(expiredPage.status).toBe(200); // Branded unavailable page renders first.
    const expiredMetadata = await app.request("/api/files/" + id, { headers: { Cookie: cookie } });
    expect(expiredMetadata.status).toBe(200);
    expect(await expiredMetadata.json()).toMatchObject({ id, mode: "public" });
    expect(expiredMetadata.headers.get("Set-Cookie")).toContain("Max-Age=0");
    const expiredDownload = await app.request("/api/files/" + id + "/download", {
      headers: { Cookie: cookie },
    });
    expect(expiredDownload.status).toBe(404);
    expect(expiredDownload.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(expiredDownload.headers.get("Set-Cookie")).toContain("Path=/");
    await deleteRecord(app.env, id);
    const deleted = await app.request("/" + id, { headers: { Cookie: cookie } });
    expect(deleted.status).toBe(200);
    const deletedMetadata = await app.request("/api/files/" + id, { headers: { Cookie: cookie } });
    expect(deletedMetadata.status).toBe(200);
    expect(await deletedMetadata.json()).toMatchObject({ id, mode: "public" });
    expect(deletedMetadata.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  test("invalidates an existing share authorization after settings change", async () => {
    const app = setup();
    const entry = app.record();
    entry.encryptedCode = await encryptCode("open1234", id, entry.revision, key);
    await saveRecord(app.env, entry);
    const token = await signToken(app.env.SESSION_SECRET, {
      scope: "download", id, revision: "previous-revision", exp: Date.now() + 60000,
    });
    const cookie = "r2_access_" + id + "=" + token;
    const response = await app.request("/api/files/" + id, { headers: { Cookie: cookie } });
    expect(await response.json()).toEqual({ id, mode: "protected" });
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  test("requires the same access-code authorization for inline previews", async () => {
    const app = setup();
    const entry = app.record({ filename: "notes.txt", mime: "text/plain" });
    entry.encryptedCode = await encryptCode("open1234", id, entry.revision, key);
    await saveRecord(app.env, entry);
    app.objects.set(dataKey(id), "secret");
    const path = "/api/files/" + id + "/preview";

    const denied = await app.request(path);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "Enter the access code first" });

    const unlock = await app.request("/api/files/" + id + "/unlock", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "open1234" }),
    });
    const cookie = unlock.headers.get("Set-Cookie")!.split(";")[0];
    const response = await app.request(path, { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe("inline");
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(await response.text()).toBe("secret");

    entry.revision = "revoked";
    await saveRecord(app.env, entry);
    const revoked = await app.request(path, { headers: { Cookie: cookie } });
    expect(revoked.status).toBe(403);
    expect(revoked.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  test("renders untrusted HTML as text and rejects unsupported inline previews", async () => {
    const app = setup();
    const entry = app.record({ mode: "public", filename: "page.html", mime: "text/html" });
    await saveRecord(app.env, entry);
    app.objects.set(dataKey(id), "<script>alert(1)</script>");
    const url = "/api/files/" + id + "/preview";
    const html = await app.request(url);
    expect(html.status).toBe(200);
    expect(html.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(html.headers.get("Content-Disposition")).toBe("inline");
    expect(await html.text()).toBe("<script>alert(1)</script>");
    entry.filename = "installer.exe";
    await saveRecord(app.env, entry);
    const denied = await app.request(url);
    expect(denied.status).toBe(400);
  });

  test("blocks preview when the public share has expired", async () => {
    const app = setup();
    const entry = app.record({
      mode: "public", filename: "notes.txt",
      shareExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await saveRecord(app.env, entry);
    app.objects.set(dataKey(id), "secret");
    const response = await app.request("/api/files/" + id + "/preview");
    expect(response.status).toBe(404);
  });

  test("hides all checksums until protected file access is authorized", async () => {
    const app = setup();
    const checksums = { sha256: "a".repeat(64) };
    const originalModifiedAt = "2023-07-05T14:25:12.000Z";
    const entry = app.record({ checksums, originalModifiedAt });
    entry.encryptedCode = await encryptCode("open1234", id, entry.revision, key);
    await saveRecord(app.env, entry);

    const before = await app.request("/api/files/" + id);
    expect(await before.json()).toEqual({ id, mode: "protected" });

    const unlock = await app.request("/api/files/" + id + "/unlock", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "open1234" }),
    });
    expect(unlock.status).toBe(200);
    const cookie = unlock.headers.get("Set-Cookie")!.split(";")[0];
    const after = await app.request("/api/files/" + id, { headers: { Cookie: cookie } });
    expect(await after.json()).toEqual({
      id, filename: entry.filename, size: entry.size, mime: entry.mime,
      checksums, originalModifiedAt, mode: "protected",
    });
  });

  test("validates original modified timestamps when creating uploads", async () => {
    const app = setup();
    const cookie = await app.adminCookie();
    const body = {
      filename: "test.txt", size: 6, mime: "text/plain", mode: "public", storageId: "main-b2",
      shareExpiresIn: 3600,
    };
    const post = (originalModifiedAt: unknown) => app.request("/secret/api/uploads", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ ...body, originalModifiedAt }),
    });
    expect((await post("not-a-date")).status).toBe(400);
    expect((await post("2025-01-01")).status).toBe(400);
    expect((await post("2025-99-01T00:00:00.000Z")).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect((await post("2025-01-01T00:00:00.000Z")).status).toBe(200);
    expect((await post(undefined)).status).toBe(200);
  });

  test("generates SHA-256 on the Worker after upload without a client digest", async () => {
    const app = setup();
    const cookie = await app.adminCookie();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("secret"))),
      byte => byte.toString(16).padStart(2, "0")).join("");
    const init = await app.request("/secret/api/uploads", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        filename: "test.txt", size: 6, mime: "text/plain", mode: "public", storageId: "main-b2",
        shareExpiresIn: 3600, originalModifiedAt: "2024-04-22T09:12:30.000Z",
      }),
    });
    expect(init.status).toBe(200);
    const created = await init.json() as { id: string; token: string };
    const result = await app.request("/secret/api/uploads/" + created.id, {
      method: "PUT", headers: { Origin: origin, Cookie: cookie, "X-Upload-Token": created.token },
      body: "secret",
    });
    expect(result.status).toBe(200);
    const stored = await getRecord(app.env, created.id);
    expect(stored?.expiresAt).toBeNull();
    expect(stored?.shareExpiresAt).not.toBeNull();
    expect(stored?.originalModifiedAt).toBe("2024-04-22T09:12:30.000Z");
    expect(stored?.checksums).toEqual({ sha256: digest });
    const response = await app.request("/api/files/" + created.id);
    const details = await response.json() as { checksums: { sha256: string } };
    expect(details.checksums).toEqual({ sha256: digest });
  });

  test("does not reveal expiration timestamps through public metadata", async () => {
    const app = setup();
    await saveRecord(app.env, app.record({ mode: "public", shareExpiresAt: null, expiresAt: null }));
    const result = await app.request("/api/files/" + id);
    expect(await result.json()).toEqual({
      id, filename: "private-document.txt", size: 6, mime: "text/plain", mode: "public",
    });
    const sharePage = readFileSync(new URL("../src/share.tsx", import.meta.url), "utf8");
    expect(sharePage).not.toContain("timeText");
    expect(sharePage).not.toContain("expiresAt");
    expect(sharePage).not.toContain("remaining");
  });

  test("share expiry blocks public access without deleting the stored file", async () => {
    const app = setup();
    await saveRecord(app.env, app.record({
      mode: "public", expiresAt: null,
      shareExpiresAt: new Date(Date.now() - 1000).toISOString(),
    }));
    app.objects.set(dataKey(id), "secret");
    expect((await app.request("/" + id)).status).toBe(200);
    const expiredMetadata = await app.request("/api/files/" + id);
    expect(expiredMetadata.status).toBe(200);
    expect(await expiredMetadata.json()).toMatchObject({ id, mode: "public" });
    expect((await app.request("/api/files/" + id + "/download")).status).toBe(404);
    expect(await cleanupExpired(app.env)).toBe(0);
    expect(await getRecord(app.env, id)).not.toBeNull();
    expect(app.objects.has(dataKey(id))).toBe(true);
    const list = await app.request("/secret/api/files", { headers: { Cookie: await app.adminCookie() } });
    expect(list.status).toBe(200);
    const result = await list.json() as { files: { shares: { shareExpiresAt: string | null }[] }[] };
    expect(result.files).toHaveLength(1);
    expect(result.files[0].shares).toHaveLength(1);
  });

  test("file expiry removes stored objects even if the share is permanent", async () => {
    const app = setup();
    await saveRecord(app.env, app.record({
      expiresAt: new Date(Date.now() - 1000).toISOString(), shareExpiresAt: null,
    }));
    app.objects.set(dataKey(id), "secret");
    expect(await cleanupExpired(app.env)).toBe(1);
    expect(await getRecord(app.env, id)).toBeNull();
    expect(app.objects.has(dataKey(id))).toBe(false);
  });

  test("permanent files and links survive cleanup", async () => {
    const app = setup();
    await saveRecord(app.env, app.record({ mode: "public" }));
    app.objects.set(dataKey(id), "secret");
    expect(await cleanupExpired(app.env)).toBe(0);
    expect((await app.request("/" + id)).status).toBe(200);
    expect((await app.request("/api/files/" + id + "/download")).status).toBe(200);
  });

  test("uploads retain files permanently and validate share expiration independently", async () => {
    const app = setup();
    const cookie = await app.adminCookie();
    const body = {
      filename: "test.txt", size: 6, mime: "text/plain", mode: "public", storageId: "main-b2",
      shareExpiresIn: 3600,
    };
    const post = (value: unknown) => app.request("/secret/api/uploads", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(value),
    });
    expect((await post({ ...body, shareExpiresIn: 600 })).status).toBe(400);
    expect((await post({ ...body, fileExpiresIn: 600 })).status).toBe(400);
    expect((await post({ ...body, fileExpiresIn: 0 })).status).toBe(400);
    expect((await post(body)).status).toBe(200);
    expect((await post({ ...body, shareExpiresIn: 0 })).status).toBe(200);
  });

  test("editing share expiration can re-enable a still-retained file", async () => {
    const app = setup();
    await saveRecord(app.env, app.record({
      mode: "public",
      expiresAt: null,
      shareExpiresAt: new Date(Date.now() - 3600000).toISOString(),
    }));
    const previouslyExpired = await app.request("/api/files/" + id);
    expect(previouslyExpired.status).toBe(200);
    expect(await previouslyExpired.json()).toMatchObject({ id, mode: "public" });
    const patch = await app.request("/secret/api/files/" + id, {
      method: "PATCH",
      headers: { Origin: origin, "Content-Type": "application/json", Cookie: await app.adminCookie() },
      body: JSON.stringify({ mode: "public", shareExpiresIn: 0 }),
    });
    expect(patch.status).toBe(200);
    expect((await app.request("/api/files/" + id)).status).toBe(200);
  });
  test("rejects a second upload using the same signed session", async () => {
    const app = setup();
    const cookie = await app.adminCookie();
    const init = await app.request("/secret/api/uploads", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ filename: "secret.txt", size: 6, mode: "public", storageId: "main-b2", shareExpiresIn: 3600 }),
    });
    const { id: uploadId, token } = await init.json() as { id: string; token: string };
    const send = () => app.request("/secret/api/uploads/" + uploadId, {
      method: "PUT", headers: { Origin: origin, Cookie: cookie, "X-Upload-Token": token }, body: "secret",
    });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(409);
    expect(await getRecord(app.env, uploadId)).not.toBeNull();
    expect(app.objects.has(dataKey(uploadId))).toBe(true);
  });

});
