import { dataKey, expired, validChecksums, validSha256, type Bindings, type FileRecord } from "./model";
import { getObjectStore } from "./object-store";
import { getRecord } from "./storage";

export interface VirusTotalResult {
  status: "found" | "pending" | "not_found" | "not_configured" | "rate_limited" | "unavailable";
  malicious?: number;
  suspicious?: number;
  harmless?: number;
  undetected?: number;
  scanDate?: number | null;
}

const validScore = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** Fetch a report by SHA-256 only; no bytes or share URLs are sent. */
export async function getVirusTotalReport(
  sha256: string,
  apiKey: string | undefined,
  request: typeof fetch = fetch,
): Promise<VirusTotalResult> {
  if (!apiKey) return { status: "not_configured" };
  if (!/^[a-f0-9]{64}$/.test(sha256)) return { status: "unavailable" };
  try {
    const response = await request("https://www.virustotal.com/api/v3/files/" + sha256, {
      method: "GET",
      headers: { "x-apikey": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 404) return { status: "not_found" };
    if (response.status === 429) return { status: "rate_limited" };
    if (!response.ok) return { status: "unavailable" };
    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || !("data" in result)) return { status: "unavailable" };
    const data = result.data;
    if (!data || typeof data !== "object" || !("attributes" in data)) return { status: "unavailable" };
    const attrs = data.attributes;
    if (!attrs || typeof attrs !== "object" || !("last_analysis_stats" in attrs)) return { status: "unavailable" };
    const stats = attrs.last_analysis_stats;
    if (!stats || typeof stats !== "object") return { status: "unavailable" };
    const scores = stats as Record<string, unknown>;
    const scanDate = "last_analysis_date" in attrs ? attrs.last_analysis_date : null;
    return {
      status: "found",
      malicious: validScore(scores.malicious),
      suspicious: validScore(scores.suspicious),
      harmless: validScore(scores.harmless),
      undetected: validScore(scores.undetected),
      scanDate: typeof scanDate === "number" && Number.isFinite(scanDate) ? scanDate : null,
    };
  } catch {
    return { status: "unavailable" };
  }
}


// The queue is keyed by file content, not public share IDs. Upload transactions
// add jobs only after a verified SHA-256 exists; successful hashes are never requeued.
export function queueVirusTotalStatement(env: Bindings, sha256: string) {
  if (!validSha256(sha256)) throw new Error("Invalid VirusTotal SHA-256");
  return env.DB.prepare(
    "INSERT OR IGNORE INTO virustotal_queue (sha256, enqueued_at, next_attempt_at, attempts) " +
    "SELECT ?, ?, 0, 0 WHERE NOT EXISTS " +
    "(SELECT 1 FROM virustotal_reports WHERE sha256 = ?)"
  ).bind(sha256, Date.now(), sha256);
}

/** Read the immutable successful report from D1; this never calls VirusTotal. */
export async function getCachedVirusTotalReport(env: Bindings, sha256: string): Promise<VirusTotalResult> {
  if (!validSha256(sha256)) return { status: "unavailable" };
  const row = await env.DB.prepare("SELECT report_json FROM virustotal_reports WHERE sha256 = ?")
    .bind(sha256).first<{ report_json: string }>();
  if (!row) return { status: "pending" };
  try {
    const parsed: unknown = JSON.parse(row.report_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "unavailable" };
    const report = parsed as VirusTotalResult;
    if (report.status !== "found" ||
        ![report.malicious, report.suspicious, report.harmless, report.undetected]
          .every(n => Number.isSafeInteger(n) && (n as number) >= 0)) {
      return { status: "unavailable" };
    }
    return report;
  } catch {
    return { status: "unavailable" };
  }
}

export type VirusTotalUploadResult = "submitted" | "rate_limited" | "unavailable";

// Stream the exact bytes stored in the private bucket. The browser never receives
// the VirusTotal API key or file bytes through this operation.
function multipartBody(source: ReadableStream<Uint8Array>, filename: string, boundary: string, size: number) {
  const safeName = filename.replace(/[^a-zA-Z0-9_. -]/g, "_") || "sample";
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
    "Content-Type: application/octet-stream\r\n\r\n"
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const reader = source.getReader();
  let phase = 0;
  let received = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (phase === 0) { phase = 1; controller.enqueue(prefix); return; }
      if (phase === 1) {
        const next = await reader.read();
        if (!next.done) {
          received += next.value.byteLength;
          if (received > size) {
            controller.error(new Error("Stored object exceeds recorded file size"));
            await reader.cancel();
            return;
          }
          controller.enqueue(next.value);
          return;
        }
        if (received !== size) {
          controller.error(new Error("Stored object length differs from file record"));
          return;
        }
        phase = 2;
      }
      controller.enqueue(suffix);
      controller.close();
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
  return { stream, length: prefix.byteLength + size + suffix.byteLength };
}

function virusTotalUploadUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    // VirusTotal sometimes returns http:// in documented upload_url examples;
    // always upgrade to HTTPS before sending an API key or file bytes.
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:" || url.hostname !== "www.virustotal.com" ||
        url.username || url.password || url.port || !url.pathname.startsWith("/_ah/upload/"))
      return null;
    return url.toString();
  } catch { return null; }
}

