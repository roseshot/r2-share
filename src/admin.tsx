import { useEffect, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import {
  ArrowDownToLine, Clock3, FolderOpen,
  FileUp, Link2, LoaderCircle, LockKeyhole, LogOut,
  ShieldAlert, ShieldCheck, Trash2, X
} from "lucide-react";
import { Badge, Button, Card, Input, Select, buttonStyles } from "./ui";
import { version as appVersion } from "../package.json";
import { durations, jsonBody, requestJson, sizeText, timeText, type ManagedFile, type Mode } from "./lib";
import { originalModificationDate } from "./file-info";
import { ThemeSwitcher } from "./theme";
import AdminSettings from "./admin-settings";
import AdminShares from "./admin-shares";
import AdminPublicUploads from "./admin-public-uploads";
import { ConfirmDialog } from "./confirm-dialog";
import { successToast } from "./notifications";
import { appendUploads, droppedFiles, selectedFiles, type UploadEntry } from "./upload-queue";
import { archiveFolders } from "./folder-zip";
import { clipboardUploads, pasteIsEditing } from "./paste-upload";

const base = location.pathname;
const api = (path: string) => base + "/api" + path;

type UploadResult = {
  id: string; shareId: string; filename: string; size: number; mode: Mode; code: string | null;
  expiresAt: string | null;
};

type StorageUsage = {
  storageId: string;
  usedBytes: number | null;
  fileCount: number | null;
  calculatedAt: string | null;
};

type VirusTotalReport = {
  status: "found" | "pending" | "not_found" | "not_configured" | "rate_limited" | "unavailable";
  reason?: string;
  malicious?: number;
  suspicious?: number;
  harmless?: number;
  undetected?: number;
  scanDate?: number | null;
};

function virusTotalSummary(report: VirusTotalReport): string {
  if (report.reason) return report.reason;
  switch (report.status) {
    case "found":
      return `VirusTotal: ${report.malicious ?? 0} malicious, ${report.suspicious ?? 0} suspicious, ${report.harmless ?? 0} harmless, ${report.undetected ?? 0} undetected. No detections does not guarantee safety.`;
    case "pending": return "Report pending. The Worker checks queued hashes every 6 hours.";
    case "not_found": return "VirusTotal has no report for this SHA-256.";
    case "not_configured": return "Set a VirusTotal API key in Application settings to enable lookups.";
    case "rate_limited": return "VirusTotal rate limit reached. Try again later.";
    default: return "VirusTotal report is unavailable.";
  }
}

function ErrorText({ message }: { message: string }) {
  return message ? <p role="alert" className="rounded-xl border border-red-400/15 bg-red-400/10 p-3 text-sm text-red-700 dark:text-red-300">{message}</p> : null;
}

export default function Admin() {
  const [auth, setAuth] = useState<"checking" | "guest" | "admin">("checking");
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState("");
  const [files, setFiles] = useState<ManagedFile[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [totalFiles, setTotalFiles] = useState(0);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [storageFilter, setStorageFilter] = useState("");
  const [sort, setSort] = useState("newest");
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [selected, setSelected] = useState<UploadEntry[]>([]);
  const [readingFiles, setReadingFiles] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploadIndex, setUploadIndex] = useState(0);
  const [batchCount, setBatchCount] = useState(0);
  const [currentFilename, setCurrentFilename] = useState("");
  const [overallProgress, setOverallProgress] = useState(0);
  const [uploadFailures, setUploadFailures] = useState<{ filename: string; message: string }[]>([]);
  const [shareDuration, setShareDuration] = useState(86400);
  const [mode, setMode] = useState<Mode>("public");
  const [storageId, setStorageId] = useState("");
  const [storageIds, setStorageIds] = useState<string[]>([]);
  const [storageUsage, setStorageUsage] = useState<StorageUsage[]>([]);
  const [code, setCode] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [uploadResults, setUploadResults] = useState<UploadResult[]>([]);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteFilename, setRemoteFilename] = useState("");
  const [importingUrl, setImportingUrl] = useState(false);
  const [remoteError, setRemoteError] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editKind, setEditKind] = useState<"name" | "expiration">("name");
  const [editFilename, setEditFilename] = useState("");
  const [editError, setEditError] = useState("");
  const [saving, setSaving] = useState(false);
  const [vtLoading, setVtLoading] = useState<string | null>(null);
  const [vtResults, setVtResults] = useState<Record<string, VirusTotalReport>>({});
  const [vtUploadFile, setVtUploadFile] = useState<ManagedFile | null>(null);
  const [vtAuthorizing, setVtAuthorizing] = useState(false);
  const [vtUploadError, setVtUploadError] = useState("");
  const [confirmFile, setConfirmFile] = useState<ManagedFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  async function refresh() {
    setLoadingFiles(true);
    try {
      const settings = await requestJson<{
        storages: { id: string }[];
        storageUsage: StorageUsage[];
      }>(api("/settings"));
      const available = settings.storages.map(storage => storage.id);
      setStorageIds(available);
      setStorageUsage(settings.storageUsage);
      setStorageId(previous => available.includes(previous) ? previous : (available[0] ?? ""));
      const params = new URLSearchParams({ page: String(page), q: search, sort });
      if (storageFilter) params.set("storageId", storageFilter);
      const response = await requestJson<{ files: ManagedFile[]; total: number; hasMore: boolean }>(
        api("/files") + "?" + params.toString());
      setFiles(response.files);
      setTotalFiles(response.total);
      setHasMore(response.hasMore);
      if (page > 1 && response.files.length === 0 && response.total > 0) {
        setPage(Math.max(1, Math.ceil(response.total / 25)));
      }
    } catch (e) { setError((e as Error).message); }
    finally { setLoadingFiles(false); }
  }

  useEffect(() => {
    requestJson(api("/session"))
      .then(() => setAuth("admin"))
      .catch(() => setAuth("guest"));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { setPage(1); setSearch(searchInput.trim()); }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (auth === "admin") void refresh();
  }, [auth, page, search, storageFilter, sort]);


  async function login(event: FormEvent) {
    event.preventDefault();
    setSigningIn(true); setError("");
    try {
      await requestJson(api("/login"), { method: "POST", ...jsonBody({ password }) });
      setPassword(""); setAuth("admin");
    } catch (e) { setError((e as Error).message); }
    finally { setSigningIn(false); }
  }

  async function logout() {
    try { await requestJson(api("/logout"), { method: "POST", ...jsonBody({}) }); }
    finally { setFiles([]); setAuth("guest"); setPassword(""); }
  }

  function configureStorage() {
    const section = document.getElementById("object-storage-settings");
    section?.scrollIntoView({ behavior: "smooth", block: "start" });
    const input = section?.querySelector<HTMLInputElement>('input[aria-label="Storage ID"]');
    window.setTimeout(() => input?.focus({ preventScroll: true }), 350);
  }

  async function copyShareValue(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); successToast(label + " copied"); }
    catch { setError("Clipboard access failed. Copy the value manually."); }
  }

  function addToQueue(incoming: UploadEntry[]) {
    const { files: next, rejected } = appendUploads(selected, incoming);
    setSelected(next);
    setUploadFailures([]);
    if (rejected.length) {
      setError(rejected.length + " file(s) skipped. " +
        rejected[0].filename + ": " + rejected[0].reason);
    } else {
      setError("");
    }
  }

  async function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const isFolder = event.currentTarget.id === "upload-folder";
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!files.length || uploading || readingFiles) return;
    setReadingFiles(true);
    try {
      addToQueue(isFolder ? await archiveFolders(selectedFiles(files)) : selectedFiles(files));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to prepare folder ZIP");
    } finally {
      setReadingFiles(false);
    }
  }

  async function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (uploading || readingFiles) return;
    setReadingFiles(true);
    try {
      const entries = await droppedFiles(event.dataTransfer);
      if (!entries.length) {
        setError("No files found. Empty folders cannot be uploaded.");
        return;
      }
      addToQueue(await archiveFolders(entries));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to prepare dropped files");
    } finally {
      setReadingFiles(false);
    }
  }

  useEffect(() => {
    if (auth !== "admin" || uploading || readingFiles) return;
    function handlePaste(event: ClipboardEvent) {
      if (!event.clipboardData || pasteIsEditing(event.target)) return;
      const incoming = clipboardUploads(event.clipboardData);
      if (!incoming.length) return;
      event.preventDefault();
      setSelected(previous => {
        const result = appendUploads(previous, incoming);
        if (result.rejected.length) {
          setError(result.rejected.length + " pasted file(s) skipped. " + result.rejected[0].reason);
        } else {
          setError("");
        }
        return result.files;
      });
      setUploadFailures([]);
    }
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [auth, uploading, readingFiles]);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!selected.length || uploading || importingUrl || readingFiles) return;
    if (!storageIds.includes(storageId)) {
      setError("Configure an object storage backend before uploading"); return;
    }

    const batch = [...selected];
    const totalBytes = batch.reduce((sum, entry) => sum + entry.file.size, 0);
    let completedBytes = 0;
    const succeeded: UploadResult[] = [];
    const failed: UploadEntry[] = [];
    const failures: { filename: string; message: string }[] = [];
    setBatchCount(batch.length);
    setUploading(true); setProcessing(false); setProgress(0); setOverallProgress(0);
    setError(""); setUploadResults([]); setUploadFailures([]);

    for (const [index, entry] of batch.entries()) {
      setUploadIndex(index + 1);
      setCurrentFilename(entry.filename);
      setProgress(0);
      setProcessing(false);
      try {
        // Reserve an independent session immediately before each transfer.
        const init = await requestJson<{ id: string; shareId: string; token: string; code: string | null }>(
          api("/uploads"),
          { method: "POST", ...jsonBody({
            filename: entry.filename, size: entry.file.size,
            mime: entry.file.type || "application/octet-stream",
            shareExpiresIn: shareDuration,
            originalModifiedAt: originalModificationDate(entry.file.lastModified),
            mode, storageId, code: mode === "protected" ? code : undefined
          }) }
        );
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", api("/uploads/" + init.id));
          xhr.withCredentials = true;
          xhr.setRequestHeader("X-Upload-Token", init.token);
          xhr.setRequestHeader("Content-Type", "application/octet-stream");
          xhr.upload.onprogress = progressEvent => {
            if (progressEvent.lengthComputable) {
              const percentage = Math.round(progressEvent.loaded / progressEvent.total * 100);
              setProgress(percentage);
              setOverallProgress(Math.round((completedBytes + progressEvent.loaded) / totalBytes * 100));
              if (percentage === 100) setProcessing(true);
            }
          };
          xhr.onerror = () => reject(new Error("Network error during upload"));
          xhr.onabort = () => reject(new Error("Upload canceled"));
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
            let message = "Upload failed";
            try { message = (JSON.parse(xhr.responseText) as { error?: string }).error || message; }
            catch { /* The server did not return JSON. */ }
            reject(new Error(message));
          };
          xhr.send(entry.file);
        });
        const result: UploadResult = {
          id: init.id, shareId: init.shareId, filename: entry.filename, size: entry.file.size, mode,
          code: init.code, expiresAt: shareDuration === 0 ? null :
            new Date(Date.now() + shareDuration * 1000).toISOString(),
        };
        succeeded.push(result);
        setUploadResults([...succeeded]);
      } catch (reason) {
        failed.push(entry);
        failures.push({
          filename: entry.filename,
          message: reason instanceof Error ? reason.message : "Upload failed",
        });
        setUploadFailures([...failures]);
      } finally {
        completedBytes += entry.file.size;
        setOverallProgress(Math.round(completedBytes / totalBytes * 100));
      }
    }

    setSelected(failed); // Only unsuccessful files remain queued for retry.
    setUploadFailures(failures);
    if (!failed.length) { setCode(""); setMode("public"); }
    if (succeeded.length) {
      successToast(
        succeeded.length === 1 ? "File uploaded successfully" :
          succeeded.length + " files uploaded successfully",
        succeeded.length === 1 ? succeeded[0].code : undefined,
      );
      await refresh();
    }
    if (failures.length) setError(failures.length + " file(s) failed. Retry the remaining queue.");
    setUploading(false); setProcessing(false); setCurrentFilename("");
    setProgress(0);
  }

  async function importFromUrl(event: FormEvent) {
    event.preventDefault();
    if (importingUrl || uploading || readingFiles) return;
    if (!storageIds.includes(storageId)) {
      setRemoteError("Choose a configured Storage ID before importing"); return;
    }
    setImportingUrl(true);
    setRemoteError("");
    try {
      const imported = await requestJson<UploadResult>(api("/import-url"), {
        method: "POST", ...jsonBody({
          url: remoteUrl.trim(), filename: remoteFilename.trim() || undefined,
          storageId, mode, shareExpiresIn: shareDuration,
          code: mode === "protected" && code.trim() ? code.trim() : undefined,
        }),
      });
      setUploadResults(previous => [...previous, imported]);
      setRemoteUrl("");
      setRemoteFilename("");
      successToast("File imported from URL", imported.code ?? undefined);
      await refresh();
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : "Remote import failed");
    } finally {
      setImportingUrl(false);
    }
  }

  async function checkVirusTotal(record: ManagedFile) {
    if (vtLoading) return;
    setVtLoading(record.id);
    setError("");
    try {
      const result = await requestJson<VirusTotalReport>(api("/files/" + record.id + "/virustotal"));
      setVtResults(previous => ({ ...previous, [record.id]: result }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setVtLoading(null);
    }
  }

  async function authorizeVirusTotalUpload() {
    if (!vtUploadFile || vtAuthorizing) return;
    setVtAuthorizing(true);
    setVtUploadError("");
    try {
      const result = await requestJson<{ status: "authorized" | "submitted" | "cached" }>(
        api("/files/" + vtUploadFile.id + "/virustotal/upload"),
        { method: "POST", ...jsonBody({}) },
      );
      successToast(result.status === "authorized"
        ? "VirusTotal upload authorized for the next six-hour scan"
        : result.status === "submitted" ? "This sample was already submitted to VirusTotal"
          : "VirusTotal report is already cached");
      setVtUploadFile(null);
    } catch (e) {
      setVtUploadError(e instanceof Error ? e.message : "Authorization failed");
    } finally {
      setVtAuthorizing(false);
    }
  }

  function beginEdit(record: ManagedFile, kind: "name" | "expiration") {
    if (saving) return;
    setEditId(record.id);
    setEditKind(kind);
    setEditFilename(record.filename);
    setEditError("");
  }

  function cancelEdit() {
    if (saving) return;
    setEditId(null);
    setEditError("");
  }

  async function updateRecord(event: FormEvent) {
    event.preventDefault();
    if (!editId || editKind !== "name" || saving) return;
    const name = editFilename.trim();
    if (!name || name.length > 240 || /[\x00-\x1f\x7f]/.test(name)) {
      setEditError("File name must be 1–240 characters without control characters");
      return;
    }
    setSaving(true); setEditError("");
    try {
      await requestJson(api("/files/" + editId), {
        method: "PATCH", ...jsonBody({ filename: name }),
      });
      setVtResults(previous => { const next = { ...previous }; delete next[editId]; return next; });
      setEditId(null);
      successToast("File renamed");
      await refresh();
    } catch (e) { setEditError((e as Error).message); }
    finally { setSaving(false); }
  }

  async function updateFileExpiration(record: ManagedFile, seconds: number) {
    if (saving || !durations.some(duration => duration.seconds === seconds)) return;
    setSaving(true); setEditError("");
    try {
      await requestJson(api("/files/" + record.id), {
        method: "PATCH", ...jsonBody({ fileExpiresIn: seconds }),
      });
      setEditId(null);
      successToast("File deletion period updated");
      await refresh();
    } catch (e) { setEditError((e as Error).message); }
    finally { setSaving(false); }
  }

  async function remove(record: ManagedFile) {
    setDeleting(true);
    setDeleteError("");
    try {
      await requestJson(api("/files/" + record.id), { method: "DELETE" });
      setConfirmFile(null);
      await refresh();
      successToast("File deleted");
    } catch (e) { setDeleteError((e as Error).message); }
    finally { setDeleting(false); }
  }

  if (auth === "checking") return <div className="grid min-h-screen place-items-center text-zinc-500">
    <LoaderCircle className="animate-spin" /></div>;

  if (auth === "guest") return <main className="relative grid min-h-screen place-items-center px-5">
    <div className="absolute right-5 top-5 z-10"><ThemeSwitcher /></div>
    <div className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,.16),transparent_70%)]" />
    <Card className="relative w-full max-w-md p-7 sm:p-10">
      <span className="mb-7 grid size-12 place-items-center rounded-2xl bg-emerald-400 text-zinc-950"><LockKeyhole size={22}/></span>
      <p className="text-xs font-semibold uppercase tracking-[.22em] text-emerald-700 dark:text-emerald-300">File sharing</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Admin sign in</h1>
      <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">Sign in to manage files and share links.</p>
      <form className="mt-8 space-y-4" onSubmit={login}>
        <label htmlFor="admin-pass" className="block text-sm font-medium">Admin password</label>
        <Input id="admin-pass" type="password" autoComplete="current-password"
          value={password} onChange={e => setPassword(e.target.value)} required maxLength={256}
          placeholder="Enter your admin password" />
        <ErrorText message={error} />
        <Button type="submit" className="w-full" disabled={signingIn}>
          {signingIn && <LoaderCircle size={16} className="animate-spin"/>}{signingIn ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </Card>
  </main>;

  return <main className="min-h-screen px-4 pb-20 pt-7 sm:px-8">
    <div className="mx-auto max-w-6xl">
      <header className="mb-10 flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 dark:border-white/10 pb-6">
        <div className="flex items-center gap-3">
          <img src="/tuckbox-mark.svg" width="44" height="44" className="size-11" alt="" aria-hidden="true" />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xl font-semibold tracking-tight">TuckBox</p>
              <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">ADMIN</span>
              <Badge variant="muted">v{appVersion}</Badge>
            </div>
            <p className="mt-0.5 text-xs text-zinc-500">File sharing dashboard</p>
          </div>
        </div>
        <div className="flex items-center gap-2"><ThemeSwitcher /><Button variant="ghost" onClick={logout}><LogOut size={16}/>Sign out</Button></div>
      </header>

      <div className="mb-5"><ErrorText message={error}/></div>

      <section className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(320px,.8fr)]">
        <Card className="p-6 sm:p-8">
          <div className="mb-6 flex items-center gap-3"><FileUp className="text-emerald-700 dark:text-emerald-300" size={21}/>
            <h2 className="text-lg font-semibold">Upload files</h2>
          </div>
          <form onSubmit={upload} className="space-y-5">
            <label htmlFor="upload-file"
              onDragOver={event => { event.preventDefault(); if (!uploading) setDragging(true); }}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
              onDrop={event => { void handleDrop(event); }}
              className={`file-drop flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-4 py-6 text-center transition ${dragging ? "border-emerald-400 bg-emerald-400/10" : "border-zinc-300 dark:border-white/20 bg-zinc-50 dark:bg-zinc-950/70 hover:border-emerald-400/50"}`}>
              <FileUp size={27} className="mb-3 text-emerald-700 dark:text-emerald-300"/>
              <span className="max-w-full break-words text-sm font-medium">
                {readingFiles ? "Reading selected files…" :
                  selected.length ? selected.length + " file(s) ready to upload" :
                  "Choose files, folders or paste with Ctrl+V"}
              </span>
              <span className="mt-2 text-xs text-zinc-500">
                {selected.length ? sizeText(selected.reduce((total, entry) => total + entry.file.size, 0)) + " total" :
                  "Folders become ZIP files · 90 MiB per upload · 500 queued files"}
              </span>
            </label>
            <input id="upload-file" className="sr-only" type="file" multiple
              onChange={event => { void chooseFiles(event); }} disabled={uploading || readingFiles} />
            <input id="upload-folder" className="sr-only" type="file" multiple
              ref={element => { if (element) element.setAttribute("webkitdirectory", ""); }}
              onChange={event => { void chooseFiles(event); }} disabled={uploading || readingFiles}
              aria-label="Choose folder to upload" />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="secondary" size="sm"
                disabled={uploading || readingFiles} onClick={() => document.getElementById("upload-file")?.click()}>
                <FileUp size={15} />Choose files
              </Button>
              <Button type="button" variant="secondary" size="sm"
                disabled={uploading || readingFiles} onClick={() => document.getElementById("upload-folder")?.click()}>
                <FolderOpen size={15} />Choose folder (ZIP)
              </Button>
              {selected.length > 0 && <Button type="button" variant="ghost" size="sm"
                disabled={uploading || readingFiles} onClick={() => { setSelected([]); setError(""); }}>
                Clear queue
              </Button>}
            </div>
            {selected.length > 0 && <div className="rounded-xl border border-zinc-200 p-3 dark:border-white/10">
              <p className="mb-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Upload queue · {selected.length} {selected.length === 1 ? "file" : "files"}
              </p>
              <ul className="max-h-36 space-y-1 overflow-auto text-xs">
                {selected.map((entry, index) => <li key={entry.filename + ":" + index}
                  className="flex items-center justify-between gap-2 py-1">
                  <span className="min-w-0 flex-1 break-all">{entry.filename}</span>
                  <span className="shrink-0 text-zinc-500">{sizeText(entry.file.size)}</span>
                  <Button size="icon" variant="ghost" className="size-7 shrink-0"
                    disabled={uploading} aria-label={"Remove " + entry.filename + " from queue"}
                    onClick={() => setSelected(previous => previous.filter((_, item) => item !== index))}>
                    <X size={14} />
                  </Button>
                </li>)}
              </ul>
            </div>}
            <div>
              <label htmlFor="upload-storage-id" className="mb-2 block text-sm text-zinc-700 dark:text-zinc-300">Storage ID</label>
              {storageIds.length ? (
                <Select id="upload-storage-id" value={storageId} disabled={uploading || importingUrl}
                  onValueChange={setStorageId}
                  options={storageIds.map(id => ({ value: id, label: id }))} />
              ) : (
                <div className="rounded-xl border border-amber-400/20 bg-amber-400/10 px-3 py-3 text-sm">
                  <p>No storage configured. Add a storage ID to start uploading.</p>
                  <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={configureStorage}>
                    Configure storage
                  </Button>
                </div>
              )}
            </div>
            <div><label htmlFor="upload-share-expiration" className="mb-2 block text-sm text-zinc-700 dark:text-zinc-300">Share expiration</label>
              <Select id="upload-share-expiration" value={String(shareDuration)}
                onValueChange={value => setShareDuration(Number(value))}
                disabled={uploading || importingUrl} options={durations.map(d => ({ value: String(d.seconds), label: d.label }))} />
            </div>
            <p className="text-xs leading-5 text-zinc-500">
              Files remain stored by default. Share expiration disables only that link, not the file.
              You can set a separate file expiration in File settings.
            </p>
            <div><label htmlFor="upload-access" className="mb-2 block text-sm text-zinc-700 dark:text-zinc-300">Download access</label>
              <Select id="upload-access" value={mode} onValueChange={value => setMode(value as Mode)}
                disabled={uploading || importingUrl} options={[
                  { value: "public", label: "Public link" },
                  { value: "protected", label: "Access code required" },
                ]} />
            </div>
            {mode === "protected" && <div>
              <label htmlFor="upload-code" className="mb-2 block text-sm text-zinc-700 dark:text-zinc-300">Access code <span className="text-zinc-500">(leave blank to generate)</span></label>
              <Input id="upload-code" value={code} onChange={e => setCode(e.target.value)} minLength={4} maxLength={64}
                autoComplete="off" placeholder="At least 4 characters; generated codes have 8" disabled={uploading || importingUrl}/>
            </div>}
            {uploading && <div>
              <div role="status" aria-live="polite"
                className="mb-2 flex flex-wrap justify-between gap-1 text-xs text-zinc-600 dark:text-zinc-400">
                <span className="min-w-0 break-all">
                  {processing ? "Processing file…" : "Upload progress"} ·
                  {" " + uploadIndex + " / " + batchCount}
                  {" · " + currentFilename}
                </span>
                <span>{overallProgress}% overall · {processing ? "Finalizing" : progress + "% current"}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: overallProgress + "%" }}/>
              </div>
            </div>}
            <Button className="w-full" type="submit"
              disabled={!selected.length || uploading || importingUrl || readingFiles || !storageIds.includes(storageId)}>
              {uploading ? <LoaderCircle size={17} className="animate-spin"/> : <FileUp size={17}/>}
              {uploading ? (processing ? "Processing file…" : "Uploading…") :
                "Upload " + selected.length + (selected.length === 1 ? " file" : " files") + " and create share links"}
            </Button>
          </form>
          <form onSubmit={event => { void importFromUrl(event); }}
            className="mt-7 space-y-3 border-t border-zinc-200 pt-6 dark:border-white/10"
            aria-label="Import file from URL">
            <div className="flex items-center gap-2">
              <Link2 size={18} className="text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
              <h3 className="text-sm font-semibold">Import from URL</h3>
            </div>
            <p className="text-xs leading-5 text-zinc-500">
              The Worker follows redirects and saves the file to the selected Storage ID.
              Leave the filename blank to use the final URL path.
              The 90 MiB limit, share expiration and access settings above also apply.
            </p>
            <label className="block text-sm" htmlFor="remote-file-url">File URL</label>
            <Input id="remote-file-url" type="url" value={remoteUrl}
              onChange={event => setRemoteUrl(event.target.value)} required maxLength={2048}
              placeholder="https://example.com/download/file.zip"
              disabled={importingUrl || uploading} />
            <label className="block text-sm" htmlFor="remote-filename">Filename (optional)</label>
            <Input id="remote-filename" value={remoteFilename}
              onChange={event => setRemoteFilename(event.target.value)} maxLength={240}
              placeholder="Use filename from final URL" disabled={importingUrl || uploading} />
            <Button type="submit" className="w-full"
              disabled={importingUrl || uploading || readingFiles || !remoteUrl.trim() ||
                !storageIds.includes(storageId)}>
              {importingUrl ? <LoaderCircle size={17} className="animate-spin" /> : <Link2 size={17} />}
              {importingUrl ? "Importing remote file…" : "Download URL to bucket"}
            </Button>
            <ErrorText message={remoteError} />
          </form>
          {uploadFailures.length > 0 && <section aria-label="Upload errors" role="alert"
            className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-700 dark:text-red-300">
            <h3 className="font-semibold">{uploadFailures.length} file(s) failed</h3>
            <ul className="mt-2 max-h-40 space-y-1 overflow-auto">
              {uploadFailures.map(({ filename, message }, index) =>
                <li key={index} className="break-all">{filename}: {message}</li>)}
            </ul>
            <p className="mt-2 text-xs">Failed files remain in the upload queue for retry.</p>
          </section>}
          {uploadResults.length > 0 && <section aria-label="Upload result"
            className="mt-6 rounded-xl border border-emerald-400/30 bg-emerald-400/5 p-4">
            <h3 className="font-semibold text-emerald-700 dark:text-emerald-300">
              {uploadResults.length} {uploadResults.length === 1 ? "file" : "files"} uploaded successfully
            </h3>
            <ul className="mt-3 max-h-96 space-y-4 overflow-auto">
              {uploadResults.map(result => <li key={result.id}
                className="border-t border-emerald-400/15 pt-3 first:border-0 first:pt-0">
                <p className="break-all text-sm font-medium">{result.filename} · {sizeText(result.size)}</p>
                <p className="mt-2 text-xs text-zinc-500">Share link</p>
                <code className="mt-1 block break-all rounded-lg bg-white p-3 text-xs dark:bg-zinc-950">
                  {location.origin + "/" + result.shareId}
                </code>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary"
                    onClick={() => void copyShareValue(location.origin + "/" + result.shareId, "Share link")}>
                    Copy link
                  </Button>
                  <a className={buttonStyles({ variant: "secondary", size: "sm" })}
                    href={"/" + result.shareId} target="_blank" rel="noopener noreferrer">Open link</a>
                </div>
                <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
                  {result.mode === "protected" ? "Access code required" : "Public link"}
                  {" · Expires: " + timeText(result.expiresAt)}
                </p>
                {result.code && <div className="mt-3">
                  <p className="text-xs text-zinc-500">Access code</p>
                  <code className="mt-1 block break-all text-sm">{result.code}</code>
                  <Button size="sm" variant="secondary" className="mt-2"
                    onClick={() => void copyShareValue(result.code!, "Access code")}>
                    Copy access code
                  </Button>
                </div>}
              </li>)}
            </ul>
          </section>}
        </Card>
        <Card className="flex flex-col justify-between p-6 sm:p-8">
          <div>
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300"><ShieldCheck size={21}/><span className="font-semibold">File sharing</span></div>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight">{totalFiles} <span className="text-lg font-normal text-zinc-500">files</span></h2>
            <p className="mt-3 text-sm leading-7 text-zinc-600 dark:text-zinc-400">
              Manage file uploads, share links, and access settings in one place.
              Only administrators can upload, reveal access codes, change settings, or delete files.
            </p>
          </div>
          <div className="mt-7 space-y-3 border-t border-zinc-200 dark:border-white/10 pt-6 text-sm text-zinc-600 dark:text-zinc-400">
            <section aria-label="Storage used" className="space-y-2">
              <h3 className="font-medium text-zinc-900 dark:text-zinc-100">Storage used</h3>
              {storageUsage.length ? <ul className="space-y-2">
                {storageUsage.map(usage => <li key={usage.storageId}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <Badge variant="muted">{usage.storageId}</Badge>
                  <span className="text-right text-zinc-900 dark:text-zinc-100">
                    {usage.usedBytes === null ? "Awaiting first cleanup" :
                      sizeText(usage.usedBytes) + " · " + usage.fileCount +
                        (usage.fileCount === 1 ? " file" : " files")}
                  </span>
                </li>)}
              </ul> : <p className="text-xs text-zinc-500">No storage configured</p>}
              <p className="text-xs leading-5 text-zinc-500">
                {storageUsage.find(usage => usage.calculatedAt)?.calculatedAt
                  ? "Calculated after cleanup: " +
                    new Date(storageUsage.find(usage => usage.calculatedAt)!.calculatedAt!).toLocaleString()
                  : "Usage is calculated after the next file cleanup."}
              </p>
            </section>
            <div className="flex items-center justify-between"><span>File cleanup</span><Badge>Every 6 hours</Badge></div>
            <div className="flex items-center justify-between"><span>Share links</span><Badge variant="muted">Configurable expiry</Badge></div>
          </div>
        </Card>
      </section>

      <section className="mt-10">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-xl font-semibold">File management</h2><p className="mt-1 text-sm text-zinc-500">View, share, and manage files</p></div>
          <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={loadingFiles}>
            {loadingFiles ? <LoaderCircle size={15} className="animate-spin"/> : <Clock3 size={15}/>}
            Refresh list
          </Button>
        </div>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(160px,auto)_minmax(160px,auto)]">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-zinc-500">Search filename</span>
              <Input value={searchInput} onChange={event => setSearchInput(event.target.value)}
                placeholder="Find a file…" maxLength={100} />
            </label>
            <div>
              <label htmlFor="files-storage-filter" className="mb-1 block text-xs text-zinc-500">Storage</label>
              <Select id="files-storage-filter" value={storageFilter}
                onValueChange={value => { setPage(1); setStorageFilter(value); }}
                options={[{ value: "", label: "All storages" }, ...storageIds.map(id => ({ value: id, label: id }))]} />
            </div>
            <div>
              <label htmlFor="files-sort" className="mb-1 block text-xs text-zinc-500">Order</label>
              <Select id="files-sort" value={sort}
                onValueChange={value => { setPage(1); setSort(value); }}
                options={[{ value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }]} />
            </div>
          </div>
          <p role="status" className="text-xs text-zinc-500">
            {totalFiles} matching {totalFiles === 1 ? "file" : "files"} · Page {page}
          </p>
          {!loadingFiles && !files.length && <Card className="px-6 py-14 text-center">
            <h3 className="text-lg font-semibold">{search || storageFilter ? "No matching files" : "No files yet"}</h3>
            <p className="mt-2 text-sm text-zinc-500">
              {search || storageFilter ? "Try another filename or storage filter." : "Choose a file above to create your first share link."}
            </p>
          </Card>}
          {files.map(record => <Card key={record.id} className="p-5 sm:p-6">
            <div className="flex flex-col justify-between gap-5 md:flex-row md:items-start">
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant="muted">{record.storageId}</Badge>
                  {editId === record.id && editKind === "name" ? (
                    <form onSubmit={updateRecord} aria-label={"Rename " + record.filename}
                      className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                      <label htmlFor="edit-filename" className="sr-only">File name</label>
                      <Input id="edit-filename" autoFocus required maxLength={240}
                        className="min-w-44 flex-1"
                        value={editFilename} onChange={event => setEditFilename(event.target.value)} />
                      <Button type="submit" size="sm" disabled={saving || !editFilename.trim()}>
                        {saving ? "Saving…" : "Save"}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" disabled={saving}
                        onClick={cancelEdit}>Cancel</Button>
                      {editError && <p role="alert" className="w-full break-words text-xs text-red-700 dark:text-red-300">
                        {editError}
                      </p>}
                    </form>
                  ) : (
                    <button type="button" disabled={saving}
                      className="break-all text-left text-base font-medium underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-emerald-400"
                      aria-label={"Rename " + record.filename} title="Click to rename"
                      onClick={() => beginEdit(record, "name")}>{record.filename}</button>
                  )}
                </div>
                <p className="mt-2 text-xs text-zinc-500">{sizeText(record.size)} · {new Date(record.createdAt).toLocaleString("en-US")}</p>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-600 dark:text-zinc-400">
                  {editId === record.id && editKind === "expiration" ? (
                    <div role="group" aria-label={"Edit file deletion period for " + record.filename}
                      className="flex min-w-0 flex-wrap items-center gap-2">
                      <label htmlFor="edit-file-expiration" className="shrink-0">File deletion:</label>
                      <Select id="edit-file-expiration" className="w-44 max-w-full" disabled={saving}
                        value="-1"
                        onValueChange={value => {
                          if (value === "-1") { cancelEdit(); return; }
                          void updateFileExpiration(record, Number(value));
                        }}
                        options={[
                          { value: "-1", label: "Choose period…" },
                          ...durations.map(duration => ({
                            value: String(duration.seconds),
                            label: duration.seconds === 0 ? "Never" : duration.label,
                          })),
                        ]} />
                      {saving && <span role="status">Saving…</span>}
                      {editError && <p role="alert" className="w-full break-words text-red-700 dark:text-red-300">
                        {editError}
                      </p>}
                    </div>
                  ) : (
                    <button type="button" disabled={saving}
                      className="text-left underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-emerald-400"
                      aria-label={"Edit file deletion period for " + record.filename}
                      title="Click to change deletion period"
                      onClick={() => beginEdit(record, "expiration")}>
                      File deletion: {timeText(record.fileExpiresAt)}
                    </button>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <a className={buttonStyles({ variant: "secondary", size: "sm" })} href={api("/files/" + record.id + "/download")}>
                  <ArrowDownToLine size={15}/>Download
                </a>
                {record.checksums && <>
                  <Button size="sm" variant="ghost" onClick={() => void checkVirusTotal(record)} disabled={vtLoading !== null}>
                    {vtLoading === record.id ? <LoaderCircle size={15} className="animate-spin"/> : <ShieldAlert size={15}/>}
                    VirusTotal
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => {
                    setVtUploadFile(record);
                    setVtUploadError("");
                  }}>
                    Submit to VirusTotal
                  </Button>
                </>}
                <Button size="icon" variant="destructive" aria-label="Delete file" onClick={() => { setConfirmFile(record); setDeleteError(""); }}><Trash2 size={16}/></Button>
              </div>
            </div>
            {vtResults[record.id] && <div role="status" className="mt-4 rounded-xl border border-zinc-200 bg-zinc-100/80 px-4 py-3 text-sm text-zinc-700 dark:border-white/10 dark:bg-zinc-950/60 dark:text-zinc-300">
              <div className="flex items-center gap-2 font-medium"><ShieldAlert size={16} aria-hidden="true" />SHA-256 reputation lookup</div>
              <p className="mt-2">{virusTotalSummary(vtResults[record.id])}</p>
              {vtResults[record.id].scanDate && <p className="mt-1 text-xs text-zinc-500">Last analysis: {new Date(vtResults[record.id].scanDate! * 1000).toLocaleString("en-US")}</p>}
            </div>}
            <AdminShares fileId={record.id} shares={record.shares} api={api} onSaved={refresh} />
          </Card>)}
          <nav aria-label="File pages" className="flex items-center justify-between gap-3 pt-3">
            <Button size="sm" variant="secondary" disabled={page <= 1 || loadingFiles}
              onClick={() => setPage(value => Math.max(1, value - 1))}>Previous</Button>
            <span className="text-xs text-zinc-500">Page {page} / {Math.max(1, Math.ceil(totalFiles / 25))}</span>
            <Button size="sm" variant="secondary" disabled={!hasMore || loadingFiles}
              onClick={() => setPage(value => value + 1)}>Next</Button>
          </nav>
        </div>
      </section>
      <AdminPublicUploads api={api} storageIds={storageIds} />
      <AdminSettings api={api} onSaved={() => void refresh()} />
      <ConfirmDialog open={vtUploadFile !== null}
        onOpenChange={open => { if (!open) { setVtUploadFile(null); setVtUploadError(""); } }}
        title="Authorize VirusTotal file upload?"
        description={`This uploads the entire file "${vtUploadFile?.filename ?? ""}" to VirusTotal when no SHA-256 report exists. VirusTotal may share uploaded samples with its security community and partners. Never submit sensitive, personal, or confidential files. Only this selected file is authorized.`}
        confirmLabel="Authorize upload"
        pending={vtAuthorizing}
        error={vtUploadError}
        onConfirm={() => void authorizeVirusTotalUpload()} />
      <ConfirmDialog open={confirmFile !== null}
        onOpenChange={open => { if (!open) { setConfirmFile(null); setDeleteError(""); } }}
        title="Delete file?"
        description={confirmFile
          ? 'Permanently delete "' + confirmFile.filename + '" and revoke all its share links? This cannot be undone.'
          : ""}
        confirmLabel="Delete file" pending={deleting} error={deleteError}
        onConfirm={() => { if (confirmFile) void remove(confirmFile); }} />
    </div>
  </main>;
}
