import { describe, expect, test } from "bun:test";
import { describeFileType, checksumAlgorithms, originalModificationDate } from "../src/file-info";
import { readThemePreference, resolveTheme } from "../src/theme";

describe("file checksums and known formats", () => {
  test("displays only SHA-256 checksums", () => {
    expect(checksumAlgorithms.map(item => item.label)).toEqual(["SHA-256"]);
  });

  test("preserves available original file modification time without inventing creation time", () => {
    const original = Date.UTC(2022, 5, 15, 12, 30, 10);
    expect(originalModificationDate(original)).toBe("2022-06-15T12:30:10.000Z");
    expect(originalModificationDate(undefined)).toBeUndefined();
    expect(originalModificationDate(0)).toBeUndefined();
    expect(originalModificationDate(Number.NaN)).toBeUndefined();
    expect(originalModificationDate(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(originalModificationDate(8640000000000001)).toBeUndefined();
  });

  test("recognizes file types, including MIME fallback and unknown types", () => {
    expect(describeFileType("report.PDF", "application/octet-stream")).toBe("PDF document");
    expect(describeFileType("photo.jpeg")).toBe("JPEG image");
    expect(describeFileType("audio.mp3")).toBe("MP3 audio");
    expect(describeFileType("unknown.bin", "application/json")).toBe("JSON document");
    expect(describeFileType("unknown.xyz", "application/x-unknown")).toBe("Unknown file type");
  });
});

describe("appearance settings", () => {
  test("defaults to system but honors explicit light and dark preferences", () => {
    expect(readThemePreference(null)).toBe("system");
    expect(readThemePreference("invalid")).toBe("system");
    expect(readThemePreference("light")).toBe("light");
    expect(readThemePreference("dark")).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
