import { useEffect, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import { CircleCheckBig, FileUp, FolderOpen, LoaderCircle, X } from "lucide-react";
import { Button, Card } from "./ui";
import { ThemeSwitcher } from "./theme";
import { appendUploads, droppedFiles, selectedFiles, type UploadEntry } from "./upload-queue";
import { archiveFolders } from "./folder-zip";
import { clipboardUploads, pasteIsEditing } from "./paste-upload";
import { jsonBody, requestJson, sizeText } from "./lib";

type PageInfo = {
  label: string; active: boolean; expired: boolean; expiresAt: string | null;
  remaining: number | null; maxUploads: number | null; completedUploads: number;
};
const pageId = location.pathname.split("/")[2];
const endpoint = "/api/public-uploads/" + pageId;

export default function PublicUploadPage() {
  const [page, setPage] = useState<PageInfo | null>(null);
  const [selected, setSelected] = useState<UploadEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [current, setCurrent] = useState("");
  const [progress, setProgress] = useState(0);
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [error, setError] = useState("");

  async function refreshPage() {
    const info = await requestJson<PageInfo>(endpoint);
    setPage(info);
    return info;
  }

  useEffect(() => {
    void refreshPage().catch(reason => setError(reason instanceof Error ? reason.message : "Link unavailable"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!page?.active || uploading || preparing) return;
    function paste(event: ClipboardEvent) {
      if (!event.clipboardData || pasteIsEditing(event.target)) return;
      const incoming = clipboardUploads(event.clipboardData);
      if (!incoming.length) return;
      event.preventDefault();
      setSelected(previous => {
        const result = appendUploads(previous, incoming);
        if (result.rejected.length) setError(result.rejected[0].reason);
        return result.files;
      });
    }
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [page?.active, uploading, preparing]);

  function addQueue(entries: UploadEntry[]) {
    setSelected(previous => {
      const result = appendUploads(previous, entries);
      if (result.rejected.length) setError(result.rejected[0].reason);
      else setError("");
      return result.files;
    });
  }

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const folder = event.currentTarget.id === "public-folder";
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!files.length || uploading || preparing) return;
    setPreparing(true);
    try { addQueue(folder ? await archiveFolders(selectedFiles(files)) : selectedFiles(files)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setPreparing(false); }
  }

  async function drop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (uploading || preparing || !page?.active) return;
    setPreparing(true);
    try { addQueue(await archiveFolders(await droppedFiles(event.dataTransfer))); }
    catch (cause) { setError((cause as Error).message); }
    finally { setPreparing(false); }
  }

  async function sendFile(entry: UploadEntry) {
    const session = await requestJson<{ id: string; token: string }>(endpoint + "/files", {
      method: "POST", ...jsonBody({
        filename: entry.filename, size: entry.file.size,
        mime: entry.file.type || "application/octet-stream",
      }),
    });
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", endpoint + "/files/" + session.id);
      xhr.withCredentials = true;
      xhr.setRequestHeader("X-Upload-Token", session.token);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100));
      };
      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.onabort = () => reject(new Error("Upload canceled"));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
        try {
          const message = (JSON.parse(xhr.responseText) as { error?: string }).error;
          reject(new Error(message || "Upload failed"));
        } catch (reason) {
          reject(reason instanceof SyntaxError ? new Error("Upload failed") : reason);
        }
      };
      xhr.send(entry.file);
    });
  }

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!page?.active || uploading || preparing || !selected.length) return;
    setUploading(true); setError("");
    const rest = [...selected];
    try {
      for (const entry of [...selected]) {
        const info = await refreshPage();
        if (!info.active) throw new Error("This upload link has expired or reached its limit");
        setCurrent(entry.filename); setProgress(0);
        await sendFile(entry);
        rest.shift();
        setSelected([...rest]);
        setUploaded(previous => [...previous, entry.filename]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed");
    } finally {
      setCurrent(""); setProgress(0); setUploading(false);
      await refreshPage().catch(() => {});
    }
  }

  const completed = !loading && uploaded.length > 0 && selected.length === 0 && !uploading && !error;

  return <main className="min-h-screen px-4 py-8 sm:px-8">
    <header className="mx-auto mb-10 flex max-w-2xl items-center gap-3">
      <img src="/tuckbox-mark.svg" width="40" height="40" alt="" aria-hidden="true" />
      <span className="text-lg font-semibold">TuckBox</span>
      <div className="ml-auto"><ThemeSwitcher /></div>
    </header>
    <Card className="mx-auto max-w-2xl p-6 sm:p-9">
      {completed ? <div role="status" aria-label="Upload complete" className="py-10 text-center">
        <CircleCheckBig size={52} className="mx-auto mb-5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        <h1 className="text-2xl font-semibold">Upload successful</h1>
      </div> : <>
      <h1 className="break-words text-3xl font-semibold">{page?.label || "Upload files"}</h1>
      {loading ? <p role="status" className="mt-6 text-sm text-zinc-500">Loading…</p> : <>
        {page?.active && (page.expiresAt || page.remaining !== null) && (
          <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
            {page.expiresAt && <>Until <time dateTime={page.expiresAt}>{new Date(page.expiresAt).toLocaleString()}</time></>}
            {page.expiresAt && page.remaining !== null && " · "}
            {page.remaining !== null && page.remaining + (page.remaining === 1 ? " upload remaining" : " uploads remaining")}
          </p>
        )}
        {!page?.active ? <p role="status" className="mt-6 rounded-xl bg-zinc-100 p-4 dark:bg-zinc-800">
          {page?.expired ? "This upload link has expired." :
            page ? "This upload link has reached its upload limit." : "Upload link unavailable."}
        </p> : <>
          <form onSubmit={event => { void upload(event); }} className="mt-6 space-y-4">
            <label htmlFor="public-files" onDragOver={event => event.preventDefault()}
              onDrop={event => { void drop(event); }}
              className="file-drop flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-6 text-center dark:border-white/20 dark:bg-zinc-950/70">
              <FileUp size={26} className="mb-3 text-emerald-700 dark:text-emerald-300"/>
              <span className="text-sm font-medium">Drop files or folders here</span>
              <span className="mt-2 text-xs text-zinc-500">90 MiB per file · folders become ZIPs · paste with Ctrl+V</span>
            </label>
            <input id="public-files" className="sr-only" type="file" multiple
              disabled={uploading || preparing} onChange={event => { void choose(event); }} />
            <input id="public-folder" className="sr-only" type="file" multiple
              ref={node => { if (node) node.setAttribute("webkitdirectory", ""); }}
              disabled={uploading || preparing} onChange={event => { void choose(event); }} />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" size="sm" disabled={uploading || preparing}
                onClick={() => document.getElementById("public-files")?.click()}>
                <FileUp size={15}/>Choose files</Button>
              <Button type="button" variant="secondary" size="sm" disabled={uploading || preparing}
                onClick={() => document.getElementById("public-folder")?.click()}>
                <FolderOpen size={15}/>Choose folder</Button>
            </div>
            {selected.length > 0 && <ul className="max-h-52 space-y-1 overflow-auto text-sm">
              {selected.map((entry, index) => <li key={entry.filename + ":" + index}
                className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 break-all">{entry.filename}</span>
                <span className="shrink-0 text-xs text-zinc-500">{sizeText(entry.file.size)}</span>
                <Button type="button" size="icon" variant="ghost" disabled={uploading}
                  aria-label={"Remove " + entry.filename}
                  onClick={() => setSelected(previous => previous.filter((_, n) => n !== index))}>
                  <X size={14}/>
                </Button>
              </li>)}
            </ul>}
            {uploading && <div role="status" className="text-sm">
              <p className="break-all">Uploading {current} · {progress}%</p>
              <div className="mt-2 h-2 rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div className="h-full rounded-full bg-emerald-400 transition-all"
                  style={{ width: progress + "%" }}/>
              </div>
            </div>}
            <Button type="submit" className="w-full" disabled={uploading || preparing || !selected.length}>
              {uploading && <LoaderCircle size={16} className="animate-spin"/>}
              {uploading ? "Uploading…" : "Upload " + selected.length + (selected.length === 1 ? " file" : " files")}
            </Button>
          </form>
        </>}
        {uploaded.length > 0 && <section role="status" className="mt-6 rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-4 text-sm">
          <p className="font-semibold">{uploaded.length} file(s) uploaded successfully</p>
        </section>}
        {error && <p role="alert" className="mt-4 break-words text-sm text-red-700 dark:text-red-300">{error}</p>}
      </>}
      </>}
    </Card>
  </main>;
}
