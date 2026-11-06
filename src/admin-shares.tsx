import { useState, type FormEvent } from "react";
import { Badge, Button, Input, Select } from "./ui";
import { durations, jsonBody, requestJson, timeText, type ManagedShare, type Mode } from "./lib";

export default function AdminShares({ fileId, shares, api, onSaved, onError }: {
  fileId: string;
  shares: ManagedShare[];
  api: (path: string) => string;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("public");
  const [duration, setDuration] = useState(86400);
  const [code, setCode] = useState("");
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const endpoint = (id?: string) => api("/files/" + fileId + "/shares" + (id ? "/" + id : ""));
  const url = (id: string) => location.origin + "/" + id;

  function reset() {
    setCreating(false); setEditing(null); setMode("public"); setCode(""); setDuration(86400);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); onError(""); setMessage("");
    try {
      const changing = editing !== null;
      const result = await requestJson<{ share: ManagedShare; code: string | null }>(
        endpoint(editing ?? undefined), {
          method: changing ? "PATCH" : "POST",
          ...jsonBody({
            mode, code: mode === "protected" && code.trim() ? code.trim() : undefined,
            shareExpiresIn: duration >= 0 ? duration : undefined,
          }),
        }
      );
      reset();
      if (result.code) {
        setRevealed(previous => ({ ...previous, [result.share.id]: result.code! }));
        setMessage("Link saved. Access code: " + result.code);
      } else {
        setMessage("Share link saved");
      }
      await onSaved();
    } catch (error) { onError((error as Error).message); }
    finally { setBusy(false); }
  }

  async function reveal(share: ManagedShare) {
    if (revealed[share.id]) {
      setRevealed(previous => { const next = { ...previous }; delete next[share.id]; return next; });
      return;
    }
    try {
      const result = await requestJson<{ code: string | null }>(endpoint(share.id) + "/code");
      if (result.code) setRevealed(previous => ({ ...previous, [share.id]: result.code! }));
    } catch (error) { onError((error as Error).message); }
  }

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setMessage("Copied to clipboard"); }
    catch { onError("Could not copy to clipboard"); }
  }

  async function remove(share: ManagedShare) {
    if (!window.confirm("Revoke this share link? The file and its other links will remain.")) return;
    setBusy(true); onError(""); setMessage("");
    try {
      await requestJson(endpoint(share.id), { method: "DELETE" });
      setRevealed(previous => { const next = { ...previous }; delete next[share.id]; return next; });
      setMessage("Share link revoked");
      if (editing === share.id) reset();
      await onSaved();
    } catch (error) { onError((error as Error).message); }
    finally { setBusy(false); }
  }

  function edit(share: ManagedShare) {
    setCreating(false);
    setEditing(share.id);
    setMode(share.mode);
    setCode("");
    setDuration(-1);
    setMessage("");
  }

  const isFormOpen = creating || editing !== null;

  return <section className="mt-5 border-t border-zinc-200 pt-5 dark:border-white/10" aria-label="Share links">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="text-sm font-semibold">Share links ({shares.length})</h3>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => {
        reset(); setCreating(true); setMessage("");
      }}>Create share link</Button>
    </div>
    <div className="mt-3 space-y-3">
      {shares.length === 0 && <p className="text-sm text-zinc-500">No active share links for this file.</p>}
      {shares.map(share => <div key={share.id}
        className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 dark:border-white/10 dark:bg-zinc-950/40">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <code className="break-all text-xs">{share.id}</code>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <Badge variant={share.mode === "protected" ? "default" : "muted"}>
                {share.mode === "protected" ? "Access code" : "Public"}
              </Badge>
              <span>Expires: {timeText(share.shareExpiresAt)}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => void copy(url(share.id))}>Copy link</Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy}
              onClick={() => edit(share)}>Edit</Button>
            <Button type="button" size="sm" variant="destructive" disabled={busy}
              onClick={() => void remove(share)}>Revoke</Button>
          </div>
        </div>
        {share.mode === "protected" && <div className="mt-2 flex items-center gap-2 text-xs">
          <span>Code: <code>{revealed[share.id] ?? "••••••••"}</code></span>
          <Button size="sm" variant="ghost" onClick={() => void reveal(share)}>
            {revealed[share.id] ? "Hide" : "Reveal"}
          </Button>
        </div>}
      </div>)}
    </div>
    {isFormOpen && <form onSubmit={submit} className="mt-4 space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-white/10">
      <h4 className="text-sm font-semibold">{editing ? "Edit share link" : "New share link"}</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label className="mb-1 block text-xs" htmlFor={"share-mode-" + fileId}>Access</label>
          <Select id={"share-mode-" + fileId} value={mode}
            onValueChange={value => setMode(value as Mode)} options={[
              { value: "public", label: "Public link" },
              { value: "protected", label: "Access code required" },
            ]} />
        </div>
        <div><label className="mb-1 block text-xs" htmlFor={"share-expiry-" + fileId}>Expiration</label>
          <Select id={"share-expiry-" + fileId} value={String(duration)}
            onValueChange={value => setDuration(Number(value))} options={[
              ...(editing ? [{ value: "-1", label: "Keep unchanged" }] : []),
              ...durations.map(item => ({ value: String(item.seconds), label: item.label })),
            ]} />
        </div>
      </div>
      {mode === "protected" && <label className="block text-xs">
        Access code (leave blank to {editing ? "keep existing or generate" : "generate"})
        <Input className="mt-1" value={code} onChange={event => setCode(event.target.value)}
          minLength={4} maxLength={64} autoComplete="off" />
      </label>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>{busy ? "Saving…" : "Save link"}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={reset}>Cancel</Button>
      </div>
    </form>}
    {message && <p role="status" className="mt-3 break-all text-xs text-emerald-700 dark:text-emerald-300">{message}</p>}
  </section>;
}
