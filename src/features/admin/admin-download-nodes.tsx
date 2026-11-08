import { useEffect, useState, type FormEvent } from "react";
import { Button, Card, Input } from "../../components/ui";
import { successToast } from "../../components/notifications";

interface DownloadNodeSettings {
  downloadNodes: string[];
  downloadNodeSecretConfigured: boolean;
}

function newSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)),
    byte => byte.toString(16).padStart(2, "0")).join("");
}

export default function AdminDownloadNodes({ api }: { api: (path: string) => string }) {
  const [nodes, setNodes] = useState<string[]>([]);
  const [nodeUrl, setNodeUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [secretConfigured, setSecretConfigured] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch(api("/settings"), { cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("Unable to load download node settings");
      const settings = await response.json() as DownloadNodeSettings;
      if (active) {
        setNodes(settings.downloadNodes);
        setSecretConfigured(settings.downloadNodeSecretConfigured);
        setLoaded(true);
      }
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : "Unable to load settings");
    });
    return () => { active = false; };
  }, [api]);

  function addNode() {
    const value = nodeUrl.trim();
    if (nodes.length >= 16) {
      setError("A maximum of 16 download nodes is supported");
      return;
    }
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
          parsed.pathname !== "/" || parsed.search || parsed.hash || !parsed.hostname) {
        throw new Error("Enter a valid HTTPS origin without a path, query, or credentials");
      }
      if (nodes.some(node => new URL(node).host === parsed.host)) {
        throw new Error("This download node is already configured");
      }
      setNodes(previous => [...previous, parsed.origin]);
      setNodeUrl("");
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Invalid download node URL");
    }
  }

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret);
      successToast("Download node secret copied");
    } catch {
      setError("Unable to copy the secret. Select and copy it manually.");
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (nodeUrl.trim()) {
      setError("Add the entered node or clear the URL before saving");
      return;
    }
    if (nodes.length && !secretConfigured && !secret) {
      setError("Enter or generate a shared secret before enabling download nodes");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch(api("/settings/download-nodes"), {
        method: "PATCH",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes, ...(secret ? { secret } : {}) }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Unable to save download nodes");
      setSecretConfigured(secretConfigured || !!secret);
      successToast("Download nodes saved");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save download nodes");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card id="download-node-settings" className="mt-7 scroll-mt-6 p-6 sm:p-8">
      <h2 className="text-lg font-semibold">Download nodes</h2>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Offload authorized downloads to up to 16 HTTPS nodes. Bucket credentials remain
        on the Worker. Every node must use the same shared secret.
      </p>
      <form className="mt-6 space-y-5" onSubmit={save}>
        {!loaded ? <p className="text-sm text-zinc-500">Loading settings…</p> : (
          <>
            <div className="space-y-3">
              {nodes.length === 0 &&
                <p className="text-sm text-zinc-500">No download nodes configured. Downloads use the Worker.</p>}
              {nodes.map(node => (
                <div key={node} className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 p-3 dark:border-white/10">
                  <code className="min-w-0 break-all text-sm">{node}</code>
                  <Button type="button" variant="destructive" size="sm" disabled={saving}
                    onClick={() => setNodes(previous => previous.filter(value => value !== node))}>
                    Remove
                  </Button>
                </div>
              ))}
              <div className="flex flex-col gap-2 sm:flex-row">
                <label className="grow text-sm">
                  <span className="mb-1 block font-medium">Node HTTPS origin</span>
                  <Input aria-label="Node HTTPS origin" type="url" value={nodeUrl}
                    placeholder="https://dl1.example.com" spellCheck={false} autoComplete="off"
                    disabled={saving || nodes.length >= 16} onChange={event => setNodeUrl(event.target.value)} />
                </label>
                <Button type="button" variant="secondary" className="self-end" disabled={saving || !nodeUrl.trim() || nodes.length >= 16}
                  onClick={addNode}>Add node</Button>
              </div>
              <p className="text-xs text-zinc-500">Each node must load a TLS certificate and configure NODE_DOMAIN to match this HTTPS origin exactly, including any custom port.</p>
            </div>
            <div className="space-y-3 border-t border-zinc-200 pt-5 dark:border-white/10">
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Shared secret</span>
                <Input aria-label="Download node shared secret" value={secret}
                  type={showSecret ? "text" : "password"} autoComplete="off" spellCheck={false}
                  placeholder={secretConfigured ? "Configured; leave blank to keep" : "Enter or generate at least 32 characters"}
                  disabled={saving} onChange={event => setSecret(event.target.value)} />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" disabled={saving}
                  onClick={() => { setSecret(newSecret()); setShowSecret(true); }}>
                  Generate secret
                </Button>
                <Button type="button" variant="secondary" disabled={!secret}
                  onClick={() => setShowSecret(previous => !previous)}>
                  {showSecret ? "Hide secret" : "Show secret"}
                </Button>
                <Button type="button" variant="secondary" disabled={!secret}
                  onClick={() => void copySecret()}>
                  Copy secret
                </Button>
              </div>
              <p className="text-xs text-zinc-500">
                {secretConfigured ? "A secret is saved. Entering a new one rotates it for all nodes." :
                  "No secret is saved yet."} The secret is encrypted in D1 and cannot be retrieved after leaving this page.
                Copy it to each node as DOWNLOAD_NODE_SECRET before enabling downloads.
              </p>
            </div>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save download nodes"}</Button>
          </>
        )}
      </form>
      {error && <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-300">{error}</p>}
    </Card>
  );
}
