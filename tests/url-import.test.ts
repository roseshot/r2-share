import { describe, expect, test } from "bun:test";
import handler from "../worker/index";
import { b64, signToken } from "../worker/crypto";
import { bindTestSettings } from "../worker/app-config";
import { bindObjectStore } from "../worker/object-store";
import { dataKey, type Bindings, type StorageConfig } from "../worker/model";
import { getRecord } from "../worker/storage";
import { getShare } from "../worker/shares";
import { createTestDatabase } from "./d1-helper";
import { importRemoteFile, remoteFilename, validateRemoteUrl, type RemoteImportOptions } from "../worker/url-import";
import { readFileSync } from "node:fs";

const origin = "https://share.example.test";
const storage: StorageConfig = {
  id: "b2-primary", backend: "b2", bucket: "private-backups",
  region: "us-west-004", keyId: "b2-key", applicationKey: "b2-secret",
};
const options: RemoteImportOptions = {
  url: "https://download.example.com/start", storageId: storage.id,
  mode: "public", shareExpiresIn: 86400,
};

function setup() {
  const objects = new Map<string, string>();
  let failPut = false;
  const env = {
    DB: createTestDatabase(), STORAGES: [storage],
    ADMIN_PATH: "secret-admin", ADMIN_PASSWORD: "password123",
    APP_MASTER_KEY: b64(crypto.getRandomValues(new Uint8Array(32))),
    SESSION_SECRET: "s".repeat(48), CODE_ENCRYPTION_KEY: b64(new Uint8Array(32)),
    ASSETS: { fetch: async () => new Response("<!doctype html>") },
    LOGIN_LIMITER: { limit: async () => ({ success: true }) },
    CODE_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as Bindings;
  bindTestSettings(env);
  bindObjectStore(env, {
    async put(key, body) {
      const contents = typeof body === "string" ? body : await new Response(body).text();
      objects.set(key, contents);
      if (failPut) throw new Error("Simulated bucket failure after write");
      return { size: new TextEncoder().encode(contents).length, uploaded: new Date() };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async get(key) {
      const text = objects.get(key);
      return text === undefined ? null : {
        size: text.length, body: new Response(text).body!, uploaded: new Date(),
      };
    },
    async head(key) {
      const text = objects.get(key);
      return text === undefined ? null : { size: text.length, uploaded: new Date() };
    },
    async list() { return { objects: [], truncated: false }; },
  }, storage.id);
  const request = (path: string, init: RequestInit = {}) =>
    handler.fetch(new Request(origin + path, init), env, {} as ExecutionContext);
  const cookie = async () => "r2_share_admin=" + await signToken(env.SESSION_SECRET, {
    scope: "admin", entry: "secret-admin", exp: Date.now() + 60000,
  });
  const dbRows = async (query: string) => (await env.DB.prepare(query).all()).results;
  return { env, objects, request, cookie, dbRows, setFailPut: (v: boolean) => { failPut = v; } };
}

const fileResponse = (content: string, extra: Record<string, string> = {}) =>
  new Response(content, { headers: {
    "Content-Length": String(new TextEncoder().encode(content).length),
    "Content-Type": "text/plain; charset=utf-8", ...extra,
  } });

describe("administrator remote URL import", () => {
  test("rejects SSRF hosts, unsafe ports, credentials and invalid schemes", () => {
    for (const candidate of [
      "file:///etc/passwd", "https://localhost/secret", "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data/", "http://[::1]/",
      "http://2130706433/", "https://metadata.google.internal/",
      "http://intranet.local/file", "https://a.internal/test",
      "https://user:password@example.com/", "https://example.com:8080/file",
      "https://example.com/#fragment", "https://singlelabel/",
    ]) expect(() => validateRemoteUrl(candidate)).toThrow();
    expect(validateRemoteUrl("https://files.example.com/test?download=1").hostname)
      .toBe("files.example.com");
    expect(validateRemoteUrl("http://files.example.com/file").protocol).toBe("http:");
  });

  test("uses the last URL's path for the filename, or the administrator's override", () => {
    const final = new URL("https://cdn.example.com/download/My%20File.zip?token=hidden");
    expect(remoteFilename(final)).toBe("My File.zip");
    expect(remoteFilename(final, "preferred-name.pdf")).toBe("preferred-name.pdf");
    expect(() => remoteFilename(new URL("https://cdn.example.com/download/"))).toThrow();
    expect(() => remoteFilename(final, "../unsafe/name.txt")).toThrow();
    expect(() => remoteFilename(final, "\u0000file")).toThrow();
  });

  test("follows redirects, stores exact file bytes under tuckbox UUID, and records D1 shares and SHA-256", async () => {
    const app = setup();
    const visited: string[] = [];
    const request: typeof fetch = async (input, init) => {
      visited.push(String(input));
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      if (visited.length === 1) return new Response(null, {
        status: 302, headers: { Location: "../edge" },
      });
      if (visited.length === 2) return new Response(null, {
        status: 307, headers: { Location: "https://cdn.example.com/files/archive%20final.zip?token=123" },
      });
      return fileResponse("remote-data");
    };
    const result = await importRemoteFile(app.env, {
      ...options, url: "https://download.example.com/links/source",
      mode: "protected", code: "my-password",
    }, request);
    expect(visited).toEqual([
      "https://download.example.com/links/source",
      "https://download.example.com/edge",
      "https://cdn.example.com/files/archive%20final.zip?token=123",
    ]);
    expect(result.filename).toBe("archive final.zip");
    expect(result.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(result.shareId).toMatch(/^[A-Za-z0-9_-]{8,10}$/);
    expect(result.id).not.toBe(result.shareId);
    expect(result.code).toBe("my-password");
    expect(app.objects.get(dataKey(result.id))).toBe("remote-data");
    expect(dataKey(result.id)).toBe("tuckbox/" + result.id);
    const record = await getRecord(app.env, result.id);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("remote-data"));
    expect(record?.checksums?.sha256)
      .toBe(Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join(""));
    expect(record?.size).toBe(11);
    expect(record?.mime).toBe("text/plain");
    expect((await getShare(app.env, result.shareId))?.showVirusTotal).toBe(false);
    expect((await getShare(app.env, result.shareId))?.mode).toBe("protected");
    expect(await app.dbRows("SELECT * FROM virustotal_queue")).toHaveLength(1);
    expect(await app.dbRows("SELECT * FROM upload_sessions")).toHaveLength(0);
  });

  test("accepts administrator-supplied filenames and fallback HEAD length", async () => {
    const app = setup();
    const methods: string[] = [];
    const request: typeof fetch = async (_, init) => {
      methods.push(init!.method!);
      if (init?.method === "HEAD") return new Response(null, {
        headers: { "Content-Length": "6" },
      });
      return new Response("abcdef", { headers: { "Content-Type": "text/plain" } });
    };
    const result = await importRemoteFile(app.env, {
      ...options, filename: "renamed.txt",
    }, request);
    expect(result.filename).toBe("renamed.txt");
    expect(result.mode).toBe("public");
    expect(methods).toEqual(["GET", "HEAD"]);
    expect(app.objects.get(dataKey(result.id))).toBe("abcdef");
  });

  test("rejects unsafe redirect destinations before sending another request", async () => {
    const app = setup();
    let calls = 0;
    const request: typeof fetch = async () => {
      calls++;
      return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/admin" } });
    };
    await expect(importRemoteFile(app.env, options, request)).rejects.toThrow("public hostname");
    expect(calls).toBe(1);
    expect(await app.dbRows("SELECT * FROM upload_sessions")).toHaveLength(0);
    expect(app.objects.size).toBe(0);
  });

  test("rejects redirect loops, missing lengths and oversized responses", async () => {
    const app = setup();
    let calls = 0;
    const loop: typeof fetch = async () => {
      calls++;
      return new Response(null, { status: 302, headers: { Location: "/again" } });
    };
    await expect(importRemoteFile(app.env, options, loop)).rejects.toThrow("Too many URL redirects");
    expect(calls).toBe(6);
    const noSize: typeof fetch = async () => new Response("abc");
    await expect(importRemoteFile(app.env, options, noSize)).rejects.toThrow("Content-Length");
    const oversized: typeof fetch = async () =>
      fileResponse("abc", { "Content-Length": String(90 * 1024 * 1024 + 1) });
    await expect(importRemoteFile(app.env, options, oversized)).rejects.toThrow("90 MiB");
    expect(await app.dbRows("SELECT * FROM files")).toHaveLength(0);
  });

  test("rolls back a short response and a bucket write failure", async () => {
    const app = setup();
    const short: typeof fetch = async () => fileResponse("abc", { "Content-Length": "5" });
    await expect(importRemoteFile(app.env, options, short)).rejects.toThrow("save remote");
    expect(app.objects.size).toBe(0);
    expect(await app.dbRows("SELECT * FROM upload_sessions")).toHaveLength(0);
    expect(await app.dbRows("SELECT * FROM files")).toHaveLength(0);
    app.setFailPut(true);
    await expect(importRemoteFile(app.env, options, async () => fileResponse("test")))
      .rejects.toThrow("save remote");
    expect(app.objects.size).toBe(0);
    expect(await app.dbRows("SELECT * FROM upload_sessions")).toHaveLength(0);
    expect(await app.dbRows("SELECT * FROM shares")).toHaveLength(0);
  });

  test("route requires admin cookie and same-origin authorization; public upload page has no URL import", async () => {
    const app = setup();
    const path = "/secret-admin/api/import-url";
    const body = JSON.stringify(options);
    const unauthorized = await app.request(path, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body,
    });
    expect(unauthorized.status).toBe(401);
    const wrongOrigin = await app.request(path, {
      method: "POST", headers: {
        Origin: "https://attacker.example.net", Cookie: await app.cookie(),
        "Content-Type": "application/json",
      }, body,
    });
    expect(wrongOrigin.status).toBe(403);
    const malformed = await app.request(path, {
      method: "POST", headers: {
        Origin: origin, Cookie: await app.cookie(), "Content-Type": "application/json",
      }, body: JSON.stringify({ ...options, url: "http://localhost/file" }),
    });
    expect(malformed.status).toBe(400);
    const source = readFileSync(new URL("../src/public-upload.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("Import from URL");
    expect(source).not.toContain("/import-url");
    const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
    expect(worker).not.toContain('app.post("/api/public-uploads/:id/import-url"');
  });
});
