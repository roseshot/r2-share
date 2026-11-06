import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import {
  ArrowDownToLine, Clock3,
  FileUp, LoaderCircle, LockKeyhole, LogOut,
  ShieldAlert, ShieldCheck, Trash2
} from "lucide-react";
import { Badge, Button, Card, Input, Select, buttonStyles } from "./ui";
import { durations, jsonBody, requestJson, sizeText, timeText, type ManagedFile, type Mode } from "./lib";
import { originalModificationDate } from "./file-info";
import { ThemeSwitcher } from "./theme";
import AdminSettings from "./admin-settings";
import AdminShares from "./admin-shares";
import { ConfirmDialog } from "./confirm-dialog";
import { successToast } from "./notifications";

const base = location.pathname;
const api = (path: string) => base + "/api" + path;

type VirusTotalReport = {
  status: "found" | "not_found" | "not_configured" | "rate_limited" | "unavailable";
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
  const [selected, setSelected] = useState<File | null>(null);
  const [shareDuration, setShareDuration] = useState(86400);
  const [mode, setMode] = useState<Mode>("public");
  const [storageId, setStorageId] = useState("");
  const [storageIds, setStorageIds] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [uploadResult, setUploadResult] = useState<{
    id: string; filename: string; size: number; mode: Mode; code: string | null;
    expiresAt: string | null;
  } | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editFileDuration, setEditFileDuration] = useState(-1);
  const [saving, setSaving] = useState(false);
  const [vtLoading, setVtLoading] = useState<string | null>(null);
  const [vtResults, setVtResults] = useState<Record<string, VirusTotalReport>>({});
  const [confirmFile, setConfirmFile] = useState<ManagedFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  async function refresh() {
    setLoadingFiles(true);
    try {
      const settings = await requestJson<{ storages: { id: string }[] }>(api("/settings"));
      const available = settings.storages.map(storage => storage.id);
      setStorageIds(available);
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

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!selected || uploading) return;
    if (!storageIds.includes(storageId)) {
      setError("Configure an object storage backend before uploading"); return;
    }
    if (selected.size > 90 * 1024 * 1024 || selected.size === 0) {
      setError("File size must be greater than zero and at most 90 MiB"); return;
    }
    setUploading(true); setProcessing(false); setProgress(0); setError(""); setUploadResult(null);
    try {
      const init = await requestJson<{ id: string; token: string; code: string | null }>(
        api("/uploads"),
        { method: "POST", ...jsonBody({
          filename: selected.name, size: selected.size, mime: selected.type || "application/octet-stream",
          shareExpiresIn: shareDuration,
          originalModifiedAt: originalModificationDate(selected.lastModified),
          mode, storageId, code: mode === "protected" ? code : undefined
        }) }
      );
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", api("/uploads/" + init.id));
        xhr.withCredentials = true;
        xhr.setRequestHeader("X-Upload-Token", init.token);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.upload.onprogress = e => {
          if (e.lengthComputable) {
            const percentage = Math.round(e.loaded / e.total * 100);
            setProgress(percentage);
            if (percentage === 100) setProcessing(true);
          }
        };
        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.onabort = () => reject(new Error("Upload canceled"));
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
          try { reject(new Error((JSON.parse(xhr.responseText) as { error: string }).error || "Upload failed")); }
          catch (e) { reject(e instanceof Error ? e : new Error("Upload failed")); }
        };
        xhr.send(selected);
      });
      setUploadResult({
        id: init.id, filename: selected.name, size: selected.size, mode,
        code: init.code, expiresAt: shareDuration === 0 ? null :
          new Date(Date.now() + shareDuration * 1000).toISOString(),
      });
      successToast("File uploaded successfully", init.code);
      setSelected(null); setCode(""); setMode("public"); setProgress(0);
      const field = document.getElementById("upload-file") as HTMLInputElement | null;
      if (field) field.value = "";
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setUploading(false); setProcessing(false); }
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

  function beginEdit(record: ManagedFile) {
    setEditId(record.id); setEditFileDuration(-1);
    setError("");
  }

  async function updateRecord(event: FormEvent) {
    event.preventDefault();
    if (!editId || editFileDuration < 0) return;
    setSaving(true); setError("");
    try {
      await requestJson(api("/files/" + editId), {
        method: "PATCH", ...jsonBody({
          fileExpiresIn: editFileDuration
        })
      });
      setVtResults(previous => { const next = { ...previous }; delete next[editId]; return next; });
      setEditId(null); await refresh(); successToast("File settings updated");
    } catch (e) { setError((e as Error).message); }
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
            <p className="text-xl font-semibold tracking-tight">TuckBox <span className="ml-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">ADMIN</span></p>
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
            <label htmlFor="upload-file" className="file-drop flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-300 dark:border-white/20 bg-zinc-50 dark:bg-zinc-950/70 px-4 py-6 text-center transition hover:border-emerald-400/50">
              <FileUp size={27} className="mb-3 text-emerald-700 dark:text-emerald-300"/>
              <span className="max-w-full break-all text-sm font-medium">{selected?.name || "Choose a file to share"}</span>
              <span className="mt-2 text-xs text-zinc-500">{selected ? sizeText(selected.size) : "Up to 90 MiB · Streaming upload"}</span>
            </label>
            <input id="upload-file" className="sr-only" type="file" onChange={(e: ChangeEvent<HTMLInputElement>) => setSelected(e.target.files?.[0] ?? null)} disabled={uploading}/>
            <div>
              <label htmlFor="upload-storage-id" className="mb-2 block text-sm text-zinc-700 dark:text-zinc-300">Storage ID</label>
              {storageIds.length ? (
                <Select id="upload-storage-id" value={storageId} disabled={uploading}
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
                disabled={uploading} options={durations.map(d => ({ value: String(d.seconds), label: d.label }))} />
            </div>
            <p className="text-xs leading-5 text-zinc-500">
              Files remain stored by default. Share expiration disables only that link, not the file.
              You can set a separate file expiration in File settings.
            </p>
            <div><label htmlFor="upload-access" className="mb-2 block text-sm text-zinc-700 dark:text-zinc-300">Download access</label>
              <Select id="upload-access" value={mode} onValueChange={value => setMode(value as Mode)}
                disabled={uploading} options={[
                  { value: "public", label: "Public link" },
                  { value: "protected", label: "Access code required" },
                ]} />
            </div>
            {mode === "protected" && <div>
              <label htmlFor="upload-code" className="mb-2 block text-sm text-zinc-700 dark:text-zinc-300">Access code <span className="text-zinc-500">(leave blank to generate)</span></label>
              <Input id="upload-code" value={code} onChange={e => setCode(e.target.value)} minLength={4} maxLength={64}
                autoComplete="off" placeholder="At least 4 characters; generated codes have 8" disabled={uploading}/>
            </div>}
            {uploading && <div>
              <div role="status" aria-live="polite" className="mb-2 flex justify-between text-xs text-zinc-600 dark:text-zinc-400"><span>{processing ? "Processing file…" : "Upload progress"}</span><span>{processing ? "Finalizing" : progress + "%"}</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: progress + "%" }}/>
              </div>
            </div>}
            <Button className="w-full" type="submit" disabled={!selected || uploading || !storageIds.includes(storageId)}>
              {uploading ? <LoaderCircle size={17} className="animate-spin"/> : <FileUp size={17}/>}
              {uploading ? (processing ? "Processing file…" : "Uploading…") : "Upload and create share link"}
            </Button>
          </form>
          {uploadResult && <section aria-label="Upload result" role="status"
            className="mt-6 rounded-xl border border-emerald-400/30 bg-emerald-400/5 p-4">
            <h3 className="font-semibold text-emerald-700 dark:text-emerald-300">File uploaded successfully</h3>
            <p className="mt-2 break-all text-sm">{uploadResult.filename} · {sizeText(uploadResult.size)}</p>
            <p className="mt-3 text-xs text-zinc-500">Share link</p>
            <code className="mt-1 block break-all rounded-lg bg-white p-3 text-xs dark:bg-zinc-950">
              {location.origin + "/" + uploadResult.id}
            </code>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary"
                onClick={() => void copyShareValue(location.origin + "/" + uploadResult.id, "Share link")}>
                Copy link
              </Button>
              <a className={buttonStyles({ variant: "secondary", size: "sm" })}
                href={"/" + uploadResult.id} target="_blank" rel="noopener noreferrer">Open link</a>
            </div>
            <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
              {uploadResult.mode === "protected" ? "Access code required" : "Public link"}
              {" · Expires: " + timeText(uploadResult.expiresAt)}
            </p>
            {uploadResult.code && <div className="mt-3">
              <p className="text-xs text-zinc-500">Access code</p>
              <code className="mt-1 block break-all text-sm">{uploadResult.code}</code>
              <Button size="sm" variant="secondary" className="mt-2"
                onClick={() => void copyShareValue(uploadResult.code!, "Access code")}>
                Copy access code
              </Button>
            </div>}
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
            <div className="flex items-center justify-between"><span>Storage used (current page)</span>
              <span className="font-medium text-zinc-900 dark:text-zinc-100">{sizeText(files.reduce((sum, f) => sum + f.size, 0))}</span></div>
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
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all text-base font-medium">{record.filename}</span>
                  <Badge variant="muted">{record.storageId}</Badge>

                </div>
                <p className="mt-2 text-xs text-zinc-500">{sizeText(record.size)} · {new Date(record.createdAt).toLocaleString("en-US")}</p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                  <span>File: {timeText(record.fileExpiresAt)}</span>
                </div>

              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <a className={buttonStyles({ variant: "secondary", size: "sm" })} href={api("/files/" + record.id + "/download")}>
                  <ArrowDownToLine size={15}/>Download
                </a>
                {record.checksums && <Button size="sm" variant="ghost" onClick={() => void checkVirusTotal(record)} disabled={vtLoading !== null}>
                  {vtLoading === record.id ? <LoaderCircle size={15} className="animate-spin"/> : <ShieldAlert size={15}/>}
                  VirusTotal
                </Button>}
                <Button size="sm" variant="ghost" onClick={() => editId === record.id ? setEditId(null) : beginEdit(record)}>Settings</Button>
                <Button size="icon" variant="destructive" aria-label="Delete file" onClick={() => { setConfirmFile(record); setDeleteError(""); }}><Trash2 size={16}/></Button>
              </div>
            </div>
            {vtResults[record.id] && <div role="status" className="mt-4 rounded-xl border border-zinc-200 bg-zinc-100/80 px-4 py-3 text-sm text-zinc-700 dark:border-white/10 dark:bg-zinc-950/60 dark:text-zinc-300">
              <div className="flex items-center gap-2 font-medium"><ShieldAlert size={16} aria-hidden="true" />SHA-256 reputation lookup</div>
              <p className="mt-2">{virusTotalSummary(vtResults[record.id])}</p>
              {vtResults[record.id].scanDate && <p className="mt-1 text-xs text-zinc-500">Last analysis: {new Date(vtResults[record.id].scanDate! * 1000).toLocaleString("en-US")}</p>}
            </div>}
            <AdminShares fileId={record.id} shares={record.shares} api={api} onSaved={refresh} />
            {editId === record.id && <form
              className="mt-5 space-y-4 rounded-xl border border-zinc-200 bg-zinc-100/80 p-4 dark:border-white/10 dark:bg-black/20"
              onSubmit={updateRecord}>
              <h3 className="text-sm font-semibold">File retention settings</h3>
              <label htmlFor="edit-file-expiration" className="block text-xs text-zinc-600 dark:text-zinc-400">
                File expiration
              </label>
              <Select id="edit-file-expiration" value={String(editFileDuration)}
                onValueChange={value => setEditFileDuration(Number(value))}
                options={[
                  { value: "-1", label: "Keep unchanged" },
                  ...durations.map(d => ({ value: String(d.seconds), label: d.label + " (from now)" })),
                ]} />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" disabled={saving || editFileDuration < 0}>
                  {saving ? "Saving…" : "Save file settings"}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditId(null)}>Cancel</Button>
              </div>
            </form>}
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
      <AdminSettings api={api} onSaved={() => void refresh()} />
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
