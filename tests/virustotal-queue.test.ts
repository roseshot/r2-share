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
    const initialPublic = await publicView.json() as Record<string, unknown>;
    expect(initialPublic.id).toBe(first.shareId);
    expect(initialPublic).not.toHaveProperty("virusTotal");
    const enable = await app.request("/secret-admin/api/files/" + first.id +
      "/shares/" + first.shareId, {
      method: "PATCH", headers: {
        Origin: origin, Cookie: await app.cookie(), "Content-Type": "application/json",
      },
      body: JSON.stringify({ showVirusTotal: true }),
    });
    expect(enable.status).toBe(200);
    expect(await (await app.request("/api/files/" + first.shareId)).json()).toMatchObject({
      virusTotal: { status: "pending" },
    });
    const admin = await app.request("/secret-admin/api/files/" + first.id + "/virustotal", {
      headers: { Cookie: await app.cookie() },
    });
    expect(await admin.json()).toEqual({ status: "pending" });
    const placeholder = await app.request("/api/files/abcdefghijk");
    expect(await placeholder.json()).not.toHaveProperty("virusTotal");
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
    expect(await response.json()).not.toHaveProperty("virusTotal");
    const enabled = await app.request("/secret-admin/api/files/" + first.id +
      "/shares/" + first.shareId, {
      method: "PATCH", headers: {
        Origin: origin, Cookie: await app.cookie(), "Content-Type": "application/json",
      },
      body: JSON.stringify({ showVirusTotal: true }),
    });
    expect(enabled.status).toBe(200);
    expect(await (await app.request("/api/files/" + first.shareId)).json()).toMatchObject({
      virusTotal: { status: "found", malicious: 0, suspicious: 1 },
    });
    const duplicate = await app.upload("persistent-report");
    expect(await app.rows("SELECT * FROM virustotal_queue")).toHaveLength(0);
    expect(await processVirusTotalQueue(app.env, undefined, fetchReport, Date.now() + 86400000)).toBe(0);
    expect(calls).toBe(1);
    await deleteRecord(app.env, first.id);
    expect(await app.rows("SELECT * FROM virustotal_reports")).toHaveLength(1);
    expect((await getCachedVirusTotalReport(app.env, duplicate.sha256)).status).toBe("found");

    // Once the last copy disappears, both cached data and queue are erased.
    await deleteRecord(app.env, duplicate.id);
    expect(await app.rows("SELECT * FROM virustotal_reports")).toHaveLength(0);
    expect(await app.rows("SELECT * FROM virustotal_queue")).toHaveLength(0);
    const reuploaded = await app.upload("persistent-report");
    expect((await getCachedVirusTotalReport(app.env, reuploaded.sha256)).status).toBe("pending");
    expect(await app.rows("SELECT * FROM virustotal_queue")).toHaveLength(1);
    expect(await processVirusTotalQueue(app.env, undefined, fetchReport, Date.now() + 86400000)).toBe(1);
    expect(calls).toBe(2);
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

  test("preserves queued hashes for duplicate files until the last copy is removed", async () => {
    const app = setup();
    const first = await app.upload("same-pending-content");
    const second = await app.upload("same-pending-content");
    expect(await app.rows("SELECT * FROM virustotal_queue")).toHaveLength(1);
    await deleteRecord(app.env, first.id);
    expect(await app.rows("SELECT * FROM virustotal_queue")).toHaveLength(1);
    await deleteRecord(app.env, second.id);
    expect(await app.rows("SELECT * FROM virustotal_queue")).toHaveLength(0);
  });

  test("admin file deletion erases file, shares and VirusTotal associations", async () => {
    const app = setup();
    const file = await app.upload("delete-associated-data");
    expect(await app.rows("SELECT * FROM shares")).toHaveLength(1);
    const response = await app.request("/secret-admin/api/files/" + file.id, {
      method: "DELETE", headers: { Cookie: await app.cookie(), Origin: origin },
    });
    expect(response.status).toBe(200);
    expect(await getRecord(app.env, file.id)).toBeNull();
    expect(await app.rows("SELECT * FROM shares")).toHaveLength(0);
    expect(await app.rows("SELECT * FROM upload_sessions")).toHaveLength(0);
    expect(await app.rows("SELECT * FROM virustotal_queue")).toHaveLength(0);
    expect(await app.rows("SELECT * FROM virustotal_reports")).toHaveLength(0);
    expect(app.objects.has(dataKey(file.id))).toBe(false);
    const deletedShare = await app.request("/api/files/" + file.shareId);
    expect(await deletedShare.json()).toMatchObject({ id: file.shareId, mode: "public" });
  });

  test("does not save a VirusTotal response after the final file is deleted mid-lookup", async () => {
    const app = setup();
    const file = await app.upload("deleted-in-flight");
    let calls = 0;
    const fetchReport: typeof fetch = async () => {
      calls++;
      await deleteRecord(app.env, file.id);
      return resultJson();
    };
    expect(await processVirusTotalQueue(app.env, undefined, fetchReport)).toBe(0);
    expect(calls).toBe(1);
    expect(await app.rows("SELECT * FROM files")).toHaveLength(0);
    expect(await app.rows("SELECT * FROM virustotal_queue")).toHaveLength(0);
    expect(await app.rows("SELECT * FROM virustotal_reports")).toHaveLength(0);
  });

  test("scheduled expiry cleanup erases VirusTotal cache when removing the last file", async () => {
    const app = setup();
    const file = await app.upload("expiring");
    expect(await processVirusTotalQueue(app.env, undefined, async () => resultJson())).toBe(1);
    expect(await app.rows("SELECT * FROM virustotal_reports")).toHaveLength(1);
    const expiredAt = new Date(Date.now() - 60000).toISOString();
    await app.env.DB.prepare(
      "UPDATE files SET expires_at = ?, record_json = json_set(record_json, '$.expiresAt', ?) WHERE id = ?"
    ).bind(expiredAt, expiredAt, file.id).run();
    const { cleanupExpired } = await import("../worker/storage");
    expect(await cleanupExpired(app.env)).toBe(1);
    expect(await app.rows("SELECT * FROM files")).toHaveLength(0);
    expect(await app.rows("SELECT * FROM shares")).toHaveLength(0);
    expect(await app.rows("SELECT * FROM virustotal_queue")).toHaveLength(0);
    expect(await app.rows("SELECT * FROM virustotal_reports")).toHaveLength(0);
  });

  test("admin file list persists VirusTotal button eligibility across authorization and deletion", async () => {
    const app = setup();
    const first = await app.upload("identical-content-to-authorize");
    const second = await app.upload("identical-content-to-authorize");
    const unrelated = await app.upload("unrelated-hash-to-authorize");
    const list = async () => {
      const response = await app.request("/secret-admin/api/files", {
        headers: { Cookie: await app.cookie() },
      });
      expect(response.status).toBe(200);
      const json = await response.json() as {
        files: { id: string; canSubmitToVirusTotal: boolean }[];
      };
      return new Map(json.files.map(file => [file.id, file.canSubmitToVirusTotal]));
    };
    const initial = await list();
    expect(initial.get(first.id)).toBe(true);
    expect(initial.get(second.id)).toBe(true);
    expect(initial.get(unrelated.id)).toBe(true);

    // Giving consent for one file must hide the button for that SHA-256 on
    // every copy, since a second consent would otherwise return HTTP 409.
    const submit = await app.request(
      "/secret-admin/api/files/" + first.id + "/virustotal/upload", {
        method: "POST", headers: { Cookie: await app.cookie(), Origin: origin },
      });
    expect(submit.status).toBe(200);
    expect(await submit.json()).toEqual({ status: "authorized" });
    const authorized = await list();
    expect(authorized.get(first.id)).toBe(false);
    expect(authorized.get(second.id)).toBe(false);
    expect(authorized.get(unrelated.id)).toBe(true);

    // Removing the approved file revokes its file-specific authorization.
    await deleteRecord(app.env, first.id);
    const revoked = await list();
    expect(revoked.has(first.id)).toBe(false);
    expect(revoked.get(second.id)).toBe(true);
    expect(revoked.get(unrelated.id)).toBe(true);

    const reauthorized = await app.request(
      "/secret-admin/api/files/" + second.id + "/virustotal/upload", {
        method: "POST", headers: { Cookie: await app.cookie(), Origin: origin },
      });
    expect(reauthorized.status).toBe(200);
    expect((await list()).get(second.id)).toBe(false);

    // Submitting the approved file and later caching the analysis should
    // never restore the Submit button, even after the queue row disappears.
    await app.env.DB.prepare(
      "UPDATE virustotal_queue SET upload_submitted_at = ? WHERE sha256 = ?"
    ).bind(Date.now(), second.sha256).run();
    expect((await list()).get(second.id)).toBe(false);
    // Leave the unrelated digest queued for a later cron so this assertion
    // specifically verifies the authorized file's transition to cached.
    await app.env.DB.prepare(
      "UPDATE virustotal_queue SET next_attempt_at = ? WHERE sha256 = ?"
    ).bind(Date.now() + 12 * 3600000, unrelated.sha256).run();
    expect(await processVirusTotalQueue(app.env, undefined,
      async () => resultJson(), Date.now() + 6 * 3600000)).toBe(1);
    expect((await list()).get(second.id)).toBe(false);
    expect((await list()).get(unrelated.id)).toBe(true);
  });

  test("only an authenticated administrator can authorize one file for submission", async () => {
    const app = setup();
    const file = await app.upload("authorized-sample");
    const endpoint = "/secret-admin/api/files/" + file.id + "/virustotal/upload";
    const noAuth = await app.request(endpoint, { method: "POST", headers: { Origin: origin } });
    expect(noAuth.status).toBe(401);
    const crossOrigin = await app.request(endpoint, {
      method: "POST", headers: { Cookie: await app.cookie(), Origin: "https://evil.example.com" },
    });
    expect(crossOrigin.status).toBe(403);
    let requests = 0;
    const lookup: typeof fetch = async () => {
      requests++;
      return new Response(null, { status: 404 });
    };
    const started = Date.now();
    expect(await processVirusTotalQueue(app.env, undefined, lookup, started)).toBe(0);
    expect(requests).toBe(1); // Hash-only until an administrator consents.
    const authorized = await app.request(endpoint, {
      method: "POST", headers: { Cookie: await app.cookie(), Origin: origin },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ status: "authorized" });
    const second = await app.request(endpoint, {
      method: "POST", headers: { Cookie: await app.cookie(), Origin: origin },
    });
    expect(await second.json()).toEqual({ status: "authorized" });
    expect(await app.rows("SELECT upload_file_id FROM virustotal_queue"))
      .toEqual([{ upload_file_id: file.id }]);
    let submits = 0;
    const submit: typeof fetch = async (input, init) => {
      if (init?.method === "GET") return new Response(null, { status: 404 });
      submits++;
      expect(String(input)).toBe("https://www.virustotal.com/api/v3/files");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-apikey")).toBe(app.env.VIRUSTOTAL_API_KEY);
      expect(new Headers(init?.headers).get("Content-Type")).toMatch(/^multipart\/form-data; boundary=/);
      const content = await new Response(init?.body).text();
      expect(content).toContain('name="file"');
      expect(content).toContain("authorized-sample");
      return Response.json({ data: { type: "analysis", id: "analysis-123" } });
    };
    expect(await processVirusTotalQueue(app.env, undefined, submit, started + 6 * 3600000)).toBe(0);
    expect(submits).toBe(1);
    const state = await app.rows("SELECT upload_file_id, upload_submitted_at FROM virustotal_queue");
    expect(state).toHaveLength(1);
    expect(state[0].upload_file_id).toBe(file.id);
    expect(typeof state[0].upload_submitted_at).toBe("number");
    expect(await processVirusTotalQueue(app.env, undefined, submit, started + 12 * 3600000)).toBe(0);
    expect(submits).toBe(1); // Never submit bytes twice.
    expect(await processVirusTotalQueue(app.env, undefined,
      async () => resultJson(), started + 18 * 3600000)).toBe(1);
    expect((await getCachedVirusTotalReport(app.env, file.sha256)).status).toBe("found");
    const cached = await app.request(endpoint, {
      method: "POST", headers: { Cookie: await app.cookie(), Origin: origin },
    });
    expect(await cached.json()).toEqual({ status: "cached" });
  });

  test("deleting the authorized file revokes upload consent for identical content", async () => {
    const app = setup();
    const first = await app.upload("identical-but-separate");
    await app.upload("identical-but-separate");
    expect((await app.request("/secret-admin/api/files/" + first.id + "/virustotal/upload", {
      method: "POST", headers: { Origin: origin, Cookie: await app.cookie() },
    })).status).toBe(200);
    await deleteRecord(app.env, first.id);
    expect(await app.rows("SELECT upload_file_id FROM virustotal_queue"))
      .toEqual([{ upload_file_id: null }]);
    let postCalls = 0;
    await processVirusTotalQueue(app.env, undefined, async (_input, init) => {
      if (init?.method === "POST") postCalls++;
      return new Response(null, { status: 404 });
    });
    expect(postCalls).toBe(0);
  });

  test("the scheduled handler runs queue processing on the existing six-hour cron", async () => {
    const app = setup();
    await saveAppSettings(app.env, { storages: [storage], virusTotalApiKey: "vt-private-test-key" });
    // No network calls when there are no queued hashes.
    await handler.scheduled({ cron: "0 */6 * * *" } as ScheduledController, app.env);
    expect(await app.rows("SELECT * FROM virustotal_queue")).toHaveLength(0);
  });
});
