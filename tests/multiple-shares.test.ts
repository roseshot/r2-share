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
const primaryId = "ABCdef123";
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
    await createShare(env, initialShare(record, primaryId));
    objects.set(dataKey(fileId), "sample");
    return record;
  }
  return { env, objects, request, admin, createFile };
}

describe("independent multiple share links", () => {
  test("returns stable, normal-looking metadata for missing IDs without granting file access", async () => {
    const app = fixture();
    const realRecord = await app.createFile();
    await saveRecord(app.env, {
      ...realRecord,
      checksums: { sha256: "a".repeat(64) },
      originalModifiedAt: "2026-06-03T12:00:00.000Z",
    });
    const real = await (await app.request("/api/files/" + primaryId)).json() as Record<string, unknown>;
    expect((await app.request("/api/files/" + fileId)).status).toBe(404);
    expect((await getRecord(app.env, fileId))?.id).toBe(fileId);
    const unknown = "Fq8mH2_nP4";
    const first = await app.request("/api/files/" + unknown);
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    const decoy = await first.json() as Record<string, unknown>;
    expect(Object.keys(decoy).sort()).toEqual(Object.keys(real).sort());
    expect(decoy).toMatchObject({ id: unknown, mode: "public" });
    expect(decoy.filename).toMatch(/\.(pdf|jpg|zip|txt|mp4|xlsx)$/);
    expect(decoy.size).toBeGreaterThan(0);
    expect(decoy.size).toBeLessThan(1024 ** 4);
    expect(decoy.checksums).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await (await app.request("/api/files/" + unknown)).json()).toEqual(decoy);
    expect((await app.request("/api/files/" + unknown + "/download")).status).toBe(404);
    expect((await app.request("/api/files/" + unknown + "/preview")).status).toBe(404);
    expect((await app.request("/api/files/" + unknown + "/unlock", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "wrong" }),
    })).status).toBe(404);
    for (const length of [8, 9, 10, 11, 12]) {
      const missingId = "A".repeat(length);
      const response = await app.request("/api/files/" + missingId);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: missingId, mode: "public" });
    }
    for (const length of [1, 7, 13, 16, 21, 513]) {
      const missingId = "A".repeat(length);
      const response = await app.request("/api/files/" + missingId);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "File not found" });
    }
    expect((await app.request("/api/files/bad!")).status).toBe(404);
    expect(await (await app.request("/api/files/" + primaryId)).json()).toEqual(real);
  });


  test("keeps the initial short share separate from the file ID and adds protected links", async () => {
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
    expect(await (await app.request("/api/files/" + primaryId)).json())
      .toMatchObject({ id: primaryId, filename: "sample.txt", mode: "public" });
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
    expect((await app.request("/api/files/" + primaryId + "/download")).status).toBe(200);
  });

  test("archive files remain downloadable but cannot be previewed", async () => {
    const app = fixture();
    const file = await app.createFile();
    file.filename = "backup.tar.gz";
    file.mime = "application/gzip";
    await saveRecord(app.env, file);

    const preview = await app.request("/api/files/" + primaryId + "/preview");
    expect(preview.status).toBe(400);
    expect(await preview.json()).toMatchObject({
      error: "Preview not supported for this file type",
    });

    const download = await app.request("/api/files/" + primaryId + "/download");
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("sample");
  });

  test("supports admin-only share names without invalidating access cookies", async () => {
    const app = fixture();
    await app.createFile("protected");
    const created = await app.admin("/files/" + fileId + "/shares", "POST", {
      mode: "protected", code: "label-code", shareExpiresIn: 0, label: "Client review",
    });
    expect(created.status).toBe(201);
    const { share } = await created.json() as { share: { id: string; label: string } };
    expect(share.label).toBe("Client review");
    const before = await getShare(app.env, share.id);
    const updated = await app.admin("/files/" + fileId + "/shares/" + share.id, "PATCH", {
      label: "Updated recipient",
    });
    expect(updated.status).toBe(200);
    expect((await getShare(app.env, share.id))?.label).toBe("Updated recipient");
    expect((await getShare(app.env, share.id))?.revision).toBe(before?.revision);
    expect((await app.admin("/files/" + fileId + "/shares/" + share.id, "PATCH", {
      label: "x".repeat(65),
    })).status).toBe(400);
  });

  test("searches and paginates files on the server", async () => {
    const app = fixture();
    const base = await app.createFile();
    for (let n = 0; n < 26; n++) {
      await saveRecord(app.env, {
        ...base, id: String(n).padStart(16, "0"),
        filename: "needle-" + n + ".txt",
        createdAt: new Date(Date.now() - n * 1000).toISOString(),
      });
    }
    const first = await app.admin("/files?q=needle&storageId=primary-b2&page=1&sort=newest");
    expect(first.status).toBe(200);
    const result = await first.json() as { files: FileRecord[]; total: number; hasMore: boolean };
    expect(result.total).toBe(26);
    expect(result.files).toHaveLength(25);
    expect(result.hasMore).toBe(true);
    const second = await app.admin("/files?q=needle&page=2");
    expect((await second.json() as { files: FileRecord[] }).files).toHaveLength(1);
    expect((await app.admin("/files?page=0")).status).toBe(400);
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
    expect((await app.request("/api/files/" + primaryId + "/download", {
      headers: { Cookie: secondCookie },
    })).status).toBe(403);
    const updated = await app.admin("/files/" + fileId + "/shares/" + secondId, "PATCH", {
      code: "new-second-code", shareExpiresIn: 3600,
    });
    expect(updated.status).toBe(200);
    expect((await app.request("/api/files/" + secondId + "/download", {
      headers: { Cookie: secondCookie },
    })).status).toBe(403);
    expect((await app.request("/api/files/" + primaryId + "/download", {
      headers: { Cookie: firstCookie },
    })).status).toBe(200);
    expect((await getShare(app.env, secondId))?.expiresAt).not.toBeNull();
  });

  test("renames files and sets relative deletion periods without changing share link expiry", async () => {
    const app = fixture();
    await app.createFile();
    const created = await app.admin("/files/" + fileId + "/shares", "POST", {
      mode: "public", shareExpiresIn: 3600,
    });
    const { share: { id: secondId } } = await created.json() as { share: { id: string } };
    const before = (await getShare(app.env, secondId))!;
    const beforeSave = Date.now();
    const response = await app.admin("/files/" + fileId, "PATCH", {
      filename: "Renamed notes.txt", fileExpiresIn: 259200,
    });
    expect(response.status).toBe(200);
    const updated = (await getRecord(app.env, fileId))!;
    expect(updated.filename).toBe("Renamed notes.txt");
    const remaining = Date.parse(updated.expiresAt!) - beforeSave;
    expect(remaining).toBeGreaterThanOrEqual(259200000);
    expect(remaining).toBeLessThan(259205000);
    expect((await getShare(app.env, secondId))!.expiresAt).toBe(before.expiresAt);
    expect((await getShare(app.env, secondId))!.revision).toBe(before.revision);
    expect(app.objects.get(dataKey(fileId))).toBe("sample");
    const shareDetails = await app.request("/api/files/" + secondId);
    expect(await shareDetails.json()).toMatchObject({ filename: "Renamed notes.txt" });
    const download = await app.request("/api/files/" + primaryId + "/download");
    expect(download.headers.get("Content-Disposition")).toContain("Renamed%20notes.txt");
    expect((await app.admin("/files/" + fileId, "PATCH", { fileExpiresIn: 0 })).status).toBe(200);
    expect((await getRecord(app.env, fileId))?.expiresAt).toBeNull();
    expect((await getShare(app.env, secondId))?.expiresAt).toBe(before.expiresAt);
  });

  test("rejects invalid rename and file deletion periods without changing metadata", async () => {
    const app = fixture();
    await app.createFile();
    const invalid = [
      { filename: "" }, { filename: "x".repeat(241) }, { filename: "bad\nname" },
      { fileExpiresIn: -1 }, { fileExpiresIn: 1800 },
      { fileExpiresIn: "3600" }, { fileExpiresIn: null },
      { fileExpiresAt: new Date(Date.now() + 86400000).toISOString() },
    ];
    for (const body of invalid) {
      expect((await app.admin("/files/" + fileId, "PATCH", body)).status).toBe(400);
      expect((await getRecord(app.env, fileId))?.filename).toBe("sample.txt");
      expect((await getRecord(app.env, fileId))?.expiresAt).toBeNull();
    }
  });

  test("revoking one link keeps the file and other links; deleting file removes all links", async () => {
    const app = fixture();
    await app.createFile();
    const created = await app.admin("/files/" + fileId + "/shares", "POST", {
      mode: "public", shareExpiresIn: 0,
    });
    const { share: { id: secondId } } = await created.json() as { share: { id: string } };
    expect((await app.admin("/files/" + fileId + "/shares/" + secondId, "DELETE")).status).toBe(200);
    const revoked = await app.request("/api/files/" + secondId);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ id: secondId, mode: "public" });
    expect((await app.request("/api/files/" + secondId + "/download")).status).toBe(404);
    expect((await app.request("/api/files/" + primaryId)).status).toBe(200);
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
    const expired = await app.request("/api/files/" + secondId);
    expect(expired.status).toBe(200);
    expect(await expired.json()).toMatchObject({ id: secondId, mode: "public" });
    expect((await app.request("/api/files/" + secondId + "/download")).status).toBe(404);
    expect((await app.request("/api/files/" + primaryId)).status).toBe(200);
    expect(app.objects.get(dataKey(fileId))).toBe("sample");
  });
});
