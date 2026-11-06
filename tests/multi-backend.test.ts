import { describe, expect, test } from "bun:test";
import { b64, signToken } from "../worker/crypto";
import { bindTestSettings } from "../worker/app-config";
import { bindObjectStore, getObjectStore, r2ObjectUrl } from "../worker/object-store";
import { cleanupExpired, getRecord, saveRecord } from "../worker/storage";
import { createTestDatabase } from "./d1-helper";
import { dataKey, type Bindings, type FileRecord, type StorageBackend } from "../worker/model";
import handler from "../worker/index";

const origin = "https://storage.example.test";
const adminPath = "private";
const adminCookie = async () => {
  const token = await signToken("s".repeat(48), {
    scope: "admin", entry: adminPath, exp: Date.now() + 60000,
  });
  return "r2_share_admin=" + token;
};

function fixture({ b2 = true, r2 = true }: { b2?: boolean; r2?: boolean } = {}) {
  const maps = { b2: new Map<string, string>(), r2: new Map<string, string>() };
  const store = (backend: StorageBackend) => {
    const objects = maps[backend];
    return {
      async get(key: string) {
        const value = objects.get(key);
        return value === undefined ? null : {
          body: new Response(value).body!,
          size: new TextEncoder().encode(value).length,
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
          objects: [...objects.keys()].filter(x => x.startsWith(prefix)).slice(0, limit)
            .map(key => ({ key, uploaded: new Date() })),
          truncated: false,
        };
      },
    };
  };
  const env = {
    DB: createTestDatabase(),
    ADMIN_PATH: adminPath, ADMIN_PASSWORD: "test-admin-password",
    APP_MASTER_KEY: b64(new Uint8Array(32)),
    SESSION_SECRET: "s".repeat(48),
    CODE_ENCRYPTION_KEY: b64(new Uint8Array(32)),
    ...(b2 ? { B2_REGION: "us-west-004", B2_BUCKET: "b2-bucket", B2_KEY_ID: "b2-key", B2_APPLICATION_KEY: "b2-secret" } : {}),
    ...(r2 ? { R2_ACCOUNT_ID: "a".repeat(32), R2_BUCKET: "r2-bucket", R2_ACCESS_KEY_ID: "r2-key", R2_SECRET_ACCESS_KEY: "r2-secret" } : {}),
    LOGIN_LIMITER: { limit: async () => ({ success: true }) },
    CODE_LIMITER: { limit: async () => ({ success: true }) },
    ASSETS: { fetch: async () => new Response("<!doctype html>") },
  } as unknown as Bindings;
  bindTestSettings(env);
  bindObjectStore(env, store("b2"), "b2");
  bindObjectStore(env, store("r2"), "r2");
  async function request(path: string, options: RequestInit = {}) {
    return handler.fetch(new Request(origin + path, options), env, {} as ExecutionContext);
  }
  async function upload(backend: StorageBackend, text: string) {
    const cookie = await adminCookie();
    const init = await request("/" + adminPath + "/api/uploads", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        filename: "example.txt", size: new TextEncoder().encode(text).length,
        mode: "public", shareExpiresIn: 3600, backend,
      }),
    });
    expect(init.status).toBe(200);
    const created = await init.json() as { id: string; token: string };
    const sent = await request("/" + adminPath + "/api/uploads/" + created.id, {
      method: "PUT",
      headers: { Origin: origin, Cookie: cookie, "X-Upload-Token": created.token },
      body: text,
    });
    expect(sent.status).toBe(200);
    return created.id;
  }
  return { env, maps, store, request, upload };
}

