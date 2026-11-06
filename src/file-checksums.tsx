import { useState } from "react";
import { Apple, Check, ChevronDown, ClipboardCopy, Hash, PanelsTopLeft, Terminal } from "lucide-react";
import { Button } from "./ui";
import type { FileChecksums } from "./lib";

/** Single-quoted paths prevent filenames from running shell commands. */
export function quotePosixPath(path: string): string {
  return "'" + path.replaceAll("'", "'\\''") + "'";
}

/** PowerShell single-quoted literal strings use doubled apostrophes. */
export function quotePowerShellPath(path: string): string {
  return "'" + path.replaceAll("'", "''") + "'";
}

export function verificationInstructions(filename: string) {
  const posixPath = quotePosixPath("./" + filename);
  const powershellPath = quotePowerShellPath(".\\" + filename);
  return [
    { platform: "macOS", sha256: "shasum -a 256 " + posixPath },
    { platform: "GNU/Linux", sha256: "sha256sum -- " + posixPath },
    {
      platform: "Windows (PowerShell 5.1 / 7)",
      sha256: "Get-FileHash -LiteralPath " + powershellPath +
        " -Algorithm SHA256 | Select-Object -ExpandProperty Hash",
    },
  ] as const;
}

/** Select the entire command on a single click, including on mobile browsers. */
export function selectCommandText(element: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function FileChecksums({ checksums, filename }: { checksums: FileChecksums; filename: string }) {
  const [message, setMessage] = useState("");

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(label + " copied");
    } catch {
      setMessage("Could not copy. Select the text to copy it manually.");
    }
  }

  return <section className="mt-6" aria-label="SHA-256">
    <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
      <Hash size={17} className="text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
      SHA-256
    </h2>
    <div className="flex items-center gap-1.5 rounded-lg bg-zinc-100 p-1.5 pl-2.5 text-xs leading-5 text-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-300">
      <code className="min-w-0 flex-1 break-all font-mono select-all">{checksums.sha256}</code>
      <Button size="icon" variant="ghost" className="shrink-0"
        aria-label="Copy SHA-256 checksum" title="Copy SHA-256"
        onClick={() => void copy(checksums.sha256, "SHA-256")}>
        {message === "SHA-256 copied" ? <Check size={16} aria-hidden="true" /> :
          <ClipboardCopy size={16} aria-hidden="true" />}
      </Button>
    </div>
    <p className="mt-2 min-h-4 text-xs text-zinc-500" role="status" aria-live="polite">{message}</p>
    <details className="group mt-3 rounded-xl border border-zinc-200 dark:border-white/10">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2"><Terminal size={16} aria-hidden="true" />How to verify SHA-256</span>
        <ChevronDown size={16} aria-hidden="true" className="text-zinc-500 transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-5 border-t border-zinc-200 px-3 py-4 dark:border-white/10">
        <p className="text-xs leading-5 text-zinc-600 dark:text-zinc-400">
          Run the command in the folder containing the downloaded file.
          It prints the calculated SHA-256 for you to compare with the value above.
        </p>
        {verificationInstructions(filename).map(({ platform, sha256 }) => {
          const PlatformIcon = platform === "macOS" ? Apple :
            platform === "GNU/Linux" ? Terminal : PanelsTopLeft;
          return <div key={platform} className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <PlatformIcon size={17} className="shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
              {platform}
            </h3>
            <p className="font-mono text-xs text-zinc-500">SHA-256</p>
            <div className="flex items-center gap-1.5 rounded-lg bg-zinc-100 p-1.5 dark:bg-zinc-950/70">
              <pre tabIndex={0} title="Click to select the entire command"
                aria-label={platform + " SHA-256 command. Click to select all text."}
                onClick={event => selectCommandText(event.currentTarget)}
                onFocus={event => selectCommandText(event.currentTarget)}
                className="min-w-0 flex-1 cursor-text select-all whitespace-pre-wrap break-all p-1 font-mono text-xs leading-5 text-zinc-800 outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 dark:text-zinc-200"><code>{sha256}</code></pre>
              <Button size="icon" variant="ghost" className="shrink-0"
                aria-label={"Copy " + platform + " SHA-256 command"}
                title={"Copy " + platform + " command"}
                onClick={() => void copy(sha256, platform + " SHA-256 command")}>
                {message === platform + " SHA-256 command copied" ?
                  <Check size={16} aria-hidden="true" /> :
                  <ClipboardCopy size={16} aria-hidden="true" />}
              </Button>
            </div>
          </div>;
        })}
      </div>
    </details>
  </section>;
}
