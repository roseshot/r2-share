import { describe, expect, test } from "bun:test";
import { b64, signToken } from "../worker/crypto";
import { bindObjectStore } from "../worker/object-store";
import { bindTestSettings, saveAppSettings } from "../worker/app-config";
import { createTestDatabase } from "./d1-helper";
import { dataKey, type Bindings, type StorageConfig } from "../worker/model";
import { deleteRecord, getRecord } from "../worker/storage";
import { getCachedVirusTotalReport, processVirusTotalQueue } from "../worker/virustotal";
import handler from "../worker/index";

const origin = "https://share.example.test";
const storage: StorageConfig = {
  id: "b2-primary", backend: "b2", bucket: "private-backups",
  region: "us-west-004", keyId: "b2-test-key", applicationKey: "b2-test-secret",
};
function setup() {
  const objects = new Map<string, string>();
  const env = {
    DB: createTestDatabase(), STORAGES: [storage],
    APP_MASTER_KEY: b64(crypto.getRandomValues(new Uint8Array(32))),
    ADMIN_PATH: "secret-admin", ADMIN_PASSWORD: "test-password",
    SESSION_SECRET: "s".repeat(48), CODE_ENCRYPTION_KEY: b64(new Uint8Array(32)),
    VIRUSTOTAL_API_KEY: "vt-private-test-key",
    LOGIN_LIMITER: { limit: async () => ({ success: true }) },
    CODE_LIMITER: { limit: async () => ({ success: true }) },
    ASSETS: { fetch: async () => new Response("<!doctype html>") },
  } as unknown as Bindings;
  bindTestSettings(env);
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
      return value === undefined ? null :
        { size: new TextEncoder().encode(value).length, uploaded: new Date() };
    },
    async put(key: string, body: string | ReadableStream<Uint8Array>) {
      const text = typeof body === "string" ? body : await new Response(body).text();
      objects.set(key, text);
      return { size: new TextEncoder().encode(text).length, uploaded: new Date() };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list() { return { objects: [], truncated: false }; },
  }, storage.id);
  const request = (path: string, init: RequestInit = {}) =>
    handler.fetch(new Request(origin + path, init), env, {} as ExecutionContext);
  const cookie = async () => "r2_share_admin=" + await signToken(env.SESSION_SECRET, {
    scope: "admin", entry: "secret-admin", exp: Date.now() + 60000,
  });
  async function upload(content: string) {
    const begin = await request("/secret-admin/api/uploads", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: await cookie() },
      body: JSON.stringify({ filename: "test.txt", size: content.length, mode: "public",
        storageId: storage.id, shareExpiresIn: 3600 }),
    });
    expect(begin.status).toBe(200);
    const { id, shareId, token } = await begin.json() as { id: string; shareId: string; token: string };
    const done = await request("/secret-admin/api/uploads/" + id, {
      method: "PUT", headers: { Origin: origin, Cookie: await cookie(), "X-Upload-Token": token },
      body: content,
    });
    expect(done.status).toBe(200);
    expect(objects.get(dataKey(id))).toBe(content);
    const record = await getRecord(env, id);
    expect(record?.checksums?.sha256).toMatch(/^[0-9a-f]{64}$/);
    return { id, shareId, sha256: record!.checksums!.sha256 };
  }
  const rows = async (sql: string) => (await env.DB.prepare(sql).all()).results;
  return { env, request, cookie, upload, rows, objects };
}

const resultJson = () => Response.json({
  data: { attributes: { last_analysis_stats: {
    malicious: 0, suspicious: 1, harmless: 54, undetected: 11,
  }, last_analysis_date: 1750000000 } },
});

