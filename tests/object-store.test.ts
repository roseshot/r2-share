import { describe, expect, test } from "bun:test";
import { b2ObjectUrl, r2ObjectUrl, parseListObjectsV2, xmlText } from "../worker/object-store";
import { dataKey } from "../worker/model";

describe("Backblaze B2 S3 compatibility", () => {
  test("parses paginated ListObjectsV2 without DOMParser", () => {
    const page = parseListObjectsV2(`<?xml version="1.0"?>
      <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
        <IsTruncated>true</IsTruncated>
        <Contents><Key>files/1234567890123456</Key><LastModified>2026-11-05T03:10:21.000Z</LastModified></Contents>
        <Contents><Key>files/456</Key><LastModified>2026-11-05T03:11:21.000Z</LastModified></Contents>
        <NextContinuationToken>page&amp;cursor</NextContinuationToken>
      </ListBucketResult>`);
    expect(page.truncated).toBe(true);
    expect(page.cursor).toBe("page&cursor");
    expect(page.objects.map(x => x.key)).toEqual(["files/1234567890123456", "files/456"]);
    expect(page.objects[0].uploaded.toISOString()).toBe("2026-11-05T03:10:21.000Z");
  });
  test("stops after the final S3 page", () => {
    const page = parseListObjectsV2("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>");
    expect(page).toEqual({ objects: [], truncated: false, cursor: undefined });
  });
  test("rejects bad XML and truncated lists missing their cursor", () => {
    expect(() => parseListObjectsV2("<html>403</html>")).toThrow();
    expect(() => parseListObjectsV2("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>")).toThrow();
  });
  test("decodes XML entities", () => {
    expect(xmlText("a&amp;b &lt;x&gt; &#65; &#x42;")).toBe("a&b <x> A B");
  });
  test("places UUID v4 files under tuckbox/ in both B2 and R2 buckets", () => {
    const id = "a8c37123-1468-412a-8dca-b6724d9d3f21";
    const key = dataKey(id);
    expect(key).toBe("tuckbox/" + id);
    expect(b2ObjectUrl("us-west-004", "private-backups", key))
      .toBe("https://s3.us-west-004.backblazeb2.com/private-backups/" + key);
    expect(r2ObjectUrl("a".repeat(32), "private-backups", key))
      .toBe("https://" + "a".repeat(32) + ".r2.cloudflarestorage.com/private-backups/" + key);
  });
  test("retains old files/ keys for previously stored file IDs", () => {
    const key = "files/" + "A_-a".repeat(4);
    expect(b2ObjectUrl("us-west-004", "private-backups", key))
      .toBe("https://s3.us-west-004.backblazeb2.com/private-backups/" + key);
    expect(r2ObjectUrl("a".repeat(32), "private-backups", key))
      .toBe("https://" + "a".repeat(32) + ".r2.cloudflarestorage.com/private-backups/" + key);
  });
  test("rejects arbitrary origin and unexpected object keys", () => {
    expect(() => b2ObjectUrl("evil.example.com", "private-backups")).toThrow();
    expect(() => b2ObjectUrl("us-west-004", "private-backups", "../admin")).toThrow();
    expect(() => b2ObjectUrl("us-west-004", "private-backups", "/tuckbox/" + crypto.randomUUID())).toThrow();
    expect(() => r2ObjectUrl("a".repeat(32), "private-backups", "tuckbox/invalid")).toThrow();
    expect(() => b2ObjectUrl("us-west-004", "bad/bucket")).toThrow();
  });
  test("rejects obsolete metadata prefixes", () => {
    expect(() => b2ObjectUrl("us-west-004", "private-backups", "meta/old.json")).toThrow();
  });

});
