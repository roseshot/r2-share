import { describe, expect, test } from "bun:test";
import { awsS3ObjectUrl, b2ObjectUrl, r2ObjectUrl, parseListObjectsV2, xmlText } from "../worker/object-store";
import { dataKey } from "../worker/model";

describe("Backblaze B2 S3 compatibility", () => {
  test("parses paginated ListObjectsV2 without DOMParser", () => {
    const page = parseListObjectsV2(`<?xml version="1.0"?>
      <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
        <IsTruncated>true</IsTruncated>
        <Contents><Key>tuckbox/3d4071e7-a4b3-4c06-9801-61f4aca13052</Key><LastModified>2026-11-05T03:10:21.000Z</LastModified></Contents>
        <Contents><Key>tuckbox/a8c37123-1468-412a-8dca-b6724d9d3f21</Key><LastModified>2026-11-05T03:11:21.000Z</LastModified></Contents>
        <NextContinuationToken>page&amp;cursor</NextContinuationToken>
      </ListBucketResult>`);
    expect(page.truncated).toBe(true);
    expect(page.cursor).toBe("page&cursor");
    expect(page.objects.map(x => x.key)).toEqual(["tuckbox/3d4071e7-a4b3-4c06-9801-61f4aca13052", "tuckbox/a8c37123-1468-412a-8dca-b6724d9d3f21"]);
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
  test("rejects obsolete file key prefixes", () => {
    const key = "files/" + "A_-a".repeat(4);
    expect(() => b2ObjectUrl("us-west-004", "private-backups", key)).toThrow();
    expect(() => r2ObjectUrl("a".repeat(32), "private-backups", key)).toThrow();
  });
  test("constructs only AWS commercial S3 endpoints without a region allowlist", () => {
    const key = dataKey("a8c37123-1468-412a-8dca-b6724d9d3f21");
    expect(awsS3ObjectUrl("us-east-1", "private-aws-bucket", key))
      .toBe("https://s3.us-east-1.amazonaws.com/private-aws-bucket/" + key);
    expect(awsS3ObjectUrl("ap-southeast-2", "private-aws-bucket"))
      .toBe("https://s3.ap-southeast-2.amazonaws.com/private-aws-bucket");
    expect(awsS3ObjectUrl("future-east-8", "private-aws-bucket", key))
      .toBe("https://s3.future-east-8.amazonaws.com/private-aws-bucket/" + key);
    expect(awsS3ObjectUrl("cn-north-1", "private-aws-bucket", key))
      .not.toContain(".amazonaws.com.cn");
    for (const region of ["", "us-east-1@evil.example.com", "us-east-1/abc",
      "us-east-1?x=1", "https://evil.example.com"]) {
      expect(() => awsS3ObjectUrl(region, "private-aws-bucket", key)).toThrow();
    }
    expect(() => awsS3ObjectUrl("us-east-1", "bad/bucket", key)).toThrow();
    expect(() => awsS3ObjectUrl("us-east-1", "private-aws-bucket", "../admin")).toThrow();
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
