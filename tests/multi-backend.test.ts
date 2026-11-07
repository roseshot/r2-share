import { describe, expect, test } from "bun:test";
import { b64, signToken } from "../worker/crypto";
import { bindTestSettings, saveAppSettings } from "../worker/app-config";
import { bindObjectStore, getObjectStore, r2ObjectUrl } from "../worker/object-store";
import { cleanupExpired, getRecord, getStorageUsage, saveRecord } from "../worker/storage";
import { createTestDatabase } from "./d1-helper";
import { dataKey, type Bindings, type FileRecord, type StorageConfig } from "../worker/model";
import handler from "../worker/index";

const origin = "https://storage.example.test";
const storages: StorageConfig[] = [
  { id: "b2-alpha", backend: "b2", bucket: "first-b2-bucket",
    region: "us-west-004", keyId: "b2-key", applicationKey: "b2-secret" },
  { id: "b2-beta", backend: "b2", bucket: "second-b2-bucket",
    region: "us-west-004", keyId: "b2-key", applicationKey: "b2-secret" },
  { id: "r2-alpha", backend: "r2", bucket: "first-r2-bucket",
    accountId: "a".repeat(32), accessKeyId: "r2-key", secretAccessKey: "r2-secret" },
  { id: "r2-beta", backend: "r2", bucket: "second-r2-bucket",
    accountId: "a".repeat(32), accessKeyId: "r2-key", secretAccessKey: "r2-secret" },
];

function fixture(ids: string[] = storages.map(s => s.id)) {
  const maps = Object.fromEntries(storages.map(s => [s.id, new Map<string, string>()])) as Record<string, Map<string, string>>;
  const env = {
    DB: createTestDatabase(),
    ADMIN_PATH: "private", ADMIN_PASSWORD: "password123",
    APP_MASTER_KEY: b64(new Uint8Array(32)),
    SESSION_SECRET: "s".repeat(48),
    CODE_ENCRYPTION_KEY: b64(new Uint8Array(32)),
    STORAGES: storages.filter(s => ids.includes(s.id)),
    LOGIN_LIMITER: { limit: async () => ({ success: true }) },
    CODE_LIMITER: { limit: async () => ({ success: true }) },
    ASSETS: { fetch: async () => new Response("<!doctype html>") },
  } as unknown as Bindings;
  bindTestSettings(env);

  for (const storage of storages) {
    const objects = maps[storage.id];
    bindObjectStore(env, {
      async get(key: string) {
        const value = objects.get(key);
        return value === undefined ? null : {
          body: new Response(value).body!, size: new TextEncoder().encode(value).length,
          uploaded: new Date(),
        };
      },
      async head(key: string) {
        const value = objects.get(key);
        return value === undefined ? null : {
          size: new TextEncoder().encode(value).length, uploaded: new Date(),
        };
      },
      async put(key: string, body: string | ReadableStream<Uint8Array>) {
        const value = typeof body === "string" ? body : await new Response(body).text();
        objects.set(key, value);
        return { size: new TextEncoder().encode(value).length, uploaded: new Date() };
      },
      async delete(keys: string | string[]) {
        for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
      },
      async list({ prefix, limit }: { prefix: string; limit: number }) {
        return {
          objects: [...objects.keys()].filter(key => key.startsWith(prefix)).slice(0, limit)
            .map(key => ({ key, uploaded: new Date() })),
          truncated: false,
        };
      },
    }, storage.id);
  }

  async function request(path: string, init: RequestInit = {}) {
    return handler.fetch(new Request(origin + path, init), env, {} as ExecutionContext);
  }
  async function cookie() {
    const token = await signToken(env.SESSION_SECRET, {
      scope: "admin", entry: "private", exp: Date.now() + 60000,
    });
    return "r2_share_admin=" + token;
  }
  async function init(storageId: string | undefined, text: string) {
    return request("/private/api/uploads", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", Cookie: await cookie() },
      body: JSON.stringify({ filename: "example.txt", size: new TextEncoder().encode(text).length,
        mode: "public", shareExpiresIn: 3600, ...(storageId ? { storageId } : {}) }),
    });
  }
  async function upload(storageId: string, text: string) {
    const response = await init(storageId, text);
    expect(response.status).toBe(200);
    const { id, token } = await response.json() as { id: string; token: string };
    const sent = await request("/private/api/uploads/" + id, {
      method: "PUT", headers: { Origin: origin, Cookie: await cookie(), "X-Upload-Token": token },
      body: text,
    });
    expect(sent.status).toBe(200);
    return id;
  }
  return { env, maps, request, cookie, init, upload };
}

