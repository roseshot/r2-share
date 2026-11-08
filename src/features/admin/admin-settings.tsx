import { useEffect, useState, type FormEvent } from "react";
import { Button, Card, Input, Select } from "../../components/ui";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { successToast } from "../../components/notifications";
import type { StorageBackend } from "../../lib/api";

type StorageSummary =
  | { id: string; backend: "b2"; bucket: string; region: string; keyId: string }
  | { id: string; backend: "r2"; bucket: string; accountId: string; accessKeyId: string }
  | { id: string; backend: "s3"; bucket: string; region: string; accessKeyId: string };

interface CurrentSettings {
  storages: StorageSummary[];
  virusTotalEnabled: boolean;
}

type StorageForm = {
  id: string; backend: StorageBackend; bucket: string;
  region: string; keyId: string; applicationKey: string;
  accountId: string; accessKeyId: string; secretAccessKey: string;
};
const emptyForm: StorageForm = {
  id: "", backend: "b2", bucket: "", region: "", keyId: "", applicationKey: "",
  accountId: "", accessKeyId: "", secretAccessKey: "",
};

export default function AdminSettings({ api, onSaved }: {
  api: (path: string) => string; onSaved?: () => void;
}) {
  const [current, setCurrent] = useState<CurrentSettings | null>(null);
  const [form, setForm] = useState<StorageForm>(emptyForm);
  const [editing, setEditing] = useState<string | null>(null);
  const [virusTotalKey, setVirusTotalKey] = useState("");
  const [error, setError] = useState("");
  const [confirmStorage, setConfirmStorage] = useState<StorageSummary | null>(null);
  const [removeError, setRemoveError] = useState("");
  const [saving, setSaving] = useState(false);

  const change = (key: keyof StorageForm) => (value: string) =>
    setForm(previous => ({ ...previous, [key]: value }));

  async function reload() {
    const response = await fetch(api("/settings"), { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to load settings");
    setCurrent(await response.json() as CurrentSettings);
    onSaved?.();
  }

  useEffect(() => {
    void reload().catch(reason =>
      setError(reason instanceof Error ? reason.message : "Unable to load settings"));
  }, [api]);

  function edit(storage: StorageSummary) {
    setEditing(storage.id);
    setForm({
      ...emptyForm, ...storage,
      ...(storage.backend === "b2"
        ? { region: storage.region, keyId: storage.keyId }
        : storage.backend === "s3"
          ? { region: storage.region, accessKeyId: storage.accessKeyId }
          : { accountId: storage.accountId, accessKeyId: storage.accessKeyId }),
    });
    setError("");
  }

  async function send(url: string, method: string, data?: object) {
    const response = await fetch(url, {
      method, cache: "no-store",
      headers: data ? { "Content-Type": "application/json" } : {},
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error || "Unable to save storage settings");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setError("");
    try {
      const config = form.backend === "b2"
        ? { bucket: form.bucket, region: form.region, keyId: form.keyId,
          ...(form.applicationKey ? { applicationKey: form.applicationKey } : {}) }
        : form.backend === "s3"
          ? { bucket: form.bucket, region: form.region, accessKeyId: form.accessKeyId,
            ...(form.secretAccessKey ? { secretAccessKey: form.secretAccessKey } : {}) }
          : { bucket: form.bucket, accountId: form.accountId, accessKeyId: form.accessKeyId,
            ...(form.secretAccessKey ? { secretAccessKey: form.secretAccessKey } : {}) };
      await send(api("/settings/storages" + (editing ? "/" + editing : "")),
        editing ? "PATCH" : "POST",
        editing ? config : { id: form.id, backend: form.backend, ...config });
      setEditing(null); setForm(emptyForm);
      await reload();
      successToast("Storage configuration saved");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save storage");
    } finally { setSaving(false); }
  }

  async function remove(storage: StorageSummary) {
    setSaving(true); setRemoveError("");
    try {
      await send(api("/settings/storages/" + storage.id), "DELETE");
      if (editing === storage.id) { setEditing(null); setForm(emptyForm); }
      setConfirmStorage(null);
      await reload();
      successToast("Storage configuration removed");
    } catch (reason) {
      setRemoveError(reason instanceof Error ? reason.message : "Unable to remove storage");
    } finally { setSaving(false); }
  }

  async function saveVirusTotal(event: FormEvent) {
    event.preventDefault();
    setSaving(true); setError("");
    try {
      await send(api("/settings"), "PATCH", { virusTotalApiKey: virusTotalKey });
      setVirusTotalKey("");
      await reload();
      successToast("VirusTotal settings saved");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save VirusTotal settings");
    } finally { setSaving(false); }
  }

  return (
    <Card id="object-storage-settings" className="mt-7 scroll-mt-6 p-6 sm:p-8">
      <h2 className="text-lg font-semibold">Object storage settings</h2>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Each storage has a unique, permanent ID and independent B2, R2, or AWS S3 credentials,
        encrypted in D1. Choose the ID when uploading. Credentials can be rotated,
        but a storage in use cannot be deleted or pointed at another bucket.
      </p>
      {!current ? <p className="mt-4 text-sm text-zinc-500">Loading settings…</p> : (
        <>
          <div className="mt-6 space-y-3">
            {current.storages.length === 0 &&
              <p className="text-sm text-zinc-500">No storage configured. Add your first storage ID below to enable uploads.</p>}
            {current.storages.map(storage => (
              <div key={storage.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 p-4 dark:border-white/10">
                <div className="min-w-0">
                  <div className="font-semibold"><code>{storage.id}</code>
                    <span className="ml-2 text-xs font-normal text-zinc-500">
                      {storage.backend === "b2" ? "Backblaze B2" : storage.backend === "s3" ? "AWS S3" : "Cloudflare R2"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">{storage.bucket}</p>
                </div>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={() => edit(storage)} disabled={saving}>Edit</Button>
                  <Button type="button" size="sm" variant="destructive" onClick={() => { setConfirmStorage(storage); setRemoveError(""); }} disabled={saving}>Remove</Button>
                </div>
              </div>
            ))}
          </div>
          <form onSubmit={save} className="mt-7 space-y-4 border-t border-zinc-200 pt-6 dark:border-white/10">
            <h3 className="font-semibold">{editing ? "Edit storage: " + editing : "Add storage"}</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Storage ID" value={form.id} setValue={change("id")}
                placeholder="e.g. backup-east" disabled={editing !== null} />
              <div>
                <label htmlFor="storage-provider" className="mb-1 block text-sm font-medium">Provider</label>
                <Select id="storage-provider" value={form.backend} disabled={editing !== null}
                  onValueChange={value => change("backend")(value)}
                  options={[{ value: "b2", label: "Backblaze B2" }, { value: "r2", label: "Cloudflare R2" },
                     { value: "s3", label: "AWS S3" }]} />
              </div>
              <Field label="Bucket" value={form.bucket} setValue={change("bucket")} />
              {form.backend === "b2" ? (
                <>
                  <Field label="B2 region" value={form.region} setValue={change("region")} placeholder="us-west-004" />
                  <Field label="B2 key ID" value={form.keyId} setValue={change("keyId")} />
                  <Field label="B2 application key" value={form.applicationKey} setValue={change("applicationKey")}
                    secret placeholder={editing ? "Leave blank to keep current key" : "Required"} />
                </>
              ) : form.backend === "s3" ? (
                <>
                  <Field label="AWS region" value={form.region} setValue={change("region")} placeholder="us-east-1" />
                  <Field label="AWS access key ID" value={form.accessKeyId} setValue={change("accessKeyId")} />
                  <Field label="AWS secret access key" value={form.secretAccessKey} setValue={change("secretAccessKey")}
                    secret placeholder={editing ? "Leave blank to keep current key" : "Required"} />
                </>
              ) : (
                <>
                  <Field label="Cloudflare account ID" value={form.accountId} setValue={change("accountId")} />
                  <Field label="R2 access key ID" value={form.accessKeyId} setValue={change("accessKeyId")} />
                  <Field label="R2 secret access key" value={form.secretAccessKey} setValue={change("secretAccessKey")}
                    secret placeholder={editing ? "Leave blank to keep current key" : "Required"} />
                </>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={saving}>{saving ? "Saving…" : editing ? "Update storage" : "Add storage"}</Button>
              {editing && <Button type="button" variant="ghost" disabled={saving} onClick={() => {
                setEditing(null); setForm(emptyForm);
              }}>Cancel</Button>}
            </div>
          </form>
          <form className="mt-7 border-t border-zinc-200 pt-6 dark:border-white/10" onSubmit={saveVirusTotal}>
            <Field label="VirusTotal API key (optional)" value={virusTotalKey} setValue={setVirusTotalKey}
              secret placeholder={current.virusTotalEnabled ? "Configured; leave blank to keep" : "Optional"} />
            <div className="mt-3"><Button type="submit" disabled={saving || !virusTotalKey}>Save VirusTotal key</Button></div>
          </form>
        </>
      )}
      {error && <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-300">{error}</p>}
      <ConfirmDialog open={confirmStorage !== null}
        onOpenChange={open => { if (!open) { setConfirmStorage(null); setRemoveError(""); } }}
        title="Remove storage configuration?"
        description={confirmStorage
          ? 'Remove storage ID "' + confirmStorage.id + '"? This does not delete any bucket objects. Configurations in use cannot be removed.'
          : ""}
        confirmLabel="Remove storage" pending={saving} error={removeError}
        onConfirm={() => { if (confirmStorage) void remove(confirmStorage); }} />
    </Card>
  );
}

function Field({ label, value, setValue, secret = false, placeholder, disabled = false }: {
  label: string; value: string; setValue: (value: string) => void;
  secret?: boolean; placeholder?: string; disabled?: boolean;
}) {
  return <label className="block text-sm">
    <span className="mb-1 block font-medium">{label}</span>
    <Input aria-label={label} type={secret ? "password" : "text"} value={value} disabled={disabled}
      onChange={event => setValue(event.target.value)}
      autoComplete="off" spellCheck={false} placeholder={placeholder} />
  </label>;
}
