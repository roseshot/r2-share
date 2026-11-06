import { describe, expect, test } from "bun:test";
import handler from "../worker/index";
import { b64, encryptCode, signToken } from "../worker/crypto";
import { bindTestSettings } from "../worker/app-config";
import { bindObjectStore } from "../worker/object-store";
import { getRecord, saveRecord } from "../worker/storage";
import { createShare, getShare, initialShare, listShares } from "../worker/shares";
import { dataKey, type Bindings, type FileRecord } from "../worker/model";
import { createTestDatabase } from "./d1-helper";

const origin = "https://share.example.test";
const fileId = "ABCDEF0123456789";
const accessKey = b64(new Uint8Array(32));

function fixture() {
  const objects = new Map<string, string>();
  const env = {
    DB: createTestDatabase(),
    ADMIN_PATH: "secret-admin", ADMIN_PASSWORD: "password123",
    SESSION_SECRET: "s".repeat(48), CODE_ENCRYPTION_KEY: accessKey,
    STORAGES: [{ id: "primary-b2", backend: "b2", bucket: "private-files",
      region: "us-west-004", keyId: "b2-key", applicationKey: "b2-secret" }],
    CODE_LIMITER: { limit: async () => ({ success: true }) },
    LOGIN_LIMITER: { limit: async () => ({ success: true }) },
    ASSETS: { fetch: async () => new Response("<!doctype html>") },
  } as unknown as Bindings;
  bindTestSettings(env);
  bindObjectStore(env, {
    get: async key => objects.has(key) ? {
      body: new Response(objects.get(key)).body!,
      size: new TextEncoder().encode(objects.get(key)!).length,
      uploaded: new Date(),
    } : null,
    head: async key => objects.has(key) ? { size: objects.get(key)!.length, uploaded: new Date() } : null,
    put: async () => ({ size: 4, uploaded: new Date() }),
    delete: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
    list: async () => ({ objects: [], truncated: false }),
  }, "primary-b2");
  async function request(path: string, init: RequestInit = {}) {
    return handler.fetch(new Request(origin + path, init), env, {} as ExecutionContext);
  }
  async function adminCookie() {
    return "r2_share_admin=" + await signToken(env.SESSION_SECRET, {
      scope: "admin", entry: env.ADMIN_PATH, exp: Date.now() + 60000,
    });
  }
  async function admin(path: string, method = "GET", data?: object) {
    return request("/secret-admin/api" + path, {
      method,
      headers: { Origin: origin, Cookie: await adminCookie(), ...(data ? { "Content-Type": "application/json" } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  }
  async function createFile(mode: "public" | "protected" = "public") {
    const record: FileRecord = {
      id: fileId, storageId: "primary-b2", filename: "sample.txt", mime: "text/plain",
      size: 6, mode, revision: "first-revision", createdAt: new Date().toISOString(),
      expiresAt: null, shareExpiresAt: null,
      ...(mode === "protected" ? {
        encryptedCode: await encryptCode("first-code", fileId, "first-revision", accessKey),
      } : {}),
    };
    await saveRecord(env, record);
    await createShare(env, initialShare(record));
    objects.set(dataKey(fileId), "sample");
    return record;
  }
  return { env, objects, request, admin, createFile };
}

describe("independent multiple share links", () => {
  test("keeps existing file-ID links and adds independent protected links", async () => {
    const app = fixture();
    await app.createFile();
    const created = await app.admin("/files/" + fileId + "/shares", "POST", {
      mode: "protected", code: "second-code", shareExpiresIn: 3600,
    });
    expect(created.status).toBe(201);
    const data = await created.json() as { share: { id: string; mode: string }; code: string };
    expect(data.code).toBe("second-code");
    expect(data.share.id).not.toBe(fileId);
    const shareId = data.share.id;
    expect((await listShares(app.env, fileId))).toHaveLength(2);
    expect((await app.request("/api/files/" + shareId)).status).toBe(200);
    expect(await (await app.request("/api/files/" + shareId)).json())
      .toEqual({ id: shareId, mode: "protected" });
    expect(await (await app.request("/api/files/" + fileId)).json())
      .toMatchObject({ id: fileId, filename: "sample.txt", mode: "public" });
    expect((await app.request("/api/files/" + shareId + "/download")).status).toBe(403);
    const unlock = await app.request("/api/files/" + shareId + "/unlock", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "second-code" }),
    });
    expect(unlock.status).toBe(200);
    const cookie = unlock.headers.get("Set-Cookie")!.split(";")[0];
    expect(await (await app.request("/api/files/" + shareId + "/download", {
      headers: { Cookie: cookie },
    })).text()).toBe("sample");
    expect((await app.request("/api/files/" + fileId + "/download")).status).toBe(200);
  });

  test("invalidates only the edited share authorization, not sibling links", async () => {
    const app = fixture();
    await app.createFile("protected");
    const created = await app.admin("/files/" + fileId + "/shares", "POST", {
      mode: "protected", code: "second-code", shareExpiresIn: 0,
    });
    const { share: { id: secondId } } = await created.json() as { share: { id: string } };
    async function unlock(id: string, code: string) {
      const result = await app.request("/api/files/" + id + "/unlock", {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      expect(result.status).toBe(200);
      return result.headers.get("Set-Cookie")!.split(";")[0];
    }
    const firstCookie = await unlock(fileId, "first-code");
    const secondCookie = await unlock(secondId, "second-code");
    expect((await app.request("/api/files/" + secondId + "/download", {
      headers: { Cookie: firstCookie },
    })).status).toBe(403);
    expect((await app.request("/api/files/" + fileId + "/download", {
      headers: { Cookie: secondCookie },
    })).status).toBe(403);
    const updated = await app.admin("/files/" + fileId + "/shares/" + secondId, "PATCH", {
      code: "new-second-code", shareExpiresIn: 3600,
    });
    expect(updated.status).toBe(200);
    expect((await app.request("/api/files/" + secondId + "/download", {
      headers: { Cookie: secondCookie },
    })).status).toBe(403);
    expect((await app.request("/api/files/" + fileId + "/download", {
      headers: { Cookie: firstCookie },
    })).status).toBe(200);
    expect((await getShare(app.env, secondId))?.expiresAt).not.toBeNull();
  });

  test("revoking one link keeps the file and other links; deleting file removes all links", async () => {
    const app = fixture();
    await app.createFile();
    const created = await app.admin("/files/" + fileId + "/shares", "POST", {
      mode: "public", shareExpiresIn: 0,
    });
    const { share: { id: secondId } } = await created.json() as { share: { id: string } };
    expect((await app.admin("/files/" + fileId + "/shares/" + secondId, "DELETE")).status).toBe(200);
    expect((await app.request("/api/files/" + secondId)).status).toBe(404);
    expect((await app.request("/api/files/" + fileId)).status).toBe(200);
    expect(await getRecord(app.env, fileId)).not.toBeNull();
    expect(app.objects.get(dataKey(fileId))).toBe("sample");
    expect((await app.admin("/files/" + fileId, "DELETE")).status).toBe(200);
    expect(await getRecord(app.env, fileId)).toBeNull();
    expect((await listShares(app.env, fileId))).toEqual([]);
  });

  test("expired links do not expire the file or sibling links", async () => {
    const app = fixture();
    await app.createFile();
    const result = await app.admin("/files/" + fileId + "/shares", "POST", {
      mode: "public", shareExpiresIn: 3600,
    });
    const { share: { id: secondId } } = await result.json() as { share: { id: string } };
    const share = (await getShare(app.env, secondId))!;
    await app.admin("/files/" + fileId + "/shares/" + secondId, "PATCH", {
      mode: "public", shareExpiresIn: 3600,
    });
    await app.env.DB.prepare("UPDATE shares SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), share.id).run();
    expect((await app.request("/api/files/" + secondId)).status).toBe(404);
    expect((await app.request("/api/files/" + fileId)).status).toBe(200);
    expect(app.objects.get(dataKey(fileId))).toBe("sample");
  });
});
