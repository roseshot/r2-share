import { describe, expect, test } from "bun:test";
import { encryptAppSettings, decryptAppSettings, readAppSettings, deriveRuntimeKeys } from "../worker/app-config";
import { b64, readToken, signToken } from "../worker/crypto";
import { bindObjectStore } from "../worker/object-store";
import type { Bindings, StorageConfig } from "../worker/model";
import { createTestDatabase } from "./d1-helper";
import handler from "../worker/index";

const origin = "https://storage.example.test";
const master = b64(crypto.getRandomValues(new Uint8Array(32)));
const b2: StorageConfig = {
  id: "b2-primary", backend: "b2", bucket: "private-backups",
  region: "us-west-004", keyId: "b2-key-1234", applicationKey: "b2-secret-1234",
};
const b2Other: StorageConfig = {
  ...b2, id: "b2-secondary", bucket: "other-backups",
};
const r2: StorageConfig = {
  id: "r2-primary", backend: "r2", bucket: "private-r2",
  accountId: "a".repeat(32), accessKeyId: "r2-key-1234", secretAccessKey: "r2-secret-1234",
};
const r2Other: StorageConfig = { ...r2, id: "r2-secondary", bucket: "other-r2" };

function fixture() {
  const env = {
    DB: createTestDatabase(),
    ADMIN_PATH: "private", ADMIN_PASSWORD: "strong-admin-password",
    APP_MASTER_KEY: master,
    LOGIN_LIMITER: { limit: async () => ({ success: true }) },
    CODE_LIMITER: { limit: async () => ({ success: true }) },
    ASSETS: { fetch: async () => new Response("<!doctype html>") },
  } as unknown as Bindings;
  const store = {
    get: async () => null,
    head: async () => null,
    put: async () => ({ size: 4, uploaded: new Date() }),
    delete: async () => {},
    list: async () => ({ objects: [], truncated: false }),
  };
  for (const storage of [b2, b2Other, r2, r2Other]) bindObjectStore(env, store, storage.id);
  const request = (path: string, init: RequestInit = {}) =>
    handler.fetch(new Request(origin + path, init), env, {} as ExecutionContext);
  const post = (path: string, body: object, cookie: string, method = "POST") =>
    request("/private/api" + path, { method,
      headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body) });
  async function login() {
    const response = await request("/private/api/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
    });
    expect(response.status).toBe(200);
    return response.headers.get("Set-Cookie")!.split(";")[0];
  }
  return { env, request, post, login };
}

