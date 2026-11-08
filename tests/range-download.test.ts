import { createTestDatabase } from "./d1-helper";
import { describe, expect, test } from "bun:test";
import handler from "../worker/index";
import { parseByteRange } from "../worker/ranges";
import { b64, encryptCode, readToken } from "../worker/crypto";
import { bindTestSettings } from "../worker/app-config";
import { bindObjectStore } from "../worker/object-store";
import { saveRecord } from "../worker/storage";
import { createShare, initialShare } from "../worker/shares";
import { dataKey, type Bindings, type FileRecord } from "../worker/model";

const origin = "https://share.example.test";
const fileId = "ABCDEF0123456789";
const primaryId = "ABCdef1234";

function fixture(protectedLink = false, offload = false) {
  const env = {
    DB: createTestDatabase(), ADMIN_PATH: "secret-admin", ADMIN_PASSWORD: "password123",
    SESSION_SECRET: "s".repeat(48), CODE_ENCRYPTION_KEY: b64(new Uint8Array(32)),
    STORAGES: [{ id: "primary-b2", backend: "b2", bucket: "private-files",
      region: "us-west-004", keyId: "b2-key", applicationKey: "b2-secret" }],
    ...(offload ? {
      DOWNLOAD_NODES: "https://dl-a.example.com,https://dl-b.example.com",
      DOWNLOAD_NODE_SECRET: "download-test-key-with-at-least-32-characters",
    } : {}),
    CODE_LIMITER: { limit: async () => ({ success: true }) },
    LOGIN_LIMITER: { limit: async () => ({ success: true }) },
    ASSETS: { fetch: async () => new Response("<!doctype html>") },
  } as unknown as Bindings;
  bindTestSettings(env);
  bindObjectStore(env, {
    async get(key, range) {
      if (key !== dataKey(fileId)) return null;
      const data = "sample";
      if (!range) return { body: new Response(data).body!, size: data.length, uploaded: new Date(), status: 200 };
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) throw new Error("Invalid storage range");
      const start = Number(match[1]), end = Number(match[2]);
      const text = data.slice(start, end + 1);
      return { body: new Response(text).body!, size: text.length, uploaded: new Date(),
        status: 206, contentRange: "bytes " + start + "-" + end + "/" + data.length };
    },
    async head(key) { return key === dataKey(fileId) ? { size: 6, uploaded: new Date() } : null; },
    async put() { return { size: 6, uploaded: new Date() }; },
    async delete() {},
    async list() { return { objects: [], truncated: false }; },
  }, "primary-b2");

  async function request(path: string, init: RequestInit = {}) {
    return handler.fetch(new Request(origin + path, init), env, {} as ExecutionContext);
  }
  async function createFile() {
    const record: FileRecord = {
      id: fileId, storageId: "primary-b2", filename: "sample.txt", mime: "text/plain",
      size: 6, mode: protectedLink ? "protected" : "public",
      revision: "initial-revision", createdAt: new Date().toISOString(),
      expiresAt: null, shareExpiresAt: null,
      ...(protectedLink ? { encryptedCode: await encryptCode("test-code", primaryId, "initial-revision", env.CODE_ENCRYPTION_KEY) } : {}),
    };
    await saveRecord(env, record);
    await createShare(env, initialShare(record, primaryId));
  }
  return { request, createFile };
}

describe("byte range parsing", () => {
  test("supports bounded, open-ended, and suffix byte ranges", () => {
    expect(parseByteRange("bytes=1-3", 6)).toEqual({ start: 1, end: 3 });
    expect(parseByteRange("bytes=4-", 6)).toEqual({ start: 4, end: 5 });
    expect(parseByteRange("bytes=-2", 6)).toEqual({ start: 4, end: 5 });
    expect(parseByteRange("bytes=-50", 6)).toEqual({ start: 0, end: 5 });
    expect(parseByteRange("bytes=0-500", 6)).toEqual({ start: 0, end: 5 });
  });
  test("rejects malformed, unsatisfiable, and multipart ranges", () => {
    for (const range of ["bytes=6-7", "bytes=2-1", "bytes=-0",
      "bytes=0-1,4-5", "units=0-1", "bytes=foo-bar", "bytes=-", "bytes=0-99999999999999999999"]) {
      expect(parseByteRange(range, 6), range).toBeNull();
    }
  });
});

