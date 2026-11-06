import { useEffect, useState, type FormEvent } from "react";
import { Button, Card, Input } from "./ui";

interface CurrentSettings {
  configured: boolean;
  b2Configured: boolean;
  r2Configured: boolean;
  b2Bucket: string;
  b2Region: string;
  b2KeyId: string;
  r2AccountId: string;
  r2Bucket: string;
  r2AccessKeyId: string;
  virusTotalEnabled: boolean;
}

export default function AdminSettings({ api, onSaved }: {
  api: (path: string) => string;
  onSaved?: () => void;
}) {
  const [current, setCurrent] = useState<CurrentSettings | null>(null);
  const [form, setForm] = useState({
    b2Bucket: "", b2Region: "", b2KeyId: "", b2ApplicationKey: "",
    r2AccountId: "", r2Bucket: "", r2AccessKeyId: "", r2SecretAccessKey: "",
    virusTotalApiKey: "",
  });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const change = (key: keyof typeof form) => (value: string) => {
    setForm(previous => ({ ...previous, [key]: value }));
  };

  useEffect(() => {
    fetch(api("/settings"), { cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("Unable to load settings");
        return response.json() as Promise<CurrentSettings>;
      })
      .then(settings => {
        setCurrent(settings);
        setForm(previous => ({
          ...previous,
          b2Bucket: settings.b2Bucket, b2Region: settings.b2Region, b2KeyId: settings.b2KeyId,
          r2AccountId: settings.r2AccountId, r2Bucket: settings.r2Bucket,
          r2AccessKeyId: settings.r2AccessKeyId,
        }));
      })
      .catch(reason => setError(reason instanceof Error ? reason.message : "Unable to load settings"));
  }, [api]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!current || saving) return;
    setSaving(true); setError(""); setMessage("");
    try {
      const changes: Record<string, string> = {};
      for (const key of ["b2Bucket", "b2Region", "b2KeyId",
        "r2AccountId", "r2Bucket", "r2AccessKeyId"] as const) {
        if (form[key] !== current[key]) changes[key] = form[key];
      }
      for (const key of ["b2ApplicationKey", "r2SecretAccessKey", "virusTotalApiKey"] as const) {
        if (form[key]) changes[key] = form[key];
      }
      if (!Object.keys(changes).length) {
        setMessage("No changes to save");
        return;
      }
      const response = await fetch(api("/settings"), {
        method: "PATCH", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Unable to save settings");
      const updated = await fetch(api("/settings"), { cache: "no-store" });
      if (!updated.ok) throw new Error("Configuration saved, but unable to refresh settings");
      const latest = await updated.json() as CurrentSettings;
      setCurrent(latest);
      setForm(previous => ({
        ...previous, b2ApplicationKey: "", r2SecretAccessKey: "", virusTotalApiKey: "",
      }));
      setMessage("Storage configuration saved");
      onSaved?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mt-7 p-6 sm:p-8">
      <h2 className="text-lg font-semibold">Object storage settings</h2>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Configure Backblaze B2 and Cloudflare R2 independently. Credentials are encrypted in D1;
        the administrator path and password remain Worker Secrets.
        Leave saved secret fields blank to keep their current values.
      </p>
      {!current ? <p className="mt-4 text-sm text-zinc-500">Loading settings…</p> : (
        <form onSubmit={save} className="mt-6 space-y-7">
          <section>
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="font-semibold">Backblaze B2</h3>
              <span className="text-xs text-zinc-500">{current.b2Configured ? "Ready" : "Not configured"}</span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Bucket" value={form.b2Bucket} setValue={change("b2Bucket")} />
              <Field label="Region" value={form.b2Region} setValue={change("b2Region")} placeholder="us-west-004" />
              <Field label="Application key ID" value={form.b2KeyId} setValue={change("b2KeyId")} />
              <Field label="Application key" value={form.b2ApplicationKey} setValue={change("b2ApplicationKey")}
                secret placeholder={current.b2Configured ? "Leave blank to keep current" : "Required to configure B2"} />
            </div>
          </section>
          <section className="border-t border-zinc-200 pt-6 dark:border-white/10">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="font-semibold">Cloudflare R2</h3>
              <span className="text-xs text-zinc-500">{current.r2Configured ? "Ready" : "Not configured"}</span>
            </div>
            <p className="mb-4 text-xs text-zinc-500">
              Use an R2 S3 API token with access to the selected bucket. No extra Worker binding is required.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Cloudflare account ID" value={form.r2AccountId}
                setValue={change("r2AccountId")} placeholder="32-character account ID" />
              <Field label="R2 bucket" value={form.r2Bucket} setValue={change("r2Bucket")} />
              <Field label="R2 access key ID" value={form.r2AccessKeyId} setValue={change("r2AccessKeyId")} />
              <Field label="R2 secret access key" value={form.r2SecretAccessKey}
                setValue={change("r2SecretAccessKey")} secret
                placeholder={current.r2Configured ? "Leave blank to keep current" : "Required to configure R2"} />
            </div>
          </section>
          <section className="border-t border-zinc-200 pt-6 dark:border-white/10">
            <Field label="VirusTotal API key (optional)" value={form.virusTotalApiKey}
              setValue={change("virusTotalApiKey")} secret
              placeholder={current.virusTotalEnabled ? "Configured; leave blank to keep current" : "Optional"} />
          </section>
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save settings"}</Button>
        </form>
      )}
      {error && <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-300">{error}</p>}
      {message && <p role="status" className="mt-4 text-sm text-emerald-700 dark:text-emerald-300">{message}</p>}
    </Card>
  );
}

function Field({ label, value, setValue, secret = false, placeholder }: {
  label: string; value: string; setValue: (value: string) => void;
  secret?: boolean; placeholder?: string;
}) {
  return <label className="block text-sm">
    <span className="mb-1 block font-medium">{label}</span>
    <Input type={secret ? "password" : "text"} value={value}
      onChange={event => setValue(event.target.value)}
      autoComplete="off" spellCheck={false} placeholder={placeholder} />
  </label>;
}