describe("multiple object storage IDs", () => {
  test("validates R2's account-bound signed endpoint", () => {
    const account = "a".repeat(32);
    expect(r2ObjectUrl(account, "first-r2-bucket", "files/1234567890ABCDEF"))
      .toBe("https://" + account + ".r2.cloudflarestorage.com/first-r2-bucket/files/1234567890ABCDEF");
    expect(() => r2ObjectUrl("https://attacker.example", "first-r2-bucket")).toThrow();
    expect(() => r2ObjectUrl(account, "evil/path")).toThrow();
  });

  test("routes four distinct IDs including two B2 and two R2 instances", async () => {
    const app = fixture();
    for (const storage of storages) {
      const text = "file for " + storage.id;
      const id = await app.upload(storage.id, text);
      expect(app.maps[storage.id].get(dataKey(id))).toBe(text);
      expect((await getRecord(app.env, id))?.storageId).toBe(storage.id);
      for (const other of storages.filter(s => s.id !== storage.id)) {
        expect(app.maps[other.id].has(dataKey(id))).toBe(false);
      }
      expect(await (await app.request("/api/files/" + id + "/download")).text()).toBe(text);
      const deleted = await app.request("/private/api/files/" + id, {
        method: "DELETE", headers: { Origin: origin, Cookie: await app.cookie() },
      });
      expect(deleted.status).toBe(200);
      expect(app.maps[storage.id].has(dataKey(id))).toBe(false);
    }
  });

  test("persists separate storage usage snapshots after cleanup, independent of pagination", async () => {
    const app = fixture();
    await saveAppSettings(app.env, { storages });
    const first = await app.upload("b2-alpha", "hello");
    const second = await app.upload("b2-alpha", "world!");
    const third = await app.upload("r2-beta", "four");

    type Usage = { storageId: string; usedBytes: number | null;
      fileCount: number | null; calculatedAt: string | null };
    async function settingsUsage(): Promise<Usage[]> {
      const response = await app.request("/private/api/settings", {
        headers: { Origin: origin, Cookie: await app.cookie() },
      });
      expect(response.status).toBe(200);
      return (await response.json() as { storageUsage: Usage[] }).storageUsage;
    }
    const before = await settingsUsage();
    expect(before.map(row => row.storageId)).toEqual(storages.map(storage => storage.id));
    expect(before.every(row => row.usedBytes === null && row.calculatedAt === null)).toBe(true);

    expect(await cleanupExpired(app.env)).toBe(0);
    const rows = await settingsUsage();
    const byId = new Map(rows.map(row => [row.storageId, row]));
    expect(byId.get("b2-alpha")).toMatchObject({ usedBytes: 11, fileCount: 2 });
    expect(byId.get("r2-beta")).toMatchObject({ usedBytes: 4, fileCount: 1 });
    expect(byId.get("b2-beta")).toMatchObject({ usedBytes: 0, fileCount: 0 });
    expect(byId.get("r2-alpha")).toMatchObject({ usedBytes: 0, fileCount: 0 });
    expect(Date.parse(byId.get("b2-alpha")!.calculatedAt!)).toBeGreaterThan(0);
    expect(await app.env.DB.prepare("SELECT COUNT(*) AS count FROM storage_usage")
      .first<{ count: number }>()).toEqual({ count: 4 });

    await app.upload("b2-beta", "new");
    expect((await settingsUsage()).find(row => row.storageId === "b2-beta")?.usedBytes).toBe(0);

    const expired = (await getRecord(app.env, second))!;
    expired.expiresAt = new Date(Date.now() - 1000).toISOString();
    await saveRecord(app.env, expired);
    expect(await cleanupExpired(app.env)).toBe(1);
    const after = new Map((await settingsUsage()).map(row => [row.storageId, row]));
    expect(after.get("b2-alpha")).toMatchObject({ usedBytes: 5, fileCount: 1 });
    expect(after.get("b2-beta")).toMatchObject({ usedBytes: 3, fileCount: 1 });
    expect(after.get("r2-beta")).toMatchObject({ usedBytes: 4, fileCount: 1 });
    expect((await getStorageUsage(app.env, ["b2-alpha"])).map(row => row.usedBytes)).toEqual([5]);
    expect(app.maps["b2-alpha"].has(dataKey(second))).toBe(false);
    expect(app.maps["b2-alpha"].has(dataKey(first))).toBe(true);
    expect(app.maps["r2-beta"].has(dataKey(third))).toBe(true);
  });

  test("tracks only successfully deleted files when cleanup has a backlog", async () => {
    const app = fixture(["b2-alpha"]);
    const original = await app.upload("b2-alpha", "keep");
    const expiredIds = [];
    for (let n = 0; n < 11; n++) {
      const id = await app.upload("b2-alpha", "x");
      const record = (await getRecord(app.env, id))!;
      record.expiresAt = new Date(Date.now() - 1000).toISOString();
      await saveRecord(app.env, record);
      expiredIds.push(id);
    }
    expect(await cleanupExpired(app.env)).toBe(10);
    expect((await getStorageUsage(app.env, ["b2-alpha"]))[0])
      .toMatchObject({ usedBytes: 5, fileCount: 2 });
    expect(await cleanupExpired(app.env)).toBe(1);
    expect((await getStorageUsage(app.env, ["b2-alpha"]))[0])
      .toMatchObject({ usedBytes: 4, fileCount: 1 });
    expect(app.maps["b2-alpha"].has(dataKey(original))).toBe(true);
    expect(expiredIds.every(id => !app.maps["b2-alpha"].has(dataKey(id)))).toBe(true);
  });

  test("rejects missing, unknown, or provider names instead of IDs", async () => {
    const app = fixture();
    expect((await app.init(undefined, "abcd")).status).toBe(400);
    expect((await app.init("b2", "abcd")).status).toBe(503);
    expect((await app.init("r2", "abcd")).status).toBe(503);
    expect((await app.init("unknown", "abcd")).status).toBe(503);
    const other = fixture(["r2-beta"]);
    expect((await other.init("b2-alpha", "abcd")).status).toBe(503);
    const id = await other.upload("r2-beta", "test r2");
    expect(other.maps["r2-beta"].has(dataKey(id))).toBe(true);
  });

  test("cleans expired files and abandoned uploads only from their own storage", async () => {
    const app = fixture();
    const id = await app.upload("r2-alpha", "old r2 object");
    const record = (await getRecord(app.env, id))!;
    record.expiresAt = new Date(Date.now() - 1000).toISOString();
    await saveRecord(app.env, record);
    expect(await cleanupExpired(app.env)).toBe(1);
    expect(app.maps["r2-alpha"].has(dataKey(id))).toBe(false);

    const orphan = "Abandoned";
    app.maps["b2-alpha"].set(dataKey(orphan), "keep b2");
    app.maps["b2-beta"].set(dataKey(orphan), "keep other b2");
    app.maps["r2-beta"].set(dataKey(orphan), "orphan r2");
    await app.env.DB.prepare(
      "INSERT INTO upload_sessions (id, storage_id, created_at, status) VALUES (?, ?, ?, 'pending')"
    ).bind(orphan, "r2-beta", Date.now() - 90000000).run();
    await cleanupExpired(app.env);
    expect(app.maps["r2-beta"].has(dataKey(orphan))).toBe(false);
    expect(app.maps["b2-alpha"].get(dataKey(orphan))).toBe("keep b2");
    expect(app.maps["b2-beta"].get(dataKey(orphan))).toBe("keep other b2");
  });

  test("rejects records without a valid storage ID", async () => {
    const app = fixture();
    const record: FileRecord = {
      id: "BadRecord1", storageId: "bad id", filename: "bad.txt",
      mime: "text/plain", size: 6, mode: "public", revision: "revision",
      createdAt: new Date().toISOString(), expiresAt: null, shareExpiresAt: null,
    };
    await expect(saveRecord(app.env, record)).rejects.toThrow("Invalid file record");
  });

  test("keeps mock stores isolated by storage ID", () => {
    const app = fixture();
    expect(getObjectStore(app.env, "b2-alpha")).not.toBe(getObjectStore(app.env, "b2-beta"));
    expect(getObjectStore(app.env, "r2-alpha")).not.toBe(getObjectStore(app.env, "r2-beta"));
    expect(() => getObjectStore(app.env, "nonexistent")).toThrow();
  });
});
