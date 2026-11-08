import { describe, expect, test } from "bun:test";
import { readToken } from "../worker/crypto";
import { configuredDownloadNodes, pickDownloadNode, redirectedDownload } from "../worker/download-node";
import { type Bindings, type FileRecord } from "../worker/model";

const secret = "this-is-a-unique-secret-with-more-than-32-chars";
const env = (nodes?: string, key?: string) => ({
  DOWNLOAD_NODES: nodes, DOWNLOAD_NODE_SECRET: key,
}) as Bindings;
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
    await expect(redirectedDownload(env("https://download.example.com", secret),
      file, new Date(Date.now() - 1000).toISOString())).rejects.toThrow();
  });
});
