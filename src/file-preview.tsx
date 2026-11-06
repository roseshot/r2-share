import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Eye, File, FileArchive, Folder, LoaderCircle } from "lucide-react";
import { Button } from "./ui";
import { readArchiveDirectory, type ArchiveDirectory } from "./archive";
import { previewFormat } from "./preview-types";
import { sizeText, type Share } from "./lib";

export function FilePreview({ file, id }: { file: Share; id: string }) {
  const format = previewFormat(file.filename ?? "", file.mime);
  const isArchive = format?.kind === "zip" || format?.kind === "tar" || format?.kind === "tgz";
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [contents, setContents] = useState<ArchiveDirectory | null>(null);
  const previewURL = "/api/files/" + id + "/preview";

  useEffect(() => {
    setOpened(isArchive);
    setText(null);
    setContents(null);
    setError("");
  }, [id, file.filename, isArchive]);

  useEffect(() => {
    if (!opened || !format || (!isArchive && format.kind !== "text")) return;
    const controller = new AbortController();
    async function load() {
      setBusy(true);
      setError("");
      try {
        if (isArchive) {
          const response = await fetch("/api/files/" + id + "/download", {
            credentials: "same-origin", cache: "no-store", signal: controller.signal,
          });
          if (!response.ok) throw new Error("Archive contents could not be loaded");
          const list = await readArchiveDirectory(await response.blob(), format!.kind);
          if (!controller.signal.aborted) setContents(list);
        } else {
          if ((file.size ?? 0) > 1024 * 1024) {
            throw new Error("Text preview is limited to 1 MiB. Download the full file instead.");
          }
          const response = await fetch(previewURL, {
            credentials: "same-origin", cache: "no-store", signal: controller.signal,
          });
          if (!response.ok) throw new Error("Text preview could not be loaded");
          const content = await response.text();
          if (!controller.signal.aborted) setText(content.slice(0, 200000));
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Preview unavailable");
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [opened, format?.kind, file.size, id, isArchive, previewURL]);

  if (!format) return null;

  return <section className="mt-6 border-t border-zinc-200 pt-5 dark:border-white/10" aria-label="File preview">
    <div className="flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        {isArchive ? <FileArchive size={17} className="text-emerald-700 dark:text-emerald-300" aria-hidden="true" /> :
          <Eye size={17} className="text-emerald-700 dark:text-emerald-300" aria-hidden="true" />}
        {isArchive ? "Archive contents" : "File preview"}
      </h2>
      <Button size="sm" variant="ghost" onClick={() => setOpened(value => !value)}
        aria-expanded={opened} aria-controls="preview-details">
        {opened ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        {opened ? "Hide" : "Preview"}
      </Button>
    </div>
    {opened && <div id="preview-details" className="mt-4">
      {busy && <p role="status" className="flex items-center gap-2 text-sm text-zinc-500">
        <LoaderCircle size={16} className="animate-spin" />Loading preview…
      </p>}
      {error && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{error}</p>}
      {isArchive && contents && !busy && <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-white/10">
        <div className="border-b border-zinc-200 bg-zinc-100/70 px-3 py-2 text-xs text-zinc-600 dark:border-white/10 dark:bg-zinc-950/60 dark:text-zinc-400">
          {contents.total} {contents.total === 1 ? "entry" : "entries"}
          {contents.truncated && " · First 200 shown"}
        </div>
        <ul className="max-h-72 divide-y divide-zinc-200 overflow-y-auto dark:divide-white/10">
          {contents.entries.map((entry, index) => <li key={index} className="flex items-start justify-between gap-4 px-3 py-2 text-xs">
            <span className="flex min-w-0 items-start gap-2">
              {entry.directory ? <Folder size={15} className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden="true" /> :
                <File size={15} className="mt-0.5 shrink-0 text-zinc-500" aria-hidden="true" />}
              <span className="break-all">{entry.name}</span>
            </span>
            {!entry.directory && <span className="shrink-0 text-zinc-500">{sizeText(entry.size)}</span>}
          </li>)}
        </ul>
        {!contents.total && <p className="px-3 py-4 text-sm text-zinc-500">The archive contains no files.</p>}
      </div>}
      {!isArchive && format.kind === "text" && text !== null && !busy &&
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-zinc-200 bg-zinc-100 p-4 font-mono text-xs leading-6 text-zinc-800 dark:border-white/10 dark:bg-zinc-950/60 dark:text-zinc-200">
          {text || "Empty file"}{text.length === 200000 ? "\n\n[Preview truncated]" : ""}
        </pre>}
      {!isArchive && format.kind === "image" &&
        <img src={previewURL} alt={"Preview of " + file.filename} loading="lazy"
          className="mx-auto max-h-96 max-w-full rounded-xl border border-zinc-200 object-contain dark:border-white/10" />}
      {!isArchive && format.kind === "pdf" &&
        <iframe title={"Preview of " + file.filename} src={previewURL}
          sandbox="allow-scripts allow-downloads"
          className="h-96 w-full rounded-xl border border-zinc-200 bg-white dark:border-white/10" />}
      {!isArchive && format.kind === "audio" &&
        <audio src={previewURL} controls preload="metadata" className="w-full" aria-label="Audio preview" />}
      {!isArchive && format.kind === "video" &&
        <video src={previewURL} controls preload="metadata"
          className="max-h-96 w-full rounded-xl bg-black" aria-label="Video preview" />}
    </div>}
  </section>;
}
