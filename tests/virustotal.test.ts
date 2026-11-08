import { describe, expect, test } from "bun:test";
import { getVirusTotalReport, submitAuthorizedVirusTotalFile } from "../worker/virustotal";
import { bindObjectStore } from "../worker/object-store";
import { dataKey, type Bindings, type FileRecord } from "../worker/model";

const hash = "a".repeat(64);

describe("VirusTotal hash-only lookup", () => {
  test("requires a configured secret and never sends file bytes", async () => {
    let requests = 0;
    const notConfigured = await getVirusTotalReport(hash, undefined, async () => {
      requests++;
      return new Response(null, { status: 200 });
    });
    expect(notConfigured).toEqual({ status: "not_configured" });
    expect(requests).toBe(0);

    let requestedUrl = "";
    let method = "";
    let auth = "";
    const result = await getVirusTotalReport(hash, "private-api-key", async (input, init) => {
      requestedUrl = String(input);
      method = init?.method ?? "";
      auth = new Headers(init?.headers).get("x-apikey") ?? "";
      expect(init?.body).toBeUndefined();
      return Response.json({
        data: { attributes: { last_analysis_stats: {
          malicious: 3, suspicious: 1, harmless: 50, undetected: 10,
        }, last_analysis_date: 1750000000 } },
      });
    });
    expect(requestedUrl).toBe("https://www.virustotal.com/api/v3/files/" + hash);
    expect(method).toBe("GET");
    expect(auth).toBe("private-api-key");
    expect(result).toEqual({
      status: "found", malicious: 3, suspicious: 1, harmless: 50,
      undetected: 10, scanDate: 1750000000,
    });
  });

  test("uses VirusTotal large-file upload URL and rejects third-party hosts", async () => {
    const size = 33 * 1024 * 1024;
    const fileId = crypto.randomUUID();
    const record: FileRecord = {
      id: fileId, filename: "large.bin", size, storageId: "mock",
      mime: "application/octet-stream", mode: "public", revision: "test",
      createdAt: new Date().toISOString(), expiresAt: null,
      shareExpiresAt: null, checksums: { sha256: hash },
    };
    const data = new Uint8Array(128 * 1024);
    const fileBody = () => {
      let remaining = size;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!remaining) { controller.close(); return; }
          const next = data.subarray(0, Math.min(remaining, data.byteLength));
          remaining -= next.byteLength;
          controller.enqueue(next);
        },
      });
    };
    const env = { STORAGES: [{
      id: "mock", backend: "b2", bucket: "test-bucket",
      region: "us-west-004", keyId: "key-1234", applicationKey: "secret-1234",
    }] } as Bindings;
    bindObjectStore(env, {
      async get(key: string) {
        expect(key).toBe(dataKey(fileId));
        return { body: fileBody(), size, uploaded: new Date() };
      },
      async head() { return null; },
      async put() { throw new Error("Unreachable"); },
      async delete() {},
      async list() { return { objects: [], truncated: false }; },
    }, "mock");
    let posts = 0;
    const request: typeof fetch = async (input, init) => {
      if (init?.method === "GET") {
        expect(String(input)).toBe("https://www.virustotal.com/api/v3/files/upload_url");
        return Response.json({ data: "http://www.virustotal.com/_ah/upload/test-token/" });
      }
      posts++;
      expect(String(input)).toBe("https://www.virustotal.com/_ah/upload/test-token/");
      let counted = 0;
      const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        counted += next.value.byteLength;
      }
      expect(counted).toBe(Number(new Headers(init?.headers).get("Content-Length")));
      return Response.json({ data: { id: "analysis-big" } });
    };
    expect(await submitAuthorizedVirusTotalFile(env, record, "secret", request)).toBe("submitted");
    expect(posts).toBe(1);
    expect(await submitAuthorizedVirusTotalFile(env, record, "secret", async (_input, init) =>
      init?.method === "GET"
        ? Response.json({ data: "https://untrusted.example.com/_ah/upload/file" })
        : Response.json({ data: { id: "should-not-upload" } }))).toBe("unavailable");
  });

  test("distinguishes missing reports, throttling and upstream errors", async () => {
    const reply = (status: number) => getVirusTotalReport(hash, "secret", async () =>
      new Response(null, { status }));
    expect(await reply(404)).toEqual({ status: "not_found" });
    expect(await reply(429)).toEqual({ status: "rate_limited" });
    expect(await reply(503)).toEqual({ status: "unavailable" });
    expect(await getVirusTotalReport(hash, "secret", async () => {
      throw new Error("Network error");
    })).toEqual({ status: "unavailable" });
  });
});
