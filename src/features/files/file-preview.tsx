import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Eye, LoaderCircle } from "lucide-react";
import { Button } from "../../components/ui";
import { previewFormat } from "./preview-types";
import type { Share } from "../../lib/api";

export function FilePreview({ file, id, disabled = false }: { file: Share; id: string; disabled?: boolean }) {
  const format = previewFormat(file.filename ?? "", file.mime);
  const [opened, setOpened] = useState(false);
  const [activated, setActivated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewURL = "/api/files/" + id + "/preview";

  // A successful text preview is cached for the life of this file view.
  // Hiding the preview does not cancel a pending request or clear its result.
  useEffect(() => {
    if (!activated || format?.kind !== "text" || text !== null || error) return;
    const controller = new AbortController();

    async function load() {
      setBusy(true);
      setError("");
      try {
        if ((file.size ?? 0) > 1024 * 1024) {
          throw new Error("Text preview is limited to 1 MiB. Download the full file instead.");
        }
        const response = await fetch(previewURL, {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw new Error("Text preview could not be loaded");
        const content = await response.text();
        if (!controller.signal.aborted) setText(content.slice(0, 200000));
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
  }, [activated, format?.kind, file.size, previewURL, text, error]);

  function togglePreview() {
    if (disabled) return;
    if (opened) {
      audioRef.current?.pause();
      videoRef.current?.pause();
    } else {
      // Allow another attempt after a failed preview; keep successful content.
      if (error) setError("");
      setActivated(true);
    }
    setOpened(value => !value);
  }

  if (!format) return null;

  return <section className="mt-6 border-t border-zinc-200 pt-5 dark:border-white/10" aria-label="File preview">
    <div className="flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <Eye size={17} className="text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
        File preview
      </h2>
      <Button size="sm" variant="ghost" onClick={togglePreview} disabled={disabled}
        aria-expanded={opened} aria-controls="preview-details">
        {opened ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        {opened ? "Hide" : "Preview"}
      </Button>
    </div>
    {activated && <div id="preview-details" hidden={!opened} className="mt-4">
      {busy && <p role="status" className="flex items-center gap-2 text-sm text-zinc-500">
        <LoaderCircle size={16} className="animate-spin" />Loading preview…
      </p>}
      {error && <div role="alert" className="space-y-2 text-sm text-amber-700 dark:text-amber-300">
        <p>{error} Download the file instead.</p>
        <a className="inline-flex h-9 items-center rounded-xl border border-amber-400/30 px-3 text-sm font-medium"
          href={"/api/files/" + id + "/download"}>Download file</a>
      </div>}
      {format.kind === "text" && text !== null && !busy &&
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-zinc-200 bg-zinc-100 p-4 font-mono text-xs leading-6 text-zinc-800 dark:border-white/10 dark:bg-zinc-950/60 dark:text-zinc-200">
          {text || "Empty file"}{text.length === 200000 ? "\n\n[Preview truncated]" : ""}
        </pre>}
      {!error && format.kind === "image" &&
        <img src={previewURL} alt={"Preview of " + file.filename} loading="lazy"
          onError={() => setError("Preview unavailable.")}
          className="mx-auto max-h-96 max-w-full rounded-xl border border-zinc-200 object-contain dark:border-white/10" />}
      {!error && format.kind === "pdf" &&
        <iframe title={"Preview of " + file.filename} src={previewURL}
          onError={() => setError("Preview unavailable.")}
          sandbox="allow-scripts allow-downloads"
          className="h-96 w-full rounded-xl border border-zinc-200 bg-white dark:border-white/10" />}
      {!error && format.kind === "audio" &&
        <audio ref={audioRef} src={previewURL} controls preload="metadata" className="w-full" aria-label="Audio preview"
          onError={() => setError("Preview unavailable.")} />}
      {!error && format.kind === "video" &&
        <video ref={videoRef} src={previewURL} controls preload="metadata" onError={() => setError("Preview unavailable.")}
          className="max-h-96 w-full rounded-xl bg-black" aria-label="Video preview" />}
    </div>}
  </section>;
}
