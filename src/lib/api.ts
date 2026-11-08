export type Mode = "public" | "protected";
export type StorageBackend = "b2" | "r2" | "s3";
export interface FileChecksums {
  sha256: string;
}
export type VirusTotalSummary = {
  status: "found" | "pending" | "unavailable";
  malicious?: number;
  suspicious?: number;
  harmless?: number;
  undetected?: number;
  scanDate?: number | null;
};
export type Share = {
  id: string;
  mode: Mode;
  filename?: string;
  size?: number;
  mime?: string;
  checksums?: FileChecksums;
  virusTotal?: VirusTotalSummary;
  originalModifiedAt?: string;
};
export type ManagedShare = {
  id: string;
  label: string;
  showVirusTotal: boolean;
  mode: Mode;
  createdAt: string;
  shareExpiresAt: string | null;
};
export type ManagedFile = Omit<Share, "mode"> & {
  storageId: string;
  shares: ManagedShare[];
  /** Admin-only permission to submit file bytes for VirusTotal analysis. */
  canSubmitToVirusTotal: boolean;
  filename: string;
  size: number;
  mime: string;
  fileExpiresAt: string | null;
  createdAt: string;
};
export const durations = [
  { seconds: 0, label: "Never" },
  { seconds: 3600, label: "1 hour" },
  { seconds: 86400, label: "24 hours" },
  { seconds: 259200, label: "3 days" },
  { seconds: 604800, label: "7 days" }
];
export function sizeText(n: number): string {
  if (n < 1024) return n + " B";
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let size = n;
  let unit = -1;
  do {
    size /= 1024;
    unit++;
  } while (size >= 1024 && unit < units.length - 1);
  return size.toFixed(1) + " " + units[unit];
}
export function timeText(iso: string | null): string {
  if (iso === null) return "Never";
  const left = Math.max(0, Date.parse(iso) - Date.now());
  if (left <= 0) return "Expired";
  if (left < 3600000) return Math.ceil(left / 60000) + " minutes";
  if (left < 86400000) return Math.ceil(left / 3600000) + " hours";
  return Math.ceil(left / 86400000) + " days";
}
export class RequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "RequestError";
  }
}

export async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const result = await fetch(url, { credentials: "same-origin", cache: "no-store", ...options });
  const body: unknown = await result.json().catch(() => null);
  if (!result.ok) {
    const message = body && typeof body === "object" && "error" in body &&
      typeof body.error === "string" ? body.error : "Request failed (" + result.status + ")";
    throw new RequestError(message, result.status);
  }
  return body as T;
}
export function jsonBody(value: unknown): RequestInit {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}
