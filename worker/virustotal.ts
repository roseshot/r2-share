import { validSha256, type Bindings } from "./model";

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
    "SELECT sha256 FROM virustotal_queue WHERE next_attempt_at <= ? " +
    "ORDER BY next_attempt_at, enqueued_at LIMIT ?"
  ).bind(now, maxLookupPerCron).all<{ sha256: string }>();
  let saved = 0;
  for (const { sha256 } of due.results) {
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
    }
    // Other failures stay queued until the next six-hour run.
  }
  return saved;
}
