import { useEffect, useState, type FormEvent } from "react";
import { Archive, ArrowDownToLine, CalendarClock, FileAudio, FileImage, FileText, FileType, FileVideo, HardDrive, Info, KeyRound, Link2Off, ShieldAlert, ExternalLink } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { Button, Card, Input } from "../components/ui";
import { jsonBody, requestJson, sizeText, type Share } from "../lib/api";
import { describeFileType } from "../features/files/file-info";
import { FileChecksums } from "../features/files/file-checksums";
import { ThemeSwitcher } from "../components/theme";
import { FilePreview } from "../features/files/file-preview";
import { isArchiveFile, previewFormat } from "../features/files/preview-types";

export default function SharePage() {
  const id = location.pathname.slice(1);
  const [file, setFile] = useState<Share | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);

  useEffect(() => {
    requestJson<Share>("/api/files/" + id).then(setFile)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  async function download() {
    if (downloadBusy) return;
    setDownloadBusy(true);
    setError("");
    try {
      const response = await fetch("/api/files/" + id + "/download", {
        method: "HEAD", credentials: "same-origin", cache: "no-store",
      });
      if (!response.ok) {
        if (response.status === 403) {
          setFile({ id, mode: "protected" });
          throw new Error("Access expired. Enter the access code again.");
        }
        // Do not reveal link availability in the public download error message.
        throw new Error("Server overloaded. Please try again.");
      }
      window.location.assign("/api/files/" + id + "/download");
    } catch (cause) {
      setError(cause instanceof Error && cause.message === "Access expired. Enter the access code again."
        ? cause.message : "Server overloaded. Please try again.");
    } finally {
      setDownloadBusy(false);
    }
  }

  async function unlock(event: FormEvent) {
    event.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError("");
    try {
      await requestJson("/api/files/" + id + "/unlock", { method: "POST", ...jsonBody({ code }) });
      const details = await requestJson<Share>("/api/files/" + id);
      if (details.filename === undefined || details.size === undefined) {
        throw new Error("Unable to unlock file details");
      }
      setFile(details);
      setCode("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const hasDetails = file?.filename !== undefined && file.size !== undefined;
  const format = hasDetails ? previewFormat(file.filename!, file.mime) : null;
  const FileIcon = format?.kind === "image" ? FileImage :
    format?.kind === "audio" ? FileAudio :
    format?.kind === "video" ? FileVideo :
    isArchiveFile(file?.filename ?? "", file?.mime) ? Archive : FileText;

  return <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-5 py-14">
    <div className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,.16),transparent_70%)]" />
    <div className="relative w-full max-w-lg">
      <div className="mb-9 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <img src="/tuckbox-mark.svg" width="40" height="40" className="size-10" alt="" aria-hidden="true" />
          <span className="text-xl font-semibold tracking-tight">TuckBox</span>
        </div>
        <ThemeSwitcher />
      </div>
      <Card className="p-6 sm:p-9">
        {loading ? <p className="text-center text-zinc-600 dark:text-zinc-400">Loading file…</p> : !file ?
          <div className="py-8 text-center">
            <Link2Off className="mx-auto mb-4 text-zinc-500" size={38} aria-hidden="true" />
            <h1 className="text-xl font-semibold">Link unavailable</h1>
            <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">{error || "File not found or expired"}</p>
          </div> :
          <>
            {hasDetails ?
              <>
                <h1 className="mt-2 flex items-start gap-2 break-all text-2xl font-semibold tracking-tight">
                  <FileIcon size={25} className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
                  {file.filename}
                </h1>
                <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-zinc-600 dark:text-zinc-400">
                  <span className="inline-flex items-center gap-1.5">
                    <HardDrive size={16} className="shrink-0" aria-hidden="true" />{sizeText(file.size!)}
                  </span>
                  <span className="inline-flex min-w-0 items-center gap-1.5 break-words">
                    <FileType size={16} className="shrink-0" aria-hidden="true" />{describeFileType(file.filename!, file.mime)}
                  </span>
                  <span className="inline-flex min-w-0 max-w-full items-start gap-1.5">
                    <CalendarClock size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                    {file.originalModifiedAt ?
                      <time className="min-w-0 whitespace-normal break-words" aria-label="Original modification date"
                        dateTime={file.originalModifiedAt}>
                        {new Date(file.originalModifiedAt).toLocaleString()}
                      </time> :
                      <span>Unavailable</span>}
                    <Popover.Root>
                      <Popover.Trigger aria-label="About the modification date"
                        className="shrink-0 rounded-md text-zinc-500 outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 dark:text-zinc-400">
                        <Info size={15} aria-hidden="true" />
                      </Popover.Trigger>
                      <Popover.Portal>
                        <Popover.Positioner sideOffset={8} className="z-50">
                          <Popover.Popup className="w-[min(18rem,calc(100vw-2rem))] whitespace-normal break-words rounded-xl border border-zinc-200 bg-white p-3 text-sm leading-5 text-zinc-800 shadow-xl outline-none dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-200">
                            <Popover.Title className="font-medium">Original modification date</Popover.Title>
                            <Popover.Description className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                              The date the file was last modified before upload, when available.
                            </Popover.Description>
                          </Popover.Popup>
                        </Popover.Positioner>
                      </Popover.Portal>
                    </Popover.Root>
                  </span>
                </div>
                <FilePreview key={[id, file.filename, file.size, file.checksums?.sha256].join(":")} id={id} file={file} />
                {file.checksums && file.virusTotal && <section className="mt-6 rounded-xl border border-zinc-200 p-4 dark:border-white/10"
                  aria-label="VirusTotal reputation">
                  <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <ShieldAlert size={17} aria-hidden="true" />VirusTotal
                  </h2>
                  {file.virusTotal?.status === "found" ?
                    <>
                      <p className="mt-2 text-sm">
                        {file.virusTotal.malicious ?? 0} malicious · {file.virusTotal.suspicious ?? 0} suspicious ·
                        {" "}{file.virusTotal.harmless ?? 0} harmless · {file.virusTotal.undetected ?? 0} undetected
                      </p>
                      {file.virusTotal.scanDate &&
                        <p className="mt-1 text-xs text-zinc-500">
                          Last analysis: {new Date(file.virusTotal.scanDate * 1000).toLocaleString()}
                        </p>}
                      <p className="mt-2 text-xs text-zinc-500">
                        No detections do not guarantee that a file is safe.
                      </p>
                    </> :
                    <p className="mt-2 text-sm text-zinc-500">
                      No cached reputation report is available yet.
                    </p>}
                  <a className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 underline
                    underline-offset-2 dark:text-emerald-300"
                    target="_blank" rel="noopener noreferrer"
                    href={"https://www.virustotal.com/gui/file/" + file.checksums.sha256 + "/detection"}>
                    View on VirusTotal <ExternalLink size={15} aria-hidden="true" />
                  </a>
                </section>}
                {file.checksums ? <FileChecksums checksums={file.checksums} filename={file.filename!} /> :
                  <section className="mt-6" aria-label="SHA-256">
                    <h2 className="mb-2 text-sm font-medium">SHA-256</h2>
                    <p className="text-sm text-zinc-500">SHA-256 is unavailable for this file.</p>
                  </section>}
                <div className="mt-8 border-t border-zinc-200 dark:border-white/10 pt-7">
                  <Button className="w-full" disabled={downloadBusy} onClick={() => void download()}>
                    <ArrowDownToLine size={17}/>{downloadBusy ? "Preparing download…" : "Download file"}
                  </Button>
                </div>
              </> :
              <form onSubmit={unlock} className="mt-2 space-y-4">
                <label htmlFor="access-code" className="flex items-center gap-2 text-sm font-medium">
                  <KeyRound size={16}/> Enter access code
                </label>
                <Input id="access-code" value={code} onChange={e => setCode(e.target.value)}
                  type="password" autoComplete="off" placeholder="Access code" maxLength={64} required
                  aria-invalid={!!error} aria-describedby={error ? "share-access-error" : undefined} />
                <Button type="submit" className="w-full" disabled={busy}>{busy ? "Verifying…" : "Unlock file"}</Button>
              </form>}
            {error && <p id="share-access-error" role="alert"
              className="mt-4 text-sm text-red-700 dark:text-red-300">{error}</p>}
          </>}
      </Card>
    </div>
  </main>;
}