describe("download range and availability checks", () => {
  test("supports HEAD preflight without returning the file body", async () => {
    const app = fixture();
    await app.createFile();
    const head = await app.request("/api/files/" + primaryId + "/download", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("6");
    expect(head.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await head.text()).toBe("");
  });
  test("streams single ranges for downloads and previews", async () => {
    const app = fixture();
    await app.createFile();
    const partial = await app.request("/api/files/" + primaryId + "/download", {
      headers: { Range: "bytes=1-3" },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Content-Range")).toBe("bytes 1-3/6");
    expect(partial.headers.get("Content-Length")).toBe("3");
    expect(await partial.text()).toBe("amp");
    const suffix = await app.request("/api/files/" + primaryId + "/preview", {
      headers: { Range: "bytes=-2" },
    });
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe("le");
    const full = await app.request("/api/files/" + primaryId + "/download");
    expect(full.status).toBe(200);
    expect(await full.text()).toBe("sample");
  });
  test("redirects authenticated GET downloads to one stable node with signed short-lived grants", async () => {
    const app = fixture(false, true);
    await app.createFile();
    const first = await app.request("/api/files/" + primaryId + "/download");
    expect(first.status).toBe(307);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    expect(first.headers.get("Referrer-Policy")).toBe("no-referrer");
    const location = new URL(first.headers.get("Location")!);
    expect(["dl-a.example.com", "dl-b.example.com"]).toContain(location.host);
    expect(location.pathname).toBe("/v1/download");
    const claims = await readToken(
      "download-test-key-with-at-least-32-characters", location.searchParams.get("token") ?? "",
    );
    expect(claims).toMatchObject({
      scope: "tuckbox-download/v1", key: dataKey(fileId), storageId: "primary-b2",
      filename: "sample.txt", mime: "text/plain", size: 6, aud: location.host,
    });
    expect(claims?.exp as number).toBeLessThanOrEqual(Date.now() + 90_000);
    const resumed = await app.request("/api/files/" + primaryId + "/download", {
      headers: { Range: "bytes=1-3" },
    });
    expect(resumed.status).toBe(307);
    expect(new URL(resumed.headers.get("Location")!).host).toBe(location.host);
    // Preserve the existing same-origin HEAD preflight and preview path.
    const head = await app.request("/api/files/" + primaryId + "/download", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("6");
    const preview = await app.request("/api/files/" + primaryId + "/preview");
    expect(preview.status).toBe(200);
    expect(await preview.text()).toBe("sample");
  });

  test("never redirects locked or expired links and enforces protection before minting grants", async () => {
    const app = fixture(true, true);
    await app.createFile();
    const denied = await app.request("/api/files/" + primaryId + "/download");
    expect(denied.status).toBe(403);
    expect(denied.headers.get("Location")).toBeNull();
    const unlocked = await app.request("/api/files/" + primaryId + "/unlock", {
      method: "POST", headers: {
        Origin: origin, "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: "test-code" }),
    });
    expect(unlocked.status).toBe(200);
    const cookie = unlocked.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    const accepted = await app.request("/api/files/" + primaryId + "/download", {
      headers: { Cookie: cookie! },
    });
    expect(accepted.status).toBe(307);
  });

  test("returns 416 for invalid byte ranges and protects HEAD", async () => {
    const publicApp = fixture();
    await publicApp.createFile();
    const invalid = await publicApp.request("/api/files/" + primaryId + "/download", {
      headers: { Range: "bytes=99-100" },
    });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("Content-Range")).toBe("bytes */6");
    const locked = fixture(true);
    await locked.createFile();
    expect((await locked.request("/api/files/" + primaryId + "/download", {
      method: "HEAD",
    })).status).toBe(403);
  });
});
