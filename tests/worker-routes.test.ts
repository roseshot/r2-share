import { describe, expect, test } from "bun:test";
import handler from "../worker/index";
import type { Bindings } from "../worker/model";
import { bindTestSettings } from "../worker/app-config";

function makeEnv(path: string, redirectAsset = false): Bindings {
  const env = {
    ADMIN_PATH: path,
    ASSETS: {
      fetch: async () => redirectAsset
        ? new Response(null, { status: 307, headers: { Location: "/" } })
        : new Response("<!doctype html><html lang=\"en\"></html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    },
  } as unknown as Bindings;
  bindTestSettings(env);
  return env;
}

describe("Worker page routes", () => {
  test("serves a public homepage without admin authentication", async () => {
    const response = await handler.fetch(new Request("https://site.example/"), makeEnv("secret"), {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<!doctype html>");
  });

  test("does not expose an HTML asset redirect to the browser", async () => {
    const response = await handler.fetch(
      new Request("https://site.example/"), makeEnv("secret", true), {} as ExecutionContext,
    );
    expect(response.status).toBe(502);
    expect(response.headers.has("Location")).toBe(false);
  });

  test("forwards the branded favicon request to the static asset binding", async () => {
    let requestedPath = "";
    const env = {
      ...makeEnv("secret"),
      ASSETS: {
        fetch: async (request: Request) => {
          requestedPath = new URL(request.url).pathname;
          return new Response("<svg></svg>", {
            headers: { "Content-Type": "image/svg+xml" },
          });
        },
      },
    } as Bindings;
    const response = await handler.fetch(
      new Request("https://site.example/tuckbox-mark.svg"),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(requestedPath).toBe("/tuckbox-mark.svg");
  });

  test("accepts short and long admin paths", async () => {
    for (const path of ["a", "a".repeat(512)]) {
      const response = await handler.fetch(new Request("https://site.example/" + path), makeEnv(path), {} as ExecutionContext);
      expect(response.status).toBe(200);
    }
  });

  test("keeps a 16-character admin path reachable", async () => {
    const entry = "HiddenAdminRoute";
    const response = await handler.fetch(
      new Request("https://site.example/" + entry),
      makeEnv(entry),
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<!doctype html>");
  });

  test("renders the normal HTML shell for unknown or malformed share IDs", async () => {
    for (const entry of ["another", "Kq8mH2_nP4xY7zQb", "unknown_share"]) {
      const response = await handler.fetch(
        new Request("https://site.example/" + entry), makeEnv("secret"), {} as ExecutionContext,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/html");
      expect(await response.text()).toContain("<!doctype html>");
    }
    const invalidApi = await handler.fetch(
      new Request("https://site.example/api/files/bad!"),
      makeEnv("secret"),
      {} as ExecutionContext,
    );
    expect(invalidApi.status).toBe(404);
  });

  test("keeps an unavailable share page for IDs outside the 8-12 character range", async () => {
    const env = makeEnv("secret");
    for (const length of [1, 7, 13, 16, 21, 40]) {
      const shareId = "A".repeat(length);
      const page = await handler.fetch(
        new Request("https://site.example/" + shareId), env, {} as ExecutionContext,
      );
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("<!doctype html>");
      const metadata = await handler.fetch(
        new Request("https://site.example/api/files/" + shareId),
        env, {} as ExecutionContext,
      );
      expect(metadata.status).toBe(404);
    }
  });

  test("redirects unknown pages to the homepage but preserves API 404 responses", async () => {
    for (const path of ["/unknown/extra", "/u/not-valid-invalid", "/upload/ABCDEFGHIJKLMNOP"]) {
      const response = await handler.fetch(
        new Request("https://site.example" + path), makeEnv("secret"), {} as ExecutionContext,
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/");
    }
    const missingApi = await handler.fetch(
      new Request("https://site.example/api/unknown"), makeEnv("secret"), {} as ExecutionContext,
    );
    expect(missingApi.status).toBe(404);
    const missingAsset = await handler.fetch(
      new Request("https://site.example/assets/unknown"), makeEnv("secret"), {} as ExecutionContext,
    );
    expect(missingAsset.status).toBe(200);
  });
});

function makeLoginEnv(password: string): Bindings {
  const env = {
    ...makeEnv("secret"),
    ADMIN_PASSWORD: password,
    SESSION_SECRET: "s".repeat(48),
    CODE_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    LOGIN_LIMITER: { limit: async () => ({ success: true }) },
  };
  bindTestSettings(env);
  return env;
}

async function login(env: Bindings, password: string): Promise<Response> {
  return handler.fetch(
    new Request("https://site.example/secret/api/login", {
      method: "POST",
      headers: {
        "Origin": "https://site.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password }),
    }),
    env,
    {} as ExecutionContext,
  );
}

describe("administrator password requirements", () => {
  test("accepts a matching six-character admin password", async () => {
    const response = await login(makeLoginEnv("abcdef"), "abcdef");
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("r2_share_admin=");
  });

  test("rejects a configured password shorter than six characters", async () => {
    const response = await login(makeLoginEnv("abcde"), "abcde");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Service is not securely configured" });
  });

  test("still rejects incorrect passwords", async () => {
    const response = await login(makeLoginEnv("abcdef"), "wrong!");
    expect(response.status).toBe(401);
  });

  test("requires a configured application master key", async () => {
    const env = { ...makeLoginEnv("abcdef"), APP_MASTER_KEY: "" };
    const response = await login(env, "abcdef");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Service is not configured" });
  });
});
