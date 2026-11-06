import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = (file: string) => readFileSync(new URL("../" + file, import.meta.url), "utf8");

describe("upload completion experience", () => {
  test("provides a persistent, copyable link and access code after upload", () => {
    const admin = source("src/admin.tsx");
    expect(admin).toContain("setUploadResult({");
    expect(admin).toContain('aria-label="Upload result"');
    expect(admin).toContain("Copy link");
    expect(admin).toContain("Copy access code");
    expect(admin).toContain("Open link");
  });
  test("shows processing state without suggesting a completed upload", () => {
    const admin = source("src/admin.tsx");
    expect(admin).toContain("xhr.upload.onprogress");
    expect(admin).toContain("setProcessing(true)");
    expect(admin).toContain("Processing file…");
  });
  test("guides first-time users to the storage settings form", () => {
    const admin = source("src/admin.tsx");
    const settings = source("src/admin-settings.tsx");
    expect(admin).toContain("Configure storage");
    expect(admin).toContain("scrollIntoView");
    expect(settings).toContain('id="object-storage-settings"');
    expect(settings).toContain("aria-label={label}");
  });
});
