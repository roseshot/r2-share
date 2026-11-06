import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verificationInstructions } from "../src/file-checksums";

const abcDigest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("checksum display and platform instructions", () => {
  test("keeps the SHA-256 checksum copy button", () => {
    const source = readFileSync(new URL("../src/file-checksums.tsx", import.meta.url), "utf8");
    expect(source).toContain("navigator.clipboard.writeText(value)");
    expect(source).toContain('"Copy " + label + " checksum"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("How to verify SHA-256");
  });

  test("keeps the command instructions collapsed by default", () => {
    const source = readFileSync(new URL("../src/file-checksums.tsx", import.meta.url), "utf8");
    expect(source).toContain("<details className=");
    expect(source).not.toMatch(/<details[^>]+\sopen=/);
  });

  test("generates filename-specific SHA-256 calculation commands for all platforms", () => {
    const commands = verificationInstructions("report 2026.pdf");
    expect(commands.map(item => item.platform)).toEqual([
      "macOS", "GNU/Linux", "Windows (PowerShell 5.1 / 7)",
    ]);
    expect(commands[0].sha256).toBe("shasum -a 256 './report 2026.pdf'");
    expect(commands[1].sha256).toBe("sha256sum -- './report 2026.pdf'");
    expect(commands[2].sha256).toBe(
      "Get-FileHash -LiteralPath '.\\report 2026.pdf' -Algorithm SHA256 | Select-Object -ExpandProperty Hash",
    );
    for (const { sha256 } of commands) {
      expect(sha256).not.toContain(abcDigest);
      expect(sha256).not.toContain("MATCH");
      expect(sha256).not.toContain("MISMATCH");
      expect(sha256).not.toContain("FILE ERROR");
      expect(sha256).not.toContain("expected=");
      expect(sha256).not.toContain("\n");
    }
  });

  test("safely escapes filenames with spaces and shell metacharacters", () => {
    const commands = verificationInstructions("owner's $file; name.txt");
    expect(commands[0].sha256).toContain("shasum -a 256 './owner'\\''s $file; name.txt'");
    expect(commands[1].sha256).toContain("sha256sum -- './owner'\\''s $file; name.txt'");
    expect(commands[2].sha256).toContain("'.\\owner''s $file; name.txt'");
    const source = readFileSync(new URL("../src/file-checksums.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("python3");
    expect(source).not.toContain("py -3");
    expect(source).toContain("verificationInstructions(filename)");
  });

  test("GNU/Linux command computes actual SHA-256 without executing filenames", () => {
    const folder = mkdtempSync(join(tmpdir(), "tuckbox-sha256-"));
    const filename = "owner's $(touch injected); \\name.txt";
    try {
      writeFileSync(join(folder, filename), "abc");
      const command = verificationInstructions(filename)[1].sha256;
      const result = spawnSync("sh", ["-c", command], { cwd: folder, encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(abcDigest);
      expect(result.stdout).not.toContain("MATCH");
      expect(existsSync(join(folder, "injected"))).toBe(false);
      const missing = spawnSync("sh", ["-c", verificationInstructions("missing.txt")[1].sha256], {
        cwd: folder, encoding: "utf8",
      });
      expect(missing.status).not.toBe(0);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("preserves copy buttons and soft wraps long SHA-256 commands", () => {
    const source = readFileSync(new URL("../src/file-checksums.tsx", import.meta.url), "utf8");
    expect(source).toContain('aria-label={"Copy " + platform + " SHA-256 command"}');
    expect(source).toContain('onClick={() => void copy(sha256, platform + " SHA-256 command")}');
    expect(source).toContain("whitespace-pre-wrap");
    expect(source).toContain("break-all");
    expect(source).toContain("font-mono");
  });

  test("uses contextual file icons and keeps the modified timestamp on one line", () => {
    const source = readFileSync(new URL("../src/share.tsx", import.meta.url), "utf8");
    expect(source).toContain("const FileIcon =");
    for (const icon of ["FileImage", "FileAudio", "FileVideo", "Archive", "Link2Off", "CalendarClock"]) {
      expect(source).toContain(icon);
    }
    expect(source).toContain('aria-label="Original modification date"');
    expect(source).toContain("whitespace-nowrap");
    expect(source).toContain("overflow-x-auto");
    expect(source).toContain("<HardDrive size={16}");
    expect(source).not.toContain("HardDriveDownload");
    const fileTypePosition = source.indexOf("<FileType size={16}");
    const modifiedPosition = source.indexOf("<CalendarClock size={16}");
    expect(fileTypePosition).toBeGreaterThan(0);
    expect(modifiedPosition).toBeGreaterThan(fileTypePosition);
    expect(source).toContain("<span>Modified:</span>");
    expect(source).not.toContain('<section className="mt-6" aria-label="Original modification date">');
    expect(source).toContain("file.originalModifiedAt");
    expect(source).not.toContain("CalendarPlus");
    expect(source).not.toContain(">Created");
    expect(source).not.toContain("original creation date");
  });

  test("uses the SHA-256 icon without altering copy behavior", () => {
    const source = readFileSync(new URL("../src/file-checksums.tsx", import.meta.url), "utf8");
    expect(source).toContain("<Fingerprint size={15}");
    expect(source).toContain("<ShieldCheck size={17}");
    expect(source).toContain('onClick={() => void copy(checksums[key], label)}');
  });

  test("removes the Windows version-support sentence from the instructions", () => {
    const source = readFileSync(new URL("../src/file-checksums.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("Windows PowerShell 5.1 and PowerShell 7 are supported.");
    expect(source).toContain("Windows (PowerShell 5.1 / 7)");
  });

  test("single click and keyboard focus select the full command", () => {
    const source = readFileSync(new URL("../src/file-checksums.tsx", import.meta.url), "utf8");
    expect(source).toContain("selectCommandText(element: HTMLElement)");
    expect(source).toContain("range.selectNodeContents(element)");
    expect(source).toContain("selection.removeAllRanges()");
    expect(source).toContain("selection.addRange(range)");
    expect(source).toContain("onClick={event => selectCommandText(event.currentTarget)}");
    expect(source).toContain("onFocus={event => selectCommandText(event.currentTarget)}");
    expect(source).toContain("tabIndex={0}");
    expect(source).toContain("select-all");
    expect(source).toContain('title="Click to select the entire command"');
  });

  test("includes platform icons for macOS, Linux and Windows", () => {
    const source = readFileSync(new URL("../src/file-checksums.tsx", import.meta.url), "utf8");
    expect(source).toContain("Apple");
    expect(source).toContain("Terminal");
    expect(source).toContain("PanelsTopLeft");
    expect(source).toContain("<PlatformIcon");
    expect(source).toContain('platform === "macOS"');
    expect(source).toContain('platform === "GNU/Linux"');
  });

  test("loads JetBrains Mono for checksum values and terminal commands", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    const source = readFileSync(new URL("../src/file-checksums.tsx", import.meta.url), "utf8");
    expect(html).toContain("fonts.googleapis.com/css2?family=JetBrains+Mono");
    expect(html).toContain("display=swap");
    expect(html).toContain("fonts.gstatic.com");
    expect(css).toContain('--font-mono: "JetBrains Mono"');
    expect(source).toContain("font-mono");
    expect(source).toContain('{checksums[key]}');
    expect(source).toContain('{sha256}');
  });

  test("uses sans-serif for interface text and monospace for code", () => {
    const styles = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    expect(styles).toContain('--font-sans: "Inter", "SF Pro Display"');
    const code = readFileSync(new URL("../src/file-checksums.tsx", import.meta.url), "utf8");
    expect(code).toContain("font-mono");
  });
});
