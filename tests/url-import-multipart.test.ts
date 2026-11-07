import { describe, expect, test } from "bun:test";
import { getObjectStore } from "../worker/object-store";
import { type Bindings, type StorageConfig } from "../worker/model";

const key = "tuckbox/8a6f0b12-3c45-4d67-8e90-123456789abc";
const xmlStart = "<InitiateMultipartUploadResult><UploadId>up-test-1</UploadId></InitiateMultipartUploadResult>";
const xmlFinish = "<CompleteMultipartUploadResult><ETag>done</ETag></CompleteMultipartUploadResult>";

function source(length: number): ReadableStream<Uint8Array> {
  let left = length;
  return new ReadableStream({
    pull(controller) {
      if (!left) { controller.close(); return; }
      const size = Math.min(left, 256 * 1024);
      const bytes = new Uint8Array(size);
      bytes.fill(97);
      left -= size;
      controller.enqueue(bytes);
    },
  });
}

describe("S3-compatible multipart remote imports", () => {
  test("streams parts with signed requests and completes on AWS S3", async () => {
    const storage: StorageConfig = {
      id: "aws-remote", backend: "s3", bucket: "remote-storage",
      region: "us-east-1", accessKeyId: "test-id", secretAccessKey: "test-secret",
    };
    const store = getObjectStore({ STORAGES: [storage] } as Bindings, storage.id);
    const original = globalThis.fetch;
    const total = 10 * 1024 * 1024 + 123;
    const parts: { number: number; size: number }[] = [];
    const sequence: string[] = [];
    globalThis.fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      expect(url.hostname).toBe("s3.us-east-1.amazonaws.com");
      expect(url.pathname).toBe("/remote-storage/" + key);
      expect(req.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
      if (req.method === "POST" && url.searchParams.has("uploads")) {
        sequence.push("start");
        return new Response(xmlStart, { headers: { "Content-Type": "application/xml" } });
      }
      if (req.method === "PUT") {
        const number = Number(url.searchParams.get("partNumber"));
        expect(url.searchParams.get("uploadId")).toBe("up-test-1");
        const size = (await req.arrayBuffer()).byteLength;
        parts.push({ number, size });
        sequence.push("part" + number);
        return new Response(null, { status: 200, headers: { ETag: '"part-' + number + '"' } });
      }
      if (req.method === "POST" && url.searchParams.has("uploadId")) {
        const body = await req.text();
        expect(body).toContain("<PartNumber>1</PartNumber><ETag>&quot;part-1&quot;</ETag>");
        expect(body).toContain("<PartNumber>2</PartNumber><ETag>&quot;part-2&quot;</ETag>");
        sequence.push("complete");
        return new Response(xmlFinish);
      }
      if (req.method === "HEAD") {
        sequence.push("head");
        return new Response(null, { headers: { "Content-Length": String(total) } });
      }
      throw new Error("Unexpected S3 request: " + req.method + " " + url);
    };
    try {
      const info = await store.putMultipart!(key, source(total), "application/octet-stream");
      expect(info.size).toBe(total);
      expect(parts).toEqual([
        { number: 1, size: 8 * 1024 * 1024 },
        { number: 2, size: 2 * 1024 * 1024 + 123 },
      ]);
      expect(sequence).toEqual(["start", "part1", "part2", "complete", "head"]);
    } finally { globalThis.fetch = original; }
  });

  test("aborts multipart uploads if a part fails on B2", async () => {
    const storage: StorageConfig = {
      id: "b2-remote", backend: "b2", bucket: "remote-backups",
      region: "us-west-004", keyId: "key", applicationKey: "secret",
    };
    const store = getObjectStore({ STORAGES: [storage] } as Bindings, storage.id);
    const original = globalThis.fetch;
    const methods: string[] = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      expect(url.hostname).toBe("s3.us-west-004.backblazeb2.com");
      if (request.method === "POST" && url.searchParams.has("uploads")) {
        methods.push("start"); return new Response(xmlStart);
      }
      if (request.method === "PUT") {
        methods.push("part");
        return new Response("unavailable", { status: 503 });
      }
      if (request.method === "DELETE" && url.searchParams.has("uploadId")) {
        methods.push("abort"); return new Response(null, { status: 204 });
      }
      throw new Error("Unexpected S3 request");
    };
    try {
      await expect(store.putMultipart!(key, source(9 * 1024 * 1024), "application/octet-stream"))
        .rejects.toThrow("UploadPart failed");
      expect(methods).toEqual(["start", "part", "abort"]);
    } finally { globalThis.fetch = original; }
  });

  test("aborts a multipart session on R2 when completion responds HTTP 200 with XML error", async () => {
    const storage: StorageConfig = {
      id: "r2-remote", backend: "r2", bucket: "remote-files",
      accountId: "b".repeat(32), accessKeyId: "key", secretAccessKey: "secret",
    };
    const store = getObjectStore({ STORAGES: [storage] } as Bindings, storage.id);
    const original = globalThis.fetch;
    const actions: string[] = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      expect(url.hostname).toBe("b".repeat(32) + ".r2.cloudflarestorage.com");
      if (request.method === "POST" && url.searchParams.has("uploads")) {
        actions.push("start"); return new Response(xmlStart);
      }
      if (request.method === "PUT") {
        actions.push("part");
        await request.arrayBuffer();
        return new Response(null, { headers: { ETag: '"part"' } });
      }
      if (request.method === "POST" && url.searchParams.has("uploadId")) {
        actions.push("complete");
        return new Response("<Error><Code>InternalError</Code></Error>");
      }
      if (request.method === "DELETE") {
        actions.push("abort"); return new Response(null, { status: 204 });
      }
      throw new Error("Unexpected S3 request");
    };
    try {
      await expect(store.putMultipart!(key, source(1024), "application/octet-stream"))
        .rejects.toThrow("multipart completion failed");
      expect(actions).toEqual(["start", "part", "complete", "abort"]);
    } finally { globalThis.fetch = original; }
  });
});
