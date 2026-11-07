import { describe, expect, test } from "bun:test";
import { resolveSharePath, routeForPath } from "../src/routes";

describe("public and private page routing", () => {
  test("serves the public homepage at the root", () => {
    expect(routeForPath("/")).toBe("home");
  });

  test("accepts admin path segments of any nonzero length", () => {
    expect(routeForPath("/a")).toBe("admin");
    expect(routeForPath("/" + "a".repeat(512))).toBe("admin");
    expect(routeForPath("/a-b_1")).toBe("admin");
  });

  test("uses the root-level 16-character share route", () => {
    const id = "Kq8mH2_nP4xY7zQb";
    expect(routeForPath("/" + id)).toBe("share");
    expect(routeForPath("/" + id, true)).toBe("admin");
    expect(routeForPath("/f/" + id)).toBe("not-found");
    expect(routeForPath("/f/no-file")).toBe("not-found");
    expect(routeForPath("/" + "a".repeat(32))).toBe("admin");
    expect(routeForPath("/abc/api/login")).toBe("not-found");
  });

  test("routes a public uploader separately from admin and download links", () => {
    expect(routeForPath("/upload/ABCDEFGHIJKLMNOP")).toBe("public-upload");
    expect(routeForPath("/upload/not-an-id")).toBe("not-found");
    expect(routeForPath("/upload/ABCDEFGHIJKLMNOP/files")).toBe("not-found");
  });

  test("accepts only same-origin root-level share links or bare IDs", () => {
    const id = "Kq8mH2_nP4xY7zQb";
    const origin = "https://files.example.com";
    expect(resolveSharePath(id, origin)).toBe("/" + id);
    expect(resolveSharePath(origin + "/" + id, origin)).toBe("/" + id);
    expect(resolveSharePath("/" + id, origin)).toBe("/" + id);
    expect(resolveSharePath("https://other.example/" + id, origin)).toBeNull();
    expect(resolveSharePath("/f/" + id, origin)).toBeNull();
    expect(resolveSharePath(origin + "/f/" + id, origin)).toBeNull();
    expect(resolveSharePath("/admin", origin)).toBeNull();
    expect(resolveSharePath("", origin)).toBeNull();
    expect(resolveSharePath("a".repeat(32), origin)).toBeNull();
  });
});
