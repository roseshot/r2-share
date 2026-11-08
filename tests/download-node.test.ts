import { describe, expect, test } from "bun:test";
import { readToken, unb64 } from "../worker/crypto";
import { configuredDownloadNodes, pickDownloadNode, redirectedDownload } from "../worker/download-node";
import { type Bindings, type FileRecord } from "../worker/model";

const secret = "this-is-a-unique-secret-with-more-than-32-chars";
const env = (nodes?: string, key?: string) => ({
  DOWNLOAD_NODES: nodes, DOWNLOAD_NODE_SECRET: key,
  STORAGES: [{
    id: "b2-primary", backend: "b2", bucket: "private-backups",
    region: "us-west-004", keyId: "test-access-id", applicationKey: "test-application-secret",
  }],
}) as Bindings;

async function revealSource(ciphertext: string) {
  const [iv, data] = ciphertext.split(".");
  const encoder = new TextEncoder();
  const raw = await crypto.subtle.digest("SHA-256",
    encoder.encode("tuckbox-download-source/v1:" + secret));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(data));
  return JSON.parse(new TextDecoder().decode(clear)) as { get: string; head: string };
}
const file: FileRecord = {
  id: "3d4071e7-a4b3-4c06-9801-61f4aca13052",
  storageId: "b2-primary", filename: "example file.zip", size: 2056,
  mime: "application/zip", createdAt: new Date().toISOString(),
  mode: "public", revision: "rev", expiresAt: null, shareExpiresAt: null,
};

describe("Go download offload configuration and signed grants", () => {
  test("preserves native Worker streaming when offload is unconfigured", async () => {
    expect(configuredDownloadNodes(env())).toEqual([]);
    expect(await redirectedDownload(env(), file)).toBeNull();
  });
  test("rejects unsafe endpoints and incomplete secrets", () => {
    for (const invalid of [
      "http://node.example.com", "https://user:pass@node.example.com",
      "https://node.example.com/path", "https://node.example.com/?a=1",
      "https://node.example.com#fragment", "https://node.example.com,https://node.example.com",
      Array.from({length: 17}, (_, n) => "https://node-" + n + ".example.com").join(","),
    ]) expect(() => configuredDownloadNodes(env(invalid, secret)), invalid).toThrow();
    expect(() => configuredDownloadNodes(env("https://node.example.com", "short"))).toThrow();
  });
  test("pins the same file to the same node and binds a short-lived download to that host", async () => {
    const nodes = "https://dl1.example.com,https://dl2.example.com:8443";
    const config = env(nodes, secret);
    const selected = pickDownloadNode(configuredDownloadNodes(config), file.id);
    expect(pickDownloadNode(configuredDownloadNodes(config), file.id).host).toBe(selected.host);
    const response = await redirectedDownload(config, file);
    expect(response?.status).toBe(307);
    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
    const location = new URL(response!.headers.get("Location")!);
    expect(location.host).toBe(selected.host);
    expect(location.pathname).toBe("/v1/download");
    const token = location.searchParams.get("token");
    const claims = await readToken(secret, token!);
    expect(claims).toMatchObject({
      scope: "tuckbox-download/v1", storageId: "b2-primary",
      key: "tuckbox/" + file.id, filename: "example file.zip", mime: file.mime,
      size: file.size, aud: selected.host,
    });
    expect(claims?.exp as number).toBeLessThanOrEqual(Date.now() + 90_000);
    expect(typeof claims?.source).toBe("string");
    expect(token).not.toContain("backblazeb2.com");
    expect(token).not.toContain("test-application-secret");
    const source = await revealSource(claims!.source as string);
    const signedGet = new URL(source.get);
    const signedHead = new URL(source.head);
    expect(signedGet.host).toBe("s3.us-west-004.backblazeb2.com");
    expect(signedGet.pathname).toBe("/private-backups/tuckbox/" + file.id);
    expect(signedGet.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(signedGet.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(Number(signedGet.searchParams.get("X-Amz-Expires"))).toBeGreaterThan(0);
    expect(Number(signedGet.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(90);
    expect(signedHead.searchParams.get("X-Amz-Signature")).not.toBe(signedGet.searchParams.get("X-Amz-Signature"));
    expect(await readToken(secret, token! + "tampered")).toBeNull();
  });
  test("caps token lifetime to file or share expiration", async () => {
    const deadline = Date.now() + 8000;
    const response = await redirectedDownload(
      env("https://download.example.com", secret),
      { ...file, expiresAt: new Date(deadline + 1000).toISOString() },
      new Date(deadline).toISOString(),
    );
    const token = new URL(response!.headers.get("Location")!).searchParams.get("token")!;
    const claims = await readToken(secret, token);
    expect(claims?.exp).toBe(deadline);
    const source = await revealSource(claims!.source as string);
    expect(Number(new URL(source.get).searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(8);
    await expect(redirectedDownload(env("https://download.example.com", secret),
      file, new Date(Date.now() - 1000).toISOString())).rejects.toThrow();
  });
  test("requires a configured Worker storage, not storage credentials on nodes", async () => {
    const config = env("https://download.example.com", secret);
    config.STORAGES = [];
    await expect(redirectedDownload(config, file)).rejects.toThrow("Storage ID is not configured");
  });
  test("presigns R2 and AWS S3 GET/HEAD requests using Worker credentials", async () => {
    const config = env("https://download.example.com", secret);
    for (const [storage, host] of [
      [{ id: "b2-primary", backend: "r2", bucket: "private-backups",
        accountId: "a".repeat(32), accessKeyId: "r2-access", secretAccessKey: "r2-secret" },
        "a".repeat(32) + ".r2.cloudflarestorage.com"],
      [{ id: "b2-primary", backend: "s3", bucket: "private-backups",
        region: "eu-west-1", accessKeyId: "aws-access", secretAccessKey: "aws-secret" },
        "s3.eu-west-1.amazonaws.com"],
    ] as const) {
      config.STORAGES = [storage as NonNullable<Bindings["STORAGES"]>[number]];
      const response = await redirectedDownload(config, file);
      const token = new URL(response!.headers.get("Location")!).searchParams.get("token")!;
      const claims = await readToken(secret, token);
      const source = await revealSource(claims!.source as string);
      expect(new URL(source.get).host).toBe(host);
      expect(new URL(source.head).host).toBe(host);
    }
  });
});
