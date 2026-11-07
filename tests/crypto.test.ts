import { describe, expect, test } from "bun:test";
import {
  b64, decryptCode, encryptCode, equalText, randomCode, randomId, randomFileId, randomRevision, readToken, signToken,
} from "../worker/crypto";
import { dataKey, validId, validStoredId, validUuidV4, validObjectKey } from "../worker/model";
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
  test("creates random Base64URL IDs with lengths of 8, 9, or 10 characters", () => {
    const ids = Array.from({ length: 600 }, randomId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids.map(id => id.length))).toEqual(new Set([8, 9, 10]));
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{8,10}$/);
      expect(validId(id)).toBe(true);
      expect(validStoredId(id)).toBe(false);
    }
  });
  test("rejects legacy 16-character IDs and all lengths outside 8-10", () => {
    for (const length of [1, 7, 11, 12, 15, 16, 20]) {
      expect(validId("A".repeat(length))).toBe(false);
      expect(validStoredId("A".repeat(length))).toBe(length === 16);
    }
    for (const length of [8, 9, 10]) expect(validId("A".repeat(length))).toBe(true);
    expect(validId("invalid!")).toBe(false);
  });
  test("generates UUID v4 file IDs independently of short share IDs", () => {
    const ids = Array.from({ length: 200 }, randomFileId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      expect(validUuidV4(id)).toBe(true);
      expect(validStoredId(id)).toBe(true);
      expect(validId(id)).toBe(false);
      expect(dataKey(id)).toBe("tuckbox/" + id);
      expect(validObjectKey(dataKey(id))).toBe(true);
    }
  });
  test("keeps legacy file IDs on their original bucket keys without migrating objects", () => {
    const legacy = "A_-a".repeat(4);
    expect(validStoredId(legacy)).toBe(true);
    expect(dataKey(legacy)).toBe("files/" + legacy);
    expect(validObjectKey(dataKey(legacy))).toBe(true);
  });
  test("rejects malformed, wrong-version, and wrong-variant UUIDs and object paths", () => {
    const id = randomFileId();
    const versionSegments = id.split("-");
    versionSegments[2] = "1" + versionSegments[2].slice(1);
    expect(validUuidV4(versionSegments.join("-"))).toBe(false);
    const segments = id.split("-");
    segments[3] = "0" + segments[3].slice(1);
    expect(validUuidV4(segments.join("-"))).toBe(false);
    expect(validStoredId("A".repeat(35))).toBe(false);
    expect(validStoredId("A".repeat(37))).toBe(false);
    expect(validObjectKey("/tuckbox/" + id)).toBe(false);
    expect(validObjectKey("files/" + id)).toBe(false);
    expect(validObjectKey("tuckbox/" + "A_-a".repeat(4))).toBe(false);
    expect(validObjectKey("tuckbox/" + id + "/other")).toBe(false);
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
