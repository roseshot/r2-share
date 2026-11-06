import { describe, expect, test } from "bun:test";
import {
  encryptAppSettings, decryptAppSettings, deriveRuntimeKeys, readAppSettings, resolveBindings, saveAppSettings,
} from "../worker/app-config";
import { b64, decryptCode, encryptCode, readToken, signToken } from "../worker/crypto";
import { createTestDatabase } from "./d1-helper";
import { bindObjectStore } from "../worker/object-store";
import type { Bindings } from "../worker/model";
import handler from "../worker/index";

const master = b64(crypto.getRandomValues(new Uint8Array(32)));
const settings = {
  b2Bucket: "private-backups",
  b2Region: "us-west-004",
  b2KeyId: "test-b2-key-id",
  b2ApplicationKey: "test-b2-secret-application-key",
  virusTotalApiKey: "optional-reputation-key",
};
const adminPath = "private-admin-entry";
const adminPassword = "strong-admin-password";

function createEnv(): Bindings {
  const env = {
    DB: createTestDatabase(), APP_MASTER_KEY: master,
    ADMIN_PATH: adminPath, ADMIN_PASSWORD: adminPassword,
    LOGIN_LIMITER: { limit: async () => ({ success: true }) },
    CODE_LIMITER: { limit: async () => ({ success: true }) },
    ASSETS: { fetch: async () => new Response("<!doctype html>") },
  } as unknown as Bindings;
  bindObjectStore(env, {
    get: async () => null,
    head: async () => null,
    put: async () => ({ size: 1, uploaded: new Date() }),
    delete: async () => {},
    list: async () => ({ objects: [], truncated: false }),
  }, "b2");
  return env;
}

function request(env: Bindings, path: string, options: RequestInit = {}) {
  return handler.fetch(new Request("https://app.example.test" + path, options), env, {} as ExecutionContext);
}

