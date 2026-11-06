export interface VirusTotalResult {
  status: "found" | "not_found" | "not_configured" | "rate_limited" | "unavailable";
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
