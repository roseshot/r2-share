import { describe, expect, test } from "bun:test";
import handler from "../worker/index";
import { b64, signToken } from "../worker/crypto";
import { bindTestSettings } from "../worker/app-config";
import { bindObjectStore } from "../worker/object-store";
import { createTestDatabase } from "./d1-helper";
import { getRecord } from "../worker/storage";
import { getPublicUploadPage, publicPageAvailability } from "../worker/public-upload";
import { dataKey, type Bindings, type StorageConfig } from "../worker/model";

const origin = "https://upload.example.test";
const storage: StorageConfig = { id: "b2-primary", backend: "b2",
  bucket: "private-file-bucket", region: "us-west-004",
  keyId: "b2-key-1234", applicationKey: "b2-secret-1234" };

function fixture() {
  const objects = new Map<string, string>();
  let failNext = false;
  const env = {
    DB: createTestDatabase(),
    ADMIN_PATH: "hidden-admin", ADMIN_PASSWORD: "secret-password",
    SESSION_SECRET: "s".repeat(48),
    CODE_ENCRYPTION_KEY: b64(new Uint8Array(32)),
    STORAGES: [storage],
    CODE_LIMITER: { limit: async () => ({ success: true }) },
    LOGIN_LIMITER: { limit: async () => ({ success: true }) },
    ASSETS: { fetch: async () => new Response("<!doctype html>") },
  } as unknown as Bindings;
  bindTestSettings(env);
  bindObjectStore(env, {
    get: async key => objects.has(key) ? {
      body: new Response(objects.get(key)).body!, size: objects.get(key)!.length,
      uploaded: new Date(),
    } : null,
    head: async key => objects.has(key) ? { size: objects.get(key)!.length, uploaded: new Date() } : null,
    async put(key: string, body: ReadableStream<Uint8Array>) {
      const value = await new Response(body).text();
      if (failNext) { failNext = false; throw new Error("Injected store failure"); }
      objects.set(key, value);
      return { size: new TextEncoder().encode(value).length, uploaded: new Date() };
    },
    delete: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
    list: async () => ({ objects: [], truncated: false }),
  }, storage.id);
  const request = (path: string, init: RequestInit = {}) =>
    handler.fetch(new Request(origin + path, init), env, {} as ExecutionContext);
  async function cookie() {
    return "r2_share_admin=" + await signToken(env.SESSION_SECRET, {
      scope: "admin", entry: env.ADMIN_PATH, exp: Date.now() + 60000,
    });
  }
  async function admin(path: string, method = "GET", body?: object) {
    return request("/hidden-admin/api" + path, {
      method,
      headers: { Origin: origin, Cookie: await cookie(),
        ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function create(expiresIn = 3600, maxUploads: number | null = 2) {
    const response = await admin("/public-uploads", "POST", {
      label: "Community uploads", storageId: storage.id, expiresIn, maxUploads,
    });
    expect(response.status).toBe(201);
    return (await response.json() as { page: { id: string } }).page.id;
  }
  async function initiate(pageId: string, name = "test.txt", size = 4) {
    return request("/api/public-uploads/" + pageId + "/files", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ filename: name, size, mime: "text/plain" }),
    });
  }
  async function put(pageId: string, session: { id: string; token: string }, text = "test") {
    return request("/api/public-uploads/" + pageId + "/files/" + session.id, {
      method: "PUT", headers: { Origin: origin, "X-Upload-Token": session.token },
      body: text,
    });
  }
  return { env, objects, request, admin, create, initiate, put,
    failStore: () => { failNext = true; } };
}

describe("public upload pages", () => {
  test("restricts creation, listing and revocation to administrators", async () => {
    const app = fixture();
    expect((await app.request("/hidden-admin/api/public-uploads")).status).toBe(401);
    expect((await app.request("/hidden-admin/api/public-uploads", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "bad", storageId: storage.id, expiresIn: 3600 }),
    })).status).toBe(401);
    const id = await app.create();
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const list = await app.admin("/public-uploads");
    expect((await list.json() as { pages: { id: string }[] }).pages[0].id).toBe(id);
    const html = await app.request("/u/" + id);
    expect(html.status).toBe(200);
    expect((await app.request("/api/public-uploads/AbC123xy")).status).toBe(404);
    for (const path of ["/u/not-valid", "/u/ABCDEFGHIJKLMNOP", "/upload/" + id]) {
      const unknown = await app.request(path);
      expect(unknown.status).toBe(302);
      expect(unknown.headers.get("Location")).toBe("/");
    }
    expect((await app.request("/hidden-admin/api/public-uploads/" + id, {
      method: "DELETE", headers: { Origin: origin },
    })).status).toBe(401);
    expect((await app.admin("/public-uploads/" + id, "DELETE")).status).toBe(200);
    const removedPage = await app.request("/u/" + id);
    expect(removedPage.status).toBe(302);
    expect(removedPage.headers.get("Location")).toBe("/");
    expect((await app.request("/api/public-uploads/" + id)).status).toBe(404);
    expect((await app.initiate(id)).status).toBe(404);
  });

  test("validates time, count and storage constraints", async () => {
    const app = fixture();
    for (const body of [
      { label: "", storageId: storage.id, expiresIn: 3600 },
      { label: "x", storageId: "unknown", expiresIn: 3600 },
      { label: "x", storageId: storage.id, expiresIn: 0, maxUploads: null },
      { label: "x", storageId: storage.id, expiresIn: 123 },
      { label: "x", storageId: storage.id, expiresIn: 0, maxUploads: 0 },
      { label: "x", storageId: storage.id, expiresIn: 0, maxUploads: 1001 },
    ]) expect((await app.admin("/public-uploads", "POST", body)).status).toBe(400);
    const id = await app.create(0, 1);
    expect((await getPublicUploadPage(app.env, id))?.expiresAt).toBeNull();
    expect((await getPublicUploadPage(app.env, id))?.maxUploads).toBe(1);
    const timed = await app.create(3600, null);
    expect((await getPublicUploadPage(app.env, timed))?.expiresAt).not.toBeNull();
  });

  test("one file uses one slot; concurrent reservations cannot exceed the quota", async () => {
    const app = fixture();
    const id = await app.create(0, 1);
    const [a, b] = await Promise.all([app.initiate(id), app.initiate(id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const start = await (a.status === 200 ? a : b).json() as { id: string; shareId: string; token: string };
    expect((await app.request("/api/public-uploads/" + id)).status).toBe(200);
    expect((await app.put(id, start)).status).toBe(200);
    expect(start.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(dataKey(start.id)).toBe("tuckbox/" + start.id);
    expect(start.shareId).toMatch(/^[A-Za-z0-9_-]{8,10}$/);
    expect(app.objects.get(dataKey(start.id))).toBe("test");
    const record = await getRecord(app.env, start.id);
    expect(record?.mode).toBe("protected");
    expect(record?.encryptedCode).toBeDefined();
    expect((await app.request("/api/files/" + start.shareId)).status).toBe(200);
    const queued = await app.env.DB.prepare(
      "SELECT sha256 FROM virustotal_queue"
    ).all<{ sha256: string }>();
    expect(queued.results).toHaveLength(1);
    expect(queued.results[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await (await app.request("/api/files/" + start.shareId)).json())
      .toEqual({ id: start.shareId, mode: "protected" });
    expect((await app.request("/api/files/" + start.shareId + "/download")).status).toBe(403);
    expect((await app.initiate(id)).status).toBe(409);
    const page = await getPublicUploadPage(app.env, id);
    expect(page?.completedUploads).toBe(1);
    expect((await publicPageAvailability(app.env, page!)).active).toBe(false);
    expect((await app.request("/api/public-uploads/" + id).then(r => r.json()) as { active: boolean }).active)
      .toBe(false);
  });

  test("only successful uploads count; failed storage transfers release reservations", async () => {
    const app = fixture();
    const id = await app.create(3600, 1);
    const start = await (await app.initiate(id)).json() as { id: string; token: string };
    app.failStore();
    const failed = await app.put(id, start);
    expect(failed.status).toBe(500);
    expect((await getPublicUploadPage(app.env, id))?.completedUploads).toBe(0);
    expect(app.objects.size).toBe(0);
    const retry = await app.initiate(id);
    expect(retry.status).toBe(200);
    const replacement = await retry.json() as { id: string; token: string };
    expect((await app.put(id, replacement)).status).toBe(200);
    expect((await getPublicUploadPage(app.env, id))?.completedUploads).toBe(1);
  });

  test("expiry and revocation stop previously authorized transfers", async () => {
    const app = fixture();
    const id = await app.create(3600, 3);
    const start = await (await app.initiate(id)).json() as { id: string; token: string };
    await app.env.DB.prepare("UPDATE public_upload_pages SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), id).run();
    const info = await app.request("/api/public-uploads/" + id);
    expect((await info.json() as { expired: boolean }).expired).toBe(true);
    expect((await app.initiate(id)).status).toBe(409);
    expect((await app.put(id, start)).status).toBe(409);
    expect((await getPublicUploadPage(app.env, id))?.completedUploads).toBe(0);

    const active = await app.create(3600, 2);
    const second = await (await app.initiate(active)).json() as { id: string; token: string };
    await app.admin("/public-uploads/" + active, "DELETE");
    expect((await app.put(active, second)).status).toBe(404);
    expect(app.objects.has(dataKey(second.id))).toBe(false);
  });

  test("rejects CSRF, mismatched tokens and oversize uploads", async () => {
    const app = fixture();
    const id = await app.create();
    expect((await app.request("/api/public-uploads/" + id + "/files", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "x.txt", size: 4 }),
    })).status).toBe(403);
    expect((await app.initiate(id, "large", 91 * 1024 * 1024)).status).toBe(400);
    const session = await (await app.initiate(id)).json() as { id: string; token: string };
    expect((await app.request("/api/public-uploads/" + id + "/files/" + session.id, {
      method: "PUT", headers: { "X-Upload-Token": session.token }, body: "test",
    })).status).toBe(403);
    expect((await app.request("/api/public-uploads/" + id + "/files/" + session.id, {
      method: "PUT", headers: { Origin: origin, "X-Upload-Token": "bad" }, body: "test",
    })).status).toBe(403);
    expect((await app.put(id, session)).status).toBe(200);
    expect((await app.put(id, session)).status).toBe(409);
  });
});
