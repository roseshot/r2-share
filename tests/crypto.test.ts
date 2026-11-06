import { describe, expect, test } from "bun:test";
import {
  b64, decryptCode, encryptCode, equalText, randomCode, randomId, randomRevision, readToken, signToken,
} from "../worker/crypto";
import type { FileRecord } from "../worker/model";

const codeKey = b64(crypto.getRandomValues(new Uint8Array(32)));
const signingSecret = "test-secret-keep-private-and-long-enough-123456789";

describe("encrypted access codes", () => {
  test("roundtrip: admin can recover protected code", async () => {
    const id = randomId();
    const revision = randomRevision();
    const encryptedCode = await encryptCode("A8K29P", id, revision, codeKey);
    const file: FileRecord = {
      id, revision, encryptedCode, mode: "protected", filename: "test.zip",
      size: 1, mime: "application/zip",
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    expect(await decryptCode(file, codeKey)).toBe("A8K29P");
    expect(JSON.stringify(file)).not.toContain("A8K29P");
  });
  test("ciphertext is bound to file id and revision", async () => {
    const id = randomId();
    const revision = randomRevision();
    const ciphertext = await encryptCode("ABCD1234", id, revision, codeKey);
    const file: FileRecord = {
      id, revision: randomRevision(), encryptedCode: ciphertext, mode: "protected",
      filename: "a", size: 1, mime: "application/octet-stream",
      createdAt: "", expiresAt: "",
    };
    expect(decryptCode(file, codeKey)).rejects.toThrow();
  });
  test("uses 16-character Base64URL IDs with 96 random bits", () => {
    const ids = Array.from({ length: 120 }, randomId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
  test("randomly generated codes have eight display-safe characters", () => {
    expect(randomCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });
});

describe("signed sessions", () => {
  test("valid signed claims can be verified", async () => {
    const token = await signToken(signingSecret, { scope: "admin", exp: Date.now() + 30000 });
    expect((await readToken(signingSecret, token))?.scope).toBe("admin");
  });
  test("tampered and expired tokens are rejected", async () => {
    const token = await signToken(signingSecret, { scope: "admin", exp: Date.now() + 30000 });
    expect(await readToken(signingSecret, token + "a")).toBeNull();
    const expired = await signToken(signingSecret, { scope: "admin", exp: Date.now() - 1 });
    expect(await readToken(signingSecret, expired)).toBeNull();
  });
  test("text equality is exact", async () => {
    expect(await equalText("secret", "secret")).toBe(true);
    expect(await equalText("secret", "Secret")).toBe(false);
  });
});
