import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import {
  ArrowDownToLine, Check, Clock3, Copy, Eye, EyeOff,
  FileUp, KeyRound, Link2, LoaderCircle, LockKeyhole, LogOut,
  ShieldAlert, ShieldCheck, Trash2, X
} from "lucide-react";
import { Badge, Button, Card, Input, Select, buttonStyles } from "./ui";
import { durations, jsonBody, requestJson, sizeText, timeText, type ManagedFile, type Mode, type StorageBackend } from "./lib";
import { originalModificationDate } from "./file-info";
import { ThemeSwitcher } from "./theme";
import AdminSettings from "./admin-settings";

const base = location.pathname;
const api = (path: string) => base + "/api" + path;
const shareLink = (id: string) => location.origin + "/" + id;
const shareableId = (id: string) => /^[A-Za-z0-9_-]{16}$/.test(id);

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
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<ManagedFile[]>([]);
  const [listTruncated, setListTruncated] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [selected, setSelected] = useState<File | null>(null);
  const [shareDuration, setShareDuration] = useState(86400);
  const [mode, setMode] = useState<Mode>("public");
  const [storageBackend, setStorageBackend] = useState<StorageBackend>("b2");
  const [availableBackends, setAvailableBackends] = useState<StorageBackend[]>([]);
  const [code, setCode] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [editId, setEditId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<Mode>("public");
  const [editCode, setEditCode] = useState("");
  const [editFileDuration, setEditFileDuration] = useState(-1);
  const [editShareDuration, setEditShareDuration] = useState(-1);
  const [saving, setSaving] = useState(false);
  const [vtLoading, setVtLoading] = useState<string | null>(null);
  const [vtResults, setVtResults] = useState<Record<string, VirusTotalReport>>({});

  async function refresh() {
    setLoadingFiles(true);
    try {
      const settings = await requestJson<{ configured: boolean; b2Configured: boolean; r2Configured: boolean }>(api("/settings"));
      const available: StorageBackend[] = [
        ...(settings.b2Configured ? ["b2" as const] : []),
        ...(settings.r2Configured ? ["r2" as const] : []),
      ];
      setAvailableBackends(available);
      setStorageBackend(previous => available.includes(previous) ? previous : (available[0] ?? "b2"));
      if (!settings.configured) {
        setFiles([]);
        setListTruncated(false);
        return;
      }
      const response = await requestJson<{ files: ManagedFile[]; truncated: boolean }>(api("/files"));
      setFiles(response.files);
      setListTruncated(response.truncated);
    } catch (e) { setError((e as Error).message); }
    finally { setLoadingFiles(false); }
  }

  useEffect(() => {
    requestJson(api("/session"))
      .then(() => { setAuth("admin"); void refresh(); })
      .catch(() => setAuth("guest"));
  }, []);

  function notify(text: string) { setMessage(text); setError(""); }

  async function login(event: FormEvent) {
    event.preventDefault();
    setSigningIn(true); setError("");
    try {
      await requestJson(api("/login"), { method: "POST", ...jsonBody({ password }) });
      setPassword(""); setAuth("admin");
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setSigningIn(false); }
  }

  async function logout() {
    try { await requestJson(api("/logout"), { method: "POST", ...jsonBody({}) }); }
    finally { setRevealed({}); setFiles([]); setAuth("guest"); setPassword(""); }
  }

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!selected || uploading) return;
    if (!availableBackends.includes(storageBackend)) {
      setError("Configure an object storage backend before uploading"); return;
    }
    if (selected.size > 90 * 1024 * 1024 || selected.size === 0) {
      setError("File size must be greater than zero and at most 90 MiB"); return;
    }
    setUploading(true); setProgress(0); setError(""); setMessage("");
    try {
      const init = await requestJson<{ id: string; token: string; code: string | null }>(
        api("/uploads"),
        { method: "POST", ...jsonBody({
          filename: selected.name, size: selected.size, mime: selected.type || "application/octet-stream",
          shareExpiresIn: shareDuration,
          originalModifiedAt: originalModificationDate(selected.lastModified),
          mode, backend: storageBackend, code: mode === "protected" ? code : undefined
        }) }
      );
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", api("/uploads/" + init.id));
        xhr.withCredentials = true;
        xhr.setRequestHeader("X-Upload-Token", init.token);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.upload.onprogress = e => { if (e.lengthComputable) setProgress(Math.round(e.loaded / e.total * 100)); };
        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.onabort = () => reject(new Error("Upload canceled"));
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
          try { reject(new Error((JSON.parse(xhr.responseText) as { error: string }).error || "Upload failed")); }
          catch (e) { reject(e instanceof Error ? e : new Error("Upload failed")); }
        };
        xhr.send(selected);
      });
      notify(init.code ? "File uploaded · Access code: " + init.code : "File uploaded successfully");
      setSelected(null); setCode(""); setMode("public"); setProgress(0);
      const field = document.getElementById("upload-file") as HTMLInputElement | null;
      if (field) field.value = "";
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setUploading(false); }
  }

  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); notify(label + " copied"); }
    catch { setError("Copy failed. Check clipboard permissions."); }
  }

  async function reveal(record: ManagedFile) {
    if (revealed[record.id] !== undefined) {
      setRevealed(previous => { const next = { ...previous }; delete next[record.id]; return next; });
      return;
    }
    try {
      const result = await requestJson<{ code: string | null }>(api("/files/" + record.id + "/code"));
      if (result.code) setRevealed(previous => ({ ...previous, [record.id]: result.code! }));
    } catch (e) { setError((e as Error).message); }
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
    setEditId(record.id); setEditMode(record.mode); setEditCode("");
    setEditFileDuration(-1); setEditShareDuration(-1);
    setMessage(""); setError("");
  }

  async function updateRecord(event: FormEvent) {
    event.preventDefault();
    if (!editId) return;
    setSaving(true); setError("");
    try {
      await requestJson(api("/files/" + editId), {
        method: "PATCH", ...jsonBody({
          mode: editMode,
          code: editMode === "protected" && editCode.trim() ? editCode.trim() : undefined,
          fileExpiresIn: editFileDuration >= 0 ? editFileDuration : undefined,
          shareExpiresIn: editShareDuration >= 0 ? editShareDuration : undefined
        })
      });
      setVtResults(previous => { const next = { ...previous }; delete next[editId]; return next; });
      setRevealed(previous => { const next = { ...previous }; delete next[editId]; return next; });
      setEditId(null); notify("File settings updated"); await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  async function remove(record: ManagedFile) {
    if (!window.confirm('Permanently delete "' + record.filename + '"? This immediately disables the share link.')) return;
    setError("");
    try {
      await requestJson(api("/files/" + record.id), { method: "DELETE" });
      notify("Deleted " + record.filename);
      setRevealed(previous => { const next = { ...previous }; delete next[record.id]; return next; });
      await refresh();
    } catch (e) { setError((e as Error).message); }
  }

  if (auth === "checking") return <div className="grid min-h-screen place-items-center text-zinc-500">
    <LoaderCircle className="animate-spin" /></div>;

  if (auth === "guest") return <main className="relative grid min-h-screen place-items-center px-5">
    <div className="absolute right-5 top-5 z-10"><ThemeSwitcher /></div>
    <div className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,.16),transparent_70%)]" />
    <Card className="relative w-full max-w-md p-7 sm:p-10">
      <span className="mb-7 grid size-12 place-items-center rounded-2xl bg-emerald-400 text-zinc-950"><LockKeyhole size={22}/></span>
      <p className="text-xs font-semibold uppercase tracking-[.22em] text-emerald-700 dark:text-emerald-300">Private workspace</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Admin sign in</h1>
      <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">This page is for administrators only. Sign in to manage temporary files.</p>
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
            <p className="mt-0.5 text-xs text-zinc-500">Private file workspace</p>
          </div>
        </div>
        <div className="flex items-center gap-2"><ThemeSwitcher /><Button variant="ghost" onClick={logout}><LogOut size={16}/>Sign out</Button></div>
      </header>

      {message && <div role="status" className="mb-5 flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
        <Check size={17}/><span className="break-all">{message}</span>
        <button type="button" className="ml-auto shrink-0" aria-label="Dismiss notification" onClick={() => setMessage("")}><X size={16}/></button>
      </div>}
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
              <label htmlFor="upload-backend" className="mb-2 block text-sm text-zinc-700 dark:text-zinc-300">Object storage backend</label>
              {availableBackends.length ? (
                <Select id="upload-backend" value={storageBackend} disabled={uploading}
                  onValueChange={value => setStorageBackend(value as StorageBackend)}
                  options={availableBackends.map(value => ({
                    value, label: value === "r2" ? "Cloudflare R2" : "Backblaze B2",
                  }))} />
              ) : (
                <p className="rounded-xl border border-amber-400/20 bg-amber-400/10 px-3 py-3 text-sm">
                  Configure B2 or R2 in Object storage settings below before uploading.
                </p>
              )}
            </div>
            <div><label htmlFor="upload-share-expiration" className="mb-2 block text-sm text-zinc-700 dark:text-zinc-300">Share expiration</label>
              <Select id="upload-share-expiration" value={String(shareDuration)}
                onValueChange={value => setShareDuration(Number(value))}
                disabled={uploading} options={durations.map(d => ({ value: String(d.seconds), label: d.label }))} />
            </div>
            <p className="text-xs leading-5 text-zinc-500">
              Files are stored permanently by default. Share expiration only disables the public link.
              You can change file expiration later in file settings.
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
              <div className="mb-2 flex justify-between text-xs text-zinc-600 dark:text-zinc-400"><span>Upload progress</span><span>{progress}%</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: progress + "%" }}/>
              </div>
            </div>}
            <Button className="w-full" type="submit" disabled={!selected || uploading || !availableBackends.includes(storageBackend)}>
              {uploading ? <LoaderCircle size={17} className="animate-spin"/> : <FileUp size={17}/>}
              {uploading ? "Uploading…" : "Upload and create share link"}
            </Button>
          </form>
        </Card>
        <Card className="flex flex-col justify-between p-6 sm:p-8">
          <div>
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300"><ShieldCheck size={21}/><span className="font-semibold">Private storage</span></div>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight">{files.length} <span className="text-lg font-normal text-zinc-500">files</span></h2>
            <p className="mt-3 text-sm leading-7 text-zinc-600 dark:text-zinc-400">
              Your files are stored privately. Only administrators can upload, reveal access codes, change settings, or delete files.
              The admin entry is not linked from public pages.
            </p>
          </div>
          <div className="mt-7 space-y-3 border-t border-zinc-200 dark:border-white/10 pt-6 text-sm text-zinc-600 dark:text-zinc-400">
            <div className="flex items-center justify-between"><span>Storage used (listed files)</span>
              <span className="font-medium text-zinc-900 dark:text-zinc-100">{sizeText(files.reduce((sum, f) => sum + f.size, 0))}</span></div>
            <div className="flex items-center justify-between"><span>File cleanup</span><Badge>Every 6 hours</Badge></div>
            <div className="flex items-center justify-between"><span>Share links</span><Badge variant="muted">Configurable expiry</Badge></div>
          </div>
        </Card>
      </section>

      <section className="mt-10">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-xl font-semibold">File management</h2><p className="mt-1 text-sm text-zinc-500">View, share, and manage temporary files</p></div>
          <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={loadingFiles}>
            {loadingFiles ? <LoaderCircle size={15} className="animate-spin"/> : <Clock3 size={15}/>}
            Refresh list
          </Button>
        </div>
        <div className="space-y-4">
          {listTruncated && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">Only the first 500 files are listed.</p>}
          {!loadingFiles && !files.length && <Card className="py-16 text-center text-sm text-zinc-500">No files yet. Uploaded files will appear here.</Card>}
          {files.map(record => <Card key={record.id} className="p-5 sm:p-6">
            <div className="flex flex-col justify-between gap-5 md:flex-row md:items-start">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all text-base font-medium">{record.filename}</span>
                  <Badge variant="muted">{record.backend.toUpperCase()}</Badge>
                  <Badge variant={record.mode === "protected" ? "default" : "muted"}>
                    {record.mode === "protected" ? <><KeyRound size={12} className="mr-1"/>Access code</> : "Public"}
                  </Badge>
                </div>
                <p className="mt-2 text-xs text-zinc-500">{sizeText(record.size)} · {new Date(record.createdAt).toLocaleString("en-US")}</p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                  <span>File: {timeText(record.fileExpiresAt)}</span>
                  <span>Share: {timeText(record.shareExpiresAt)}</span>
                </div>
                {record.mode === "protected" && <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-zinc-500">Access code:</span>
                  <code className="min-w-20 rounded-lg bg-zinc-100 dark:bg-zinc-950 px-3 py-1.5 text-emerald-700 dark:text-emerald-300">
                    {revealed[record.id] ?? "••••••••"}
                  </code>
                  <Button size="icon" variant="ghost" aria-label={revealed[record.id] ? "Hide access code" : "Reveal access code"}
                    onClick={() => void reveal(record)}>
                    {revealed[record.id] ? <EyeOff size={16}/> : <Eye size={16}/>}
                  </Button>
                  {revealed[record.id] && <Button size="icon" variant="ghost" aria-label="Copy access code"
                    onClick={() => void copy(revealed[record.id], "Access code")}><Copy size={16}/></Button>}
                </div>}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {shareableId(record.id) ?
                  <Button size="sm" variant="secondary" onClick={() => void copy(shareLink(record.id), "Share link")}><Link2 size={15}/>Share</Button> :
                  <Badge variant="muted">Legacy link unavailable</Badge>}
                <a className={buttonStyles({ variant: "secondary", size: "sm" })} href={api("/files/" + record.id + "/download")}>
                  <ArrowDownToLine size={15}/>Download
                </a>
                {record.checksums && <Button size="sm" variant="ghost" onClick={() => void checkVirusTotal(record)} disabled={vtLoading !== null}>
                  {vtLoading === record.id ? <LoaderCircle size={15} className="animate-spin"/> : <ShieldAlert size={15}/>}
                  VirusTotal
                </Button>}
                <Button size="sm" variant="ghost" onClick={() => editId === record.id ? setEditId(null) : beginEdit(record)}>Settings</Button>
                <Button size="icon" variant="destructive" aria-label="Delete file" onClick={() => void remove(record)}><Trash2 size={16}/></Button>
              </div>
            </div>
            {vtResults[record.id] && <div role="status" className="mt-4 rounded-xl border border-zinc-200 bg-zinc-100/80 px-4 py-3 text-sm text-zinc-700 dark:border-white/10 dark:bg-zinc-950/60 dark:text-zinc-300">
              <div className="flex items-center gap-2 font-medium"><ShieldAlert size={16} aria-hidden="true" />SHA-256 reputation lookup</div>
              <p className="mt-2">{virusTotalSummary(vtResults[record.id])}</p>
              {vtResults[record.id].scanDate && <p className="mt-1 text-xs text-zinc-500">Last analysis: {new Date(vtResults[record.id].scanDate! * 1000).toLocaleString("en-US")}</p>}
            </div>}
            {editId === record.id && <form className="mt-5 space-y-4 rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-100/80 dark:bg-black/20 p-4" onSubmit={updateRecord}>
              <h3 className="text-sm font-semibold">Edit share settings</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <div><label htmlFor="edit-access" className="text-xs text-zinc-600 dark:text-zinc-400">Download access</label>
                  <Select id="edit-access" className="mt-2" value={editMode} onValueChange={value => setEditMode(value as Mode)}
                    options={[
                      { value: "public", label: "Public link" },
                      { value: "protected", label: "Access code protected" },
                    ]} />
                </div>
                <div><label htmlFor="edit-file-expiration" className="text-xs text-zinc-600 dark:text-zinc-400">File expiration</label>
                  <Select id="edit-file-expiration" className="mt-2" value={String(editFileDuration)}
                    onValueChange={value => setEditFileDuration(Number(value))}
                    options={[
                      { value: "-1", label: "Keep unchanged" },
                      ...durations.map(d => ({ value: String(d.seconds), label: d.label + " (from now)" })),
                    ]} />
                </div>
                <div><label htmlFor="edit-share-expiration" className="text-xs text-zinc-600 dark:text-zinc-400">Share expiration</label>
                  <Select id="edit-share-expiration" className="mt-2" value={String(editShareDuration)}
                    onValueChange={value => setEditShareDuration(Number(value))}
                    options={[
                      { value: "-1", label: "Keep unchanged" },
                      ...durations.map(d => ({ value: String(d.seconds), label: d.label + " (from now)" })),
                    ]} />
                </div>
              </div>
              {editMode === "protected" && <label className="block text-xs text-zinc-600 dark:text-zinc-400">
                New access code (leave blank to keep existing; generated when switching from public)
                <Input className="mt-2" value={editCode} onChange={e => setEditCode(e.target.value)}
                  minLength={4} maxLength={64} autoComplete="off" placeholder="Leave blank to keep current"/>
              </label>}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditId(null)}>Cancel</Button>
              </div>
            </form>}
          </Card>)}
        </div>
      </section>
      <AdminSettings api={api} onSaved={() => void refresh()} />
    </div>
  </main>;
}
