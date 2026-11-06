import { useEffect, useState, type FormEvent } from "react";
import { Archive, ArrowDownToLine, CalendarClock, FileAudio, FileImage, FileText, FileType, FileVideo, HardDrive, KeyRound, Link2Off } from "lucide-react";
import { Button, Card, Input } from "./ui";
import { jsonBody, requestJson, sizeText, type Share } from "./lib";
import { describeFileType } from "./file-info";
import { FileChecksums } from "./file-checksums";
import { ThemeSwitcher } from "./theme";
import { FilePreview } from "./file-preview";
import { previewFormat } from "./preview-types";

export default function SharePage() {
  const id = location.pathname.slice(1);
  const [file, setFile] = useState<Share | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    requestJson<Share>("/api/files/" + id).then(setFile)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  function download() {
    window.location.assign("/api/files/" + id + "/download");
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
    format?.kind === "zip" || format?.kind === "tar" || format?.kind === "tgz" ?
      Archive : FileText;

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
                <div className="mt-4 flex items-center gap-5 overflow-x-auto whitespace-nowrap text-sm text-zinc-600 dark:text-zinc-400">
                  <span className="inline-flex shrink-0 items-center gap-1.5">
                    <HardDrive size={16} aria-hidden="true" />{sizeText(file.size!)}
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1.5">
                    <FileType size={16} aria-hidden="true" />{describeFileType(file.filename!, file.mime)}
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1.5" aria-label="Original modification date">
                    <CalendarClock size={16} aria-hidden="true" />
                    <span>Modified:</span>
                    {file.originalModifiedAt ?
                      <time dateTime={file.originalModifiedAt} title={file.originalModifiedAt}>
                        {new Date(file.originalModifiedAt).toLocaleString()}
                      </time> :
                      <span>Unavailable</span>}
                  </span>
                </div>
                <FilePreview id={id} file={file} />
                {file.checksums ? <FileChecksums checksums={file.checksums} filename={file.filename!} /> :
                  <section className="mt-6" aria-label="File checksums">
                    <h2 className="mb-2 text-sm font-medium">File checksums</h2>
                    <p className="text-sm text-zinc-500">Checksums are unavailable for this file.</p>
                  </section>}
                <div className="mt-8 border-t border-zinc-200 dark:border-white/10 pt-7">
                  <Button className="w-full" onClick={download}><ArrowDownToLine size={17}/>Download file</Button>
                </div>
              </> :
              <form onSubmit={unlock} className="mt-2 space-y-4">
                <label htmlFor="access-code" className="flex items-center gap-2 text-sm font-medium">
                  <KeyRound size={16}/> Enter access code
                </label>
                <Input id="access-code" value={code} onChange={e => setCode(e.target.value)}
                  type="password" autoComplete="off" placeholder="Access code" maxLength={64} required/>
                <Button type="submit" className="w-full" disabled={busy}>{busy ? "Verifying…" : "Unlock file"}</Button>
              </form>}
            {error && <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-300">{error}</p>}
          </>}
      </Card>
    </div>
  </main>;
}
