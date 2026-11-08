import { describe, expect, test } from "bun:test";
import { resolveSharePath, routeForPath } from "../src/routes";

describe("public and private page routing", () => {
  test("serves the public homepage at the root", () => {
    expect(routeForPath("/")).toBe("home");
  });

  test("probes whether a single-segment URL is the private admin path", () => {
    for (const path of ["/a", "/" + "a".repeat(512), "/a-b_1"]) {
      expect(routeForPath(path)).toBe("share");
      expect(routeForPath(path, true)).toBe("admin");
    }
  });

  test("uses root-level share routes for generated IDs", () => {
    const id = "Kq8mH2_n";
    expect(routeForPath("/" + id)).toBe("share");
    expect(routeForPath("/" + id, true)).toBe("admin");
    expect(routeForPath("/f/" + id)).toBe("not-found");
    expect(routeForPath("/f/no-file")).toBe("not-found");
    expect(routeForPath("/" + "a".repeat(32))).toBe("share");
    expect(routeForPath("/abc/api/login")).toBe("not-found");
  });

  test("shows a branded share error for malformed or unknown single-segment IDs", () => {
    expect(routeForPath("/not-a-valid-id")).toBe("share");
    expect(routeForPath("/unknown")).toBe("share");
    expect(routeForPath("/abcdefghijklmnop")).toBe("share"); // Unavailable legacy link.
    expect(routeForPath("/invalid/extra")).toBe("not-found");
  });

  test("routes a public uploader separately from admin and download links", () => {
    expect(routeForPath("/u/ABCDEFGHIJKLMNOP")).toBe("public-upload");
    expect(routeForPath("/u/AbC123xy")).toBe("not-found");
    expect(routeForPath("/u/ABCdef123")).toBe("not-found");
    expect(routeForPath("/u/ABCdef1234")).toBe("not-found");
    expect(routeForPath("/u/not-an-id-invalid")).toBe("not-found");
    expect(routeForPath("/u/ABCDEFGHIJKLMNOP/files")).toBe("not-found");
    expect(routeForPath("/upload/ABCDEFGHIJKLMNOP")).toBe("not-found");
  });

  test("accepts only same-origin root-level share links or bare IDs", () => {
    const id = "Kq8mH2_n";
    const origin = "https://files.example.com";
    expect(resolveSharePath(id, origin)).toBe("/" + id);
    expect(resolveSharePath(origin + "/" + id, origin)).toBe("/" + id);
    expect(resolveSharePath("/" + id, origin)).toBe("/" + id);
    expect(resolveSharePath("https://other.example/" + id, origin)).toBeNull();
    expect(resolveSharePath("/f/" + id, origin)).toBeNull();
    expect(resolveSharePath(origin + "/f/" + id, origin)).toBeNull();
    expect(resolveSharePath("/admin", origin)).toBeNull();
    expect(resolveSharePath("", origin)).toBeNull();
    for (const length of [8, 9, 10, 11, 12]) {
      const missingId = "A".repeat(length);
      expect(resolveSharePath(missingId, origin)).toBe("/" + missingId);
      expect(resolveSharePath(origin + "/" + missingId, origin)).toBe("/" + missingId);
    }
    for (const length of [1, 7, 13, 16, 32]) {
      const invalid = "A".repeat(length);
      expect(resolveSharePath(invalid, origin)).toBeNull();
      expect(resolveSharePath(origin + "/" + invalid, origin)).toBeNull();
    }
  });
});