describe("VirusTotal six-hour D1 queue and share cache", () => {
  test("queues uploads by SHA-256 and never queries VirusTotal on public or admin reads", async () => {
    const app = setup();
    const first = await app.upload("same-content");
    const second = await app.upload("same-content");
    expect(first.sha256).toBe(second.sha256);
    expect(await app.rows("SELECT * FROM virustotal_queue")).toHaveLength(1);
    const publicView = await app.request("/api/files/" + first.shareId);
    expect(publicView.status).toBe(200);
    expect(await publicView.json()).toMatchObject({
      id: first.shareId, virusTotal: { status: "pending" },
    });
    const admin = await app.request("/secret-admin/api/files/" + first.id + "/virustotal", {
      headers: { Cookie: await app.cookie() },
    });
    expect(await admin.json()).toEqual({ status: "pending" });
    const placeholder = await app.request("/api/files/abcdefghijk");
    expect((await placeholder.json() as { virusTotal: { status: string } }).virusTotal)
      .toEqual({ status: "pending" });
    expect(await app.rows("SELECT * FROM virustotal_reports")).toHaveLength(0);
  });

  test("stores one successful reputation report permanently and never queries the hash again", async () => {
    const app = setup();
    const first = await app.upload("persistent-report");
    let calls = 0;
    const fetchReport: typeof fetch = async (input, init) => {
      calls++;
      expect(String(input)).toContain(first.sha256);
      expect(new Headers(init?.headers).get("x-apikey")).toBe(app.env.VIRUSTOTAL_API_KEY);
      expect(init?.body).toBeUndefined();
      return resultJson();
    };
    expect(await processVirusTotalQueue(app.env, undefined, fetchReport)).toBe(1);
    expect(calls).toBe(1);
    expect(await app.rows("SELECT * FROM virustotal_queue")).toHaveLength(0);
    expect(await app.rows("SELECT * FROM virustotal_reports")).toHaveLength(1);
    expect(await getCachedVirusTotalReport(app.env, first.sha256)).toMatchObject({
      status: "found", malicious: 0, suspicious: 1, harmless: 54, undetected: 11,
    });
    const response = await app.request("/api/files/" + first.shareId);
    expect(await response.json()).toMatchObject({
      virusTotal: { status: "found", malicious: 0, suspicious: 1 },
    });
    await app.upload("persistent-report");
    expect(await app.rows("SELECT * FROM virustotal_queue")).toHaveLength(0);
    expect(await processVirusTotalQueue(app.env, undefined, fetchReport, Date.now() + 86400000)).toBe(0);
    expect(calls).toBe(1);
    await deleteRecord(app.env, first.id);
    expect(await app.rows("SELECT * FROM virustotal_reports")).toHaveLength(1);
  });

  test("keeps 404 and 429 results queued for another six-hour run", async () => {
    const app = setup();
    const uploaded = await app.upload("retry-me");
    const now = Date.now();
    let calls = 0;
    const missing: typeof fetch = async () => { calls++; return new Response(null, { status: 404 }); };
    expect(await processVirusTotalQueue(app.env, undefined, missing, now)).toBe(0);
    expect(calls).toBe(1);
    expect(await processVirusTotalQueue(app.env, undefined, missing, now + 1)).toBe(0);
    expect(calls).toBe(1);
    const throttled: typeof fetch = async () => { calls++; return new Response(null, { status: 429 }); };
    expect(await processVirusTotalQueue(app.env, undefined, throttled, now + 6 * 3600000)).toBe(0);
    expect(calls).toBe(2);
    expect(await app.rows("SELECT * FROM virustotal_queue")).toHaveLength(1);
    expect(await processVirusTotalQueue(app.env, undefined, async () => {
      calls++;
      return resultJson();
    }, now + 12 * 3600000)).toBe(1);
    expect(calls).toBe(3);
    expect((await getCachedVirusTotalReport(app.env, uploaded.sha256)).status).toBe("found");
  });

  test("does not call VirusTotal without an API key and removes queues for deleted files", async () => {
    const app = setup();
    const uploaded = await app.upload("remove-from-queue");
    let calls = 0;
    const mock: typeof fetch = async () => { calls++; return resultJson(); };
    expect(await processVirusTotalQueue(app.env, "", mock)).toBe(0);
    expect(calls).toBe(0);
    await deleteRecord(app.env, uploaded.id);
    expect(await app.rows("SELECT * FROM virustotal_queue")).toHaveLength(0);
    expect(await processVirusTotalQueue(app.env, undefined, mock)).toBe(0);
    expect(calls).toBe(0);
  });

  test("the scheduled handler runs queue processing on the existing six-hour cron", async () => {
    const app = setup();
    await saveAppSettings(app.env, { storages: [storage], virusTotalApiKey: "vt-private-test-key" });
    // No network calls when there are no queued hashes.
    await handler.scheduled({ cron: "0 */6 * * *" } as ScheduledController, app.env);
    expect(await app.rows("SELECT * FROM virustotal_queue")).toHaveLength(0);
  });
});
