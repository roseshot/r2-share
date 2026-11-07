import { useEffect, useState, type FormEvent } from "react";
import { Copy, Link2, LoaderCircle, Trash2 } from "lucide-react";
import { Badge, Button, Card, Input, Select } from "./ui";
import { ConfirmDialog } from "./confirm-dialog";
import { successToast } from "./notifications";
import { durations, jsonBody, requestJson } from "./lib";

type UploadPage = {
  id: string; label: string; storageId: string; expiresAt: string | null;
  maxUploads: number | null; completedUploads: number; createdAt: string;
};

export default function AdminPublicUploads({ api, storageIds }: {
  api: (path: string) => string; storageIds: string[];
}) {
  const [pages, setPages] = useState<UploadPage[]>([]);
  const [label, setLabel] = useState("");
  const [storageId, setStorageId] = useState("");
  const [expiresIn, setExpiresIn] = useState(86400);
  const [maxUploads, setMaxUploads] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmPage, setConfirmPage] = useState<UploadPage | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [recentId, setRecentId] = useState("");

  async function refresh() {
    const response = await requestJson<{ pages: UploadPage[] }>(api("/public-uploads"));
    setPages(response.pages);
  }
  useEffect(() => {
    void refresh().catch(reason => setError((reason as Error).message)).finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    setStorageId(previous => storageIds.includes(previous) ? previous : (storageIds[0] ?? ""));
  }, [storageIds.join(",")]);

  const link = (id: string) => location.origin + "/upload/" + id;
  async function copy(id: string) {
    try { await navigator.clipboard.writeText(link(id)); successToast("Upload link copied"); }
    catch { setError("Clipboard access failed"); }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (saving || !storageIds.includes(storageId)) return;
    const count = maxUploads.trim() === "" ? null : Number(maxUploads);
    if ((count !== null && (!Number.isSafeInteger(count) || count < 1 || count > 1000)) ||
        (expiresIn === 0 && count === null)) {
      setError("Set an expiration time or a maximum upload count (1–1000)");
      return;
    }
    setSaving(true); setError("");
    try {
      const response = await requestJson<{ page: UploadPage }>(api("/public-uploads"), {
        method: "POST", ...jsonBody({ label: label.trim(), storageId, expiresIn, maxUploads: count }),
      });
      setRecentId(response.page.id);
      setLabel(""); setMaxUploads("");
      await refresh();
      successToast("Public upload page created");
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }

  async function revoke() {
    if (!confirmPage) return;
    setSaving(true); setDeleteError("");
    try {
      await requestJson(api("/public-uploads/" + confirmPage.id), { method: "DELETE" });
      setConfirmPage(null);
      await refresh();
      successToast("Public upload page revoked");
    } catch (cause) { setDeleteError((cause as Error).message); }
    finally { setSaving(false); }
  }

  return <Card className="mt-8 p-6 sm:p-8">
    <div className="flex items-center gap-2"><Link2 className="text-emerald-700 dark:text-emerald-300" size={22}/>
      <h2 className="text-lg font-semibold">Public upload pages</h2></div>
    <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
      Let anyone with a link upload files privately. Time limits and successful-upload quotas
      automatically disable a page. Uploaded files appear in File management.
    </p>
    <form onSubmit={event => { void create(event); }} className="mt-6 grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <label htmlFor="public-page-label" className="mb-1 block text-sm">Page title</label>
        <Input id="public-page-label" maxLength={100} required value={label}
          onChange={event => setLabel(event.target.value)} placeholder="Send us your files"/>
      </div>
      <div>
        <label htmlFor="public-page-storage" className="mb-1 block text-sm">Destination storage</label>
        <Select id="public-page-storage" value={storageId} onValueChange={setStorageId}
          options={storageIds.map(id => ({ value: id, label: id }))} disabled={!storageIds.length || saving}/>
      </div>
      <div>
        <label htmlFor="public-page-expiry" className="mb-1 block text-sm">Link expires after</label>
        <Select id="public-page-expiry" value={String(expiresIn)} disabled={saving}
          onValueChange={value => setExpiresIn(Number(value))}
          options={durations.map(item => ({ value: String(item.seconds), label: item.label }))}/>
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="public-page-max" className="mb-1 block text-sm">Maximum successful uploads (optional)</label>
        <Input id="public-page-max" type="number" min={1} max={1000} step={1} value={maxUploads}
          onChange={event => setMaxUploads(event.target.value)} placeholder="Unlimited"/>
        <p className="mt-1 text-xs text-zinc-500">Set at least one limit. Each successfully uploaded file or ZIP counts once.</p>
      </div>
      <Button type="submit" className="sm:col-span-2" disabled={saving || !storageIds.length || !label.trim()}>
        {saving && <LoaderCircle size={16} className="animate-spin"/>}
        {saving ? "Creating…" : "Create public upload link"}
      </Button>
    </form>
    {error && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
    {recentId && <div className="mt-5 rounded-xl border border-emerald-400/30 bg-emerald-400/5 p-4">
      <p className="text-sm font-medium">New upload link</p>
      <code className="mt-2 block break-all text-xs">{link(recentId)}</code>
      <Button size="sm" variant="secondary" className="mt-3" onClick={() => void copy(recentId)}>
        <Copy size={15}/>Copy link
      </Button>
    </div>}
    <h3 className="mt-8 font-medium">Created upload pages</h3>
    {loading ? <p role="status" className="mt-3 text-sm text-zinc-500">Loading…</p> :
      pages.length === 0 ? <p className="mt-3 text-sm text-zinc-500">No public upload links yet.</p> :
      <ul className="mt-3 space-y-3">
        {pages.map(page => {
          const expired = page.expiresAt !== null && Date.parse(page.expiresAt) <= Date.now();
          const full = page.maxUploads !== null && page.completedUploads >= page.maxUploads;
          return <li key={page.id} className="rounded-xl border border-zinc-200 p-4 dark:border-white/10">
            <div className="flex flex-wrap items-center gap-2">
              <span className="break-words text-sm font-semibold">{page.label}</span>
              <Badge variant="muted">{page.storageId}</Badge>
              <Badge variant={expired || full ? "muted" : "default"}>{expired ? "Expired" : full ? "Limit reached" : "Active"}</Badge>
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              {page.completedUploads} uploaded · {page.maxUploads === null ? "Unlimited" : page.maxUploads + " max"}
              {" · " + (page.expiresAt ? "Expires " + new Date(page.expiresAt).toLocaleString() : "No time limit")}
            </p>
            <code className="mt-2 block break-all text-xs">{link(page.id)}</code>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void copy(page.id)}>
                <Copy size={14}/>Copy link</Button>
              <a className="inline-flex items-center rounded-xl border border-zinc-200 px-3 py-1 text-sm dark:border-white/15"
                href={"/upload/" + page.id} target="_blank" rel="noopener noreferrer">Open</a>
              <Button size="sm" variant="destructive" onClick={() => { setConfirmPage(page); setDeleteError(""); }}>
                <Trash2 size={14}/>Revoke</Button>
            </div>
          </li>;
        })}
      </ul>}
    <ConfirmDialog open={confirmPage !== null} onOpenChange={open => { if (!open) setConfirmPage(null); }}
      title="Revoke public upload link?" description="The link will stop accepting new files. Existing uploaded files remain."
      confirmLabel="Revoke link" pending={saving} error={deleteError}
      onConfirm={() => { void revoke(); }} />
  </Card>;
}