describe("encrypted storage configurations", () => {
  test("encrypts multiple independent B2/R2 storage IDs", async () => {
    const settings = { storages: [b2, b2Other, r2, r2Other], virusTotalApiKey: "api-key" };
    const cipher = await encryptAppSettings(master, settings);
    for (const credential of [b2.applicationKey, r2.secretAccessKey, "api-key"]) {
      expect(cipher).not.toContain(credential);
    }
    expect(await decryptAppSettings(master, cipher)).toEqual(settings);
    await expect(decryptAppSettings(b64(crypto.getRandomValues(new Uint8Array(32))), cipher))
      .rejects.toThrow();
    await expect(encryptAppSettings(master, { storages: [b2, b2] })).rejects.toThrow();
    await expect(encryptAppSettings(master, { storages: [{ ...b2, id: "Bad ID" }] }))
      .rejects.toThrow();
  });

  test("derives separate session and code keys", async () => {
    const keys = await deriveRuntimeKeys(master);
    expect(keys.SESSION_SECRET).not.toBe(keys.CODE_ENCRYPTION_KEY);
    const token = await signToken(keys.SESSION_SECRET, { scope: "admin", exp: Date.now() + 60000 });
    expect((await readToken(keys.SESSION_SECRET, token))?.scope).toBe("admin");
    expect(await readToken(keys.CODE_ENCRYPTION_KEY, token)).toBeNull();
  });

  test("adds multiple backends and never exposes credentials through settings", async () => {
    const app = fixture();
    const cookie = await app.login();
    const empty = await app.request("/private/api/settings", { headers: { Cookie: cookie } });
    expect(await empty.json()).toEqual({ storages: [], storageUsage: [], virusTotalEnabled: false });
    for (const storage of [b2, b2Other, r2, r2Other]) {
      const response = await app.post("/settings/storages", storage, cookie);
      expect(response.status).toBe(201);
    }
    const duplicate = await app.post("/settings/storages", b2, cookie);
    expect(duplicate.status).toBe(409);

    const stored = await readAppSettings(app.env);
    expect(stored?.storages).toEqual([b2, b2Other, r2, r2Other]);
    const row = await app.env.DB.prepare("SELECT payload FROM app_settings WHERE id = 1")
      .first<{ payload: string }>();
    expect(row!.payload).not.toContain(b2.applicationKey);
    expect(row!.payload).not.toContain(r2.secretAccessKey);
    const settings = await app.request("/private/api/settings", { headers: { Cookie: cookie } });
    expect(settings.status).toBe(200);
    const text = await settings.text();
    expect(text).toContain("b2-secondary");
    expect(text).toContain("r2-secondary");
    expect(text).not.toContain(b2.applicationKey);
    expect(text).not.toContain(r2.secretAccessKey);
    expect(text).not.toContain("strong-admin-password");
  });

  test("allows credential rotation, blocks in-use deletion and location changes", async () => {
    const app = fixture();
    const cookie = await app.login();
    expect((await app.post("/settings/storages", b2, cookie)).status).toBe(201);
    const rotated = await app.post("/settings/storages/b2-primary",
      { applicationKey: "new-rotated-key" }, cookie, "PATCH");
    expect(rotated.status).toBe(200);
    expect((await readAppSettings(app.env))?.storages[0]).toMatchObject({
      id: "b2-primary", applicationKey: "new-rotated-key",
    });
    const upload = await app.post("/uploads", {
      filename: "test.txt", size: 4, mode: "public",
      shareExpiresIn: 3600, storageId: "b2-primary",
    }, cookie);
    expect(upload.status).toBe(200);
    const changeBucket = await app.post("/settings/storages/b2-primary",
      { bucket: "different-bucket" }, cookie, "PATCH");
    expect(changeBucket.status).toBe(409);
    const deleted = await app.request("/private/api/settings/storages/b2-primary", {
      method: "DELETE", headers: { Origin: origin, Cookie: cookie },
    });
    expect(deleted.status).toBe(409);
    const changeId = await app.post("/settings/storages/b2-primary",
      { id: "other-id" }, cookie, "PATCH");
    expect(changeId.status).toBe(400);
    expect((await app.post("/uploads", {
      filename: "test.txt", size: 4, mode: "public",
      shareExpiresIn: 3600, storageId: "unknown-id",
    }, cookie)).status).toBe(503);
  });

  test("removes unused IDs and checks permissions on every mutation", async () => {
    const app = fixture();
    const cookie = await app.login();
    expect((await app.post("/settings/storages", r2, cookie)).status).toBe(201);
    const unauthorized = await app.request("/private/api/settings/storages/r2-primary", {
      method: "DELETE", headers: { Origin: origin },
    });
    expect(unauthorized.status).toBe(401);
    const removed = await app.request("/private/api/settings/storages/r2-primary", {
      method: "DELETE", headers: { Origin: origin, Cookie: cookie },
    });
    expect(removed.status).toBe(200);
    expect((await readAppSettings(app.env))?.storages).toEqual([]);
    expect((await app.post("/settings", { virusTotalApiKey: "new-key" }, cookie, "PATCH")).status)
      .toBe(200);
    const current = await app.request("/private/api/settings", { headers: { Cookie: cookie } });
    expect(await current.json()).toEqual({ storages: [], storageUsage: [], virusTotalEnabled: true });
  });
});