export async function submitAuthorizedVirusTotalFile(
  env: Bindings, record: FileRecord, apiKey: string,
  request: typeof fetch = fetch,
): Promise<VirusTotalUploadResult> {
  if (!validChecksums(record.checksums) || expired(record)) return "unavailable";
  let source: ReadableStream<Uint8Array> | undefined;
  try {
    const object = await getObjectStore(env, record.storageId).get(dataKey(record.id));
    if (!object || object.size !== record.size) {
      await object?.body.cancel();
      return "unavailable";
    }
    source = object.body;
    let endpoint = "https://www.virustotal.com/api/v3/files";
    if (record.size > 32 * 1024 * 1024) {
      const urlReply = await request("https://www.virustotal.com/api/v3/files/upload_url", {
        method: "GET", headers: { "x-apikey": apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(15000), redirect: "error",
      });
      if (urlReply.status === 429) return "rate_limited";
      if (!urlReply.ok) return "unavailable";
      const payload: unknown = await urlReply.json();
      const raw = payload && typeof payload === "object" && "data" in payload ? payload.data : null;
      const validated = virusTotalUploadUrl(raw);
      if (!validated) return "unavailable";
      endpoint = validated;
    }
    const boundary = "tuckbox-" + crypto.randomUUID();
    const { stream, length } = multipartBody(source, record.filename, boundary, record.size);
    source = undefined;
    // FixedLengthStream permits large multipart requests without buffering the
    // file into Worker memory; tests can use standard Web streams.
    const fixed = typeof FixedLengthStream === "undefined" ? null : new FixedLengthStream(length);
    const piping = fixed ? stream.pipeTo(fixed.writable) : null;
    void piping?.catch(() => undefined);
    const response = await request(endpoint, {
      method: "POST", headers: {
        "x-apikey": apiKey, accept: "application/json",
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": String(length),
      },
      body: fixed ? fixed.readable : stream,
      signal: AbortSignal.timeout(120000), redirect: "error",
    });
    if (piping) await piping;
    if (response.status === 429) return "rate_limited";
    if (!response.ok) return "unavailable";
    const result: unknown = await response.json();
    const data = result && typeof result === "object" && "data" in result ? result.data : null;
    if (!data || typeof data !== "object" || !("id" in data) ||
        typeof data.id !== "string" || !data.id || data.id.length > 1024) return "unavailable";
    return "submitted";
  } catch {
    return "unavailable";
  } finally {
    if (source) await source.cancel().catch(() => undefined);
  }
}

const maxLookupPerCron = 4;
const retryAfterMs = 6 * 60 * 60 * 1000;

/**
 * Process up to four due hashes on the existing six-hour cron. Claims are
 * conditional D1 updates, preventing concurrent runs from fetching one hash
 * more than once. Only a valid 'found' report is persisted permanently.
 * Missing reports, rate limits and failures remain queued for retry.
 */
export async function processVirusTotalQueue(
  env: Bindings, apiKey: string | undefined = env.VIRUSTOTAL_API_KEY,
  request: typeof fetch = fetch, now = Date.now(),
): Promise<number> {
  if (!apiKey) return 0;
  const due = await env.DB.prepare(
    "SELECT sha256, upload_file_id, upload_submitted_at FROM virustotal_queue " +
    "WHERE next_attempt_at <= ? ORDER BY next_attempt_at, enqueued_at LIMIT ?"
  ).bind(now, maxLookupPerCron).all<{
    sha256: string; upload_file_id: string | null; upload_submitted_at: number | null;
  }>();
  let saved = 0;
  let requests = 0;
  for (const { sha256, upload_file_id, upload_submitted_at } of due.results) {
    // Public API free-tier requests: 4/min. A large approved submission can
    // require GET(hash), GET(upload_url) and POST(file), so reserve three calls.
    if (requests >= maxLookupPerCron || (upload_file_id && !upload_submitted_at && requests > 1))
      break;
    const cleanup = () => env.DB.prepare("DELETE FROM virustotal_queue WHERE sha256 = ?")
      .bind(sha256).run();
    if (!validSha256(sha256)) { await cleanup(); continue; }
    const cached = await env.DB.prepare(
      "SELECT sha256 FROM virustotal_reports WHERE sha256 = ?"
    ).bind(sha256).first<{ sha256: string }>();
    if (cached) { await cleanup(); continue; }
    // Never query hashes that no longer belong to a stored file.
    const attached = await env.DB.prepare(
      "SELECT id FROM files WHERE json_extract(record_json, '$.checksums.sha256') = ? LIMIT 1"
    ).bind(sha256).first<{ id: string }>();
    if (!attached) { await cleanup(); continue; }
    const claimed = await env.DB.prepare(
      "UPDATE virustotal_queue SET attempts = attempts + 1, next_attempt_at = ? " +
      "WHERE sha256 = ? AND next_attempt_at <= ? " +
      "AND NOT EXISTS (SELECT 1 FROM virustotal_reports WHERE sha256 = ?)"
    ).bind(now + retryAfterMs, sha256, now, sha256).run();
    if (claimed.meta.changes !== 1) continue;
    requests++;
    const report = await getVirusTotalReport(sha256, apiKey, request);
    if (report.status === "found") {
      const [insert] = await env.DB.batch([
        // An in-flight response must not recreate a cached report after
        // the last file using this digest was deleted.
        env.DB.prepare(
          "INSERT OR IGNORE INTO virustotal_reports (sha256, report_json, checked_at) " +
          "SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM files " +
          "WHERE json_extract(record_json, '$.checksums.sha256') = ?)"
        ).bind(sha256, JSON.stringify(report), new Date(now).toISOString(), sha256),
        env.DB.prepare("DELETE FROM virustotal_queue WHERE sha256 = ?").bind(sha256),
      ]);
      saved += insert.meta.changes;
    } else if (report.status === "rate_limited") {
      break;
    } else if (report.status === "not_found" && upload_file_id && !upload_submitted_at) {
      // Only a specific file authorized via the admin API can be sent.
      const record = await getRecord(env, upload_file_id);
      if (!record || expired(record) || record.checksums?.sha256 !== sha256) {
        await env.DB.prepare("UPDATE virustotal_queue SET upload_file_id = NULL WHERE sha256 = ?")
          .bind(sha256).run();
        continue;
      }
      requests += record.size > 32 * 1024 * 1024 ? 2 : 1;
      const status = await submitAuthorizedVirusTotalFile(env, record, apiKey, request);
      if (status === "submitted") {
        await env.DB.prepare(
          "UPDATE virustotal_queue SET upload_submitted_at = ? WHERE sha256 = ? " +
          "AND upload_file_id = ? AND upload_submitted_at IS NULL"
        ).bind(now, sha256, upload_file_id).run();
      } else if (status === "rate_limited") {
        break;
      }
    }
    // Other failures stay queued until the next six-hour run.
  }
  return saved;
}