describe("multi-backend object storage", () => {
  test("builds only the expected Cloudflare R2 S3 endpoint", () => {
    const accountId = "a".repeat(32);
    expect(r2ObjectUrl(accountId, "my-private-r2", "files/Example_12345678"))
      .toBe("https://" + accountId + ".r2.cloudflarestorage.com/my-private-r2/files/Example_12345678");
    expect(() => r2ObjectUrl("https://attacker.example", "my-private-r2")).toThrow();
    expect(() => r2ObjectUrl(accountId, "evil/path")).toThrow();
    expect(() => r2ObjectUrl(accountId, "my-private-r2", "untrusted/route")).toThrow();
  });

  test("persists the selected backend and routes downloads, edits and deletes correctly", async () => {
    const app = fixture();
    const b2Id = await app.upload("b2", "stored in B2");
    const r2Id = await app.upload("r2", "stored in R2");
    expect(app.maps.b2.get(dataKey(b2Id))).toBe("stored in B2");
    expect(app.maps.r2.has(dataKey(b2Id))).toBe(false);
    expect(app.maps.r2.get(dataKey(r2Id))).toBe("stored in R2");
    expect(app.maps.b2.has(dataKey(r2Id))).toBe(false);
    expect((await getRecord(app.env, b2Id))?.backend).toBe("b2");
    expect((await getRecord(app.env, r2Id))?.backend).toBe("r2");

    const publicB2 = await app.request("/api/files/" + b2Id + "/download");
    const publicR2 = await app.request("/api/files/" + r2Id + "/download");
    expect(await publicB2.text()).toBe("stored in B2");
    expect(await publicR2.text()).toBe("stored in R2");

    const cookie = await adminCookie();
    const list = await app.request("/" + adminPath + "/api/files", { headers: { Cookie: cookie } });
    const json = await list.json() as { files: { id: string; backend: string }[] };
    expect(json.files.find(file => file.id === b2Id)?.backend).toBe("b2");
    expect(json.files.find(file => file.id === r2Id)?.backend).toBe("r2");

    const patch = await app.request("/" + adminPath + "/api/files/" + r2Id, {
      method: "PATCH", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ mode: "protected", shareExpiresIn: 3600 }),
    });
    expect(patch.status).toBe(200);
    expect((await getRecord(app.env, r2Id))?.backend).toBe("r2");

    const deleted = await app.request("/" + adminPath + "/api/files/" + r2Id, {
      method: "DELETE", headers: { Origin: origin, Cookie: cookie },
    });
    expect(deleted.status).toBe(200);
    expect(app.maps.r2.has(dataKey(r2Id))).toBe(false);
    expect(app.maps.b2.get(dataKey(b2Id))).toBe("stored in B2");
  });

  test("rejects files without an explicitly selected storage backend", async () => {
    const app = fixture();
    const cookie = await adminCookie();
    const init = await app.request("/" + adminPath + "/api/uploads", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ filename: "test.txt", size: 4, mode: "public", shareExpiresIn: 0 }),
    });
    expect(init.status).toBe(400);

    const badRecord = {
      id: "MissingBackend12", filename: "bad.txt", mime: "text/plain", size: 6,
      mode: "public", revision: "revision", createdAt: new Date().toISOString(),
      expiresAt: null, shareExpiresAt: null,
    } as FileRecord;
    await expect(saveRecord(app.env, badRecord)).rejects.toThrow("Invalid file record");
  });

  test("cleans expired files and abandoned uploads from the correct stores", async () => {
    const app = fixture();
    const r2Id = await app.upload("r2", "old r2 object");
    const record = (await getRecord(app.env, r2Id))!;
    record.expiresAt = new Date(Date.now() - 1000).toISOString();
    await saveRecord(app.env, record);
    expect(await cleanupExpired(app.env)).toBe(1);
    expect(app.maps.r2.has(dataKey(r2Id))).toBe(false);

    const abandoned = "AbandonedUpload1";
    app.maps.b2.set(dataKey(abandoned), "keep");
    app.maps.r2.set(dataKey(abandoned), "orphan");
    await app.env.DB.prepare(
      "INSERT INTO upload_sessions (id, backend, created_at, status) VALUES (?, ?, ?, 'pending')"
    ).bind(abandoned, "r2", Date.now() - 90000000).run();
    await cleanupExpired(app.env);
    expect(app.maps.b2.get(dataKey(abandoned))).toBe("keep");
    expect(app.maps.r2.has(dataKey(abandoned))).toBe(false);
  });

  test("rejects uploads to an unconfigured backend while allowing the other", async () => {
    const app = fixture({ b2: false, r2: true });
    const cookie = await adminCookie();
    const invalid = await app.request("/" + adminPath + "/api/uploads", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ filename: "test", size: 4, mode: "public", shareExpiresIn: 0, backend: "gcs" }),
    });
    expect(invalid.status).toBe(400);
    const b2 = await app.request("/" + adminPath + "/api/uploads", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ filename: "test", size: 4, mode: "public", shareExpiresIn: 0, backend: "b2" }),
    });
    expect(b2.status).toBe(503);
    const r2Id = await app.upload("r2", "only R2 available");
    expect(app.maps.r2.has(dataKey(r2Id))).toBe(true);
  });

  test("binds mocks per backend without falling back to B2", async () => {
    const app = fixture();
    const b2 = getObjectStore(app.env, "b2");
    const r2 = getObjectStore(app.env, "r2");
    expect(b2).not.toBe(r2);
  });
});