function jsonRequest(method: string, body: unknown, cookie?: string): RequestInit {
  return {
    method,
    headers: {
      Origin: "https://app.example.test",
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  };
}

describe("D1 application settings and runtime administrator credentials", () => {
  test("encrypts B2 credentials and API keys in D1", async () => {
    const encrypted = await encryptAppSettings(master, settings);
    for (const value of Object.values(settings)) expect(encrypted).not.toContain(value);
    expect(await decryptAppSettings(master, encrypted)).toEqual(settings);
  });

  test("rejects incorrect keys and modified ciphertext", async () => {
    const encrypted = await encryptAppSettings(master, settings);
    const other = b64(crypto.getRandomValues(new Uint8Array(32)));
    await expect(decryptAppSettings(other, encrypted)).rejects.toThrow();
    const parsed = JSON.parse(encrypted);
    parsed.iv = b64(crypto.getRandomValues(new Uint8Array(12)));
    await expect(decryptAppSettings(master, JSON.stringify(parsed))).rejects.toThrow();
  });

  test("derives independent session and access-code encryption keys", async () => {
    const keys = await deriveRuntimeKeys(master);
    expect(keys.SESSION_SECRET).not.toBe(keys.CODE_ENCRYPTION_KEY);
    const token = await signToken(keys.SESSION_SECRET, { scope: "admin", exp: Date.now() + 10000 });
    expect((await readToken(keys.SESSION_SECRET, token))?.scope).toBe("admin");
    expect(await readToken(keys.CODE_ENCRYPTION_KEY, token)).toBeNull();
    const encrypted = await encryptCode("private-code", "A".repeat(16), "revision", keys.CODE_ENCRYPTION_KEY);
    const record = { id: "A".repeat(16), revision: "revision", encryptedCode: encrypted } as import("../worker/model").FileRecord;
    expect(await decryptCode(record, keys.CODE_ENCRYPTION_KEY)).toBe("private-code");
  });

  test("allows admin login and B2 configuration without a settings record", async () => {
    const env = createEnv();
    const root = "/" + adminPath + "/api";
    expect(await readAppSettings(env)).toBeNull();
    const before = await request(env, root + "/files");
    expect(before.status).toBe(401);

    const login = await request(env, root + "/login", jsonRequest("POST", { password: adminPassword }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    expect(cookie).toContain("r2_share_admin=");

    const filesBefore = await request(env, root + "/files", { headers: { Cookie: cookie } });
    expect(filesBefore.status).toBe(200);
    expect(await filesBefore.json()).toEqual({ files: [], truncated: false });

    const empty = await request(env, root + "/settings", { headers: { Cookie: cookie } });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      configured: false, b2Configured: false, r2Configured: false,
      b2Bucket: "", b2Region: "", b2KeyId: "",
      r2AccountId: "", r2Bucket: "", r2AccessKeyId: "",
      virusTotalEnabled: false,
    });

    const wrong = await request(env, root + "/settings", jsonRequest("PATCH", {
      adminPassword: "not-allowed", ...settings,
    }, cookie));
    expect(wrong.status).toBe(400);
    const initialize = await request(env, root + "/settings", jsonRequest("PATCH", settings, cookie));
    expect(initialize.status).toBe(200);
    expect(await initialize.json()).toEqual({ ok: true });

    const saved = await readAppSettings(env);
    expect(saved).toEqual(settings);
    const row = await env.DB.prepare("SELECT payload FROM app_settings WHERE id = 1")
      .first<{ payload: string }>();
    expect(row?.payload).not.toContain(settings.b2ApplicationKey);
    expect(row?.payload).not.toContain(adminPassword);

    const view = await request(env, root + "/settings", { headers: { Cookie: cookie } });
    expect(view.status).toBe(200);
    expect(await view.json()).toEqual({
      configured: true, b2Configured: true, r2Configured: false,
      r2AccountId: "", r2Bucket: "", r2AccessKeyId: "",
      b2Bucket: settings.b2Bucket,
      b2Region: settings.b2Region,
      b2KeyId: settings.b2KeyId,
      virusTotalEnabled: true,
    });

    const filesAfter = await request(env, root + "/files", { headers: { Cookie: cookie } });
    expect(filesAfter.status).toBe(200);

    const updated = await request(env, root + "/settings", jsonRequest("PATCH", {
      b2Region: "us-east-005",
    }, cookie));
    expect(updated.status).toBe(200);
    expect((await readAppSettings(env))?.b2Region).toBe("us-east-005");
    expect((await readAppSettings(env))?.b2ApplicationKey).toBe(settings.b2ApplicationKey);

    const oldPassword = await request(env, root + "/login", jsonRequest("POST", { password: "wrong-password" }));
    expect(oldPassword.status).toBe(401);
    expect((await request(env, "/setup")).status).toBe(404);
    expect((await request(env, "/api/setup/status")).status).toBe(404);
  });

  test("configures R2 independently without requiring B2 credentials", async () => {
    const env = createEnv();
    const store = {
      get: async () => null,
      head: async () => null,
      put: async () => ({ size: 1, uploaded: new Date() }),
      delete: async () => {},
      list: async () => ({ objects: [], truncated: false }),
    };
    bindObjectStore(env, store, "r2");
    const root = "/" + adminPath + "/api";
    const login = await request(env, root + "/login", jsonRequest("POST", { password: adminPassword }));
    const cookie = login.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    const credentials = {
      r2AccountId: "1".repeat(32),
      r2Bucket: "test-r2-bucket",
      r2AccessKeyId: "example-r2-access-key",
      r2SecretAccessKey: "example-r2-secret-key",
    };
    const invalid = await request(env, root + "/settings", jsonRequest("PATCH", {
      ...credentials, r2AccountId: "invalid",
    }, cookie));
    expect(invalid.status).toBe(400);
    const created = await request(env, root + "/settings", jsonRequest("PATCH", credentials, cookie));
    expect(created.status).toBe(200);
    const config = await readAppSettings(env);
    expect(config).toMatchObject({
      b2Bucket: "", b2Region: "", b2KeyId: "", b2ApplicationKey: "", ...credentials,
    });
    const resolved = await resolveBindings(env);
    expect(resolved.R2_ACCOUNT_ID).toBe(credentials.r2AccountId);
    expect(resolved.R2_SECRET_ACCESS_KEY).toBe(credentials.r2SecretAccessKey);

    const stored = await env.DB.prepare("SELECT payload FROM app_settings WHERE id = 1")
      .first<{ payload: string }>();
    expect(stored!.payload).not.toContain(credentials.r2SecretAccessKey);
    const visible = await request(env, root + "/settings", { headers: { Cookie: cookie } });
    expect(await visible.json()).toEqual({
      configured: true, b2Configured: false, r2Configured: true,
      b2Bucket: "", b2Region: "", b2KeyId: "",
      r2AccountId: credentials.r2AccountId, r2Bucket: credentials.r2Bucket,
      r2AccessKeyId: credentials.r2AccessKeyId, virusTotalEnabled: false,
    });
    const saved = await request(env, root + "/settings", jsonRequest("PATCH", {
      r2Bucket: "new-r2-bucket",
    }, cookie));
    expect(saved.status).toBe(200);
    expect((await readAppSettings(env))?.r2SecretAccessKey).toBe(credentials.r2SecretAccessKey);
  });

  test("keeps administrator secrets out of a fresh D1 settings record", async () => {
    const env = createEnv();
    await saveAppSettings(env, settings);
    expect(await readAppSettings(env)).toEqual(settings);
    const stored = await env.DB.prepare("SELECT payload FROM app_settings WHERE id = 1")
      .first<{ payload: string }>();
    expect(stored?.payload).not.toContain(adminPassword);
    expect(stored?.payload).not.toContain(adminPath);
    const resolved = await resolveBindings(env);
    expect(resolved.ADMIN_PATH).toBe(adminPath);
    expect(resolved.ADMIN_PASSWORD).toBe(adminPassword);
    expect(resolved.B2_KEY_ID).toBe(settings.b2KeyId);
    expect(resolved.B2_APPLICATION_KEY).toBe(settings.b2ApplicationKey);
    expect(resolved.ADMIN_AUTH_REVISION).toHaveLength(43);
  });

  test("password rotation invalidates existing administrator sessions", async () => {
    const env = createEnv();
    const oldKeys = await resolveBindings(env);
    const signed = await signToken(oldKeys.SESSION_SECRET, {
      scope: "admin", entry: adminPath, revision: oldKeys.ADMIN_AUTH_REVISION,
      exp: Date.now() + 60000,
    });
    env.ADMIN_PASSWORD = "rotated-admin-password";
    const response = await request(env, "/" + adminPath + "/api/session", {
      headers: { Cookie: "r2_share_admin=" + signed },
    });
    expect(response.status).toBe(401);
  });

  test("missing master or administrator secrets prevent private access", async () => {
    const env = createEnv();
    env.ADMIN_PASSWORD = "";
    const response = await request(env, "/" + adminPath + "/api/login",
      jsonRequest("POST", { password: adminPassword }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Service is not configured" });
  });
});
