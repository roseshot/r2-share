import { describe, expect, test } from "bun:test";
import { getVirusTotalReport } from "../worker/virustotal";

const hash = "a".repeat(64);

describe("VirusTotal hash-only lookup", () => {
  test("requires a configured secret and never sends file bytes", async () => {
    let requests = 0;
    const notConfigured = await getVirusTotalReport(hash, undefined, async () => {
      requests++;
      return new Response(null, { status: 200 });
    });
    expect(notConfigured).toEqual({ status: "not_configured" });
    expect(requests).toBe(0);

    let requestedUrl = "";
    let method = "";
    let auth = "";
    const result = await getVirusTotalReport(hash, "private-api-key", async (input, init) => {
      requestedUrl = String(input);
      method = init?.method ?? "";
      auth = new Headers(init?.headers).get("x-apikey") ?? "";
      expect(init?.body).toBeUndefined();
      return Response.json({
        data: { attributes: { last_analysis_stats: {
          malicious: 3, suspicious: 1, harmless: 50, undetected: 10,
        }, last_analysis_date: 1750000000 } },
      });
    });
    expect(requestedUrl).toBe("https://www.virustotal.com/api/v3/files/" + hash);
    expect(method).toBe("GET");
    expect(auth).toBe("private-api-key");
    expect(result).toEqual({
      status: "found", malicious: 3, suspicious: 1, harmless: 50,
      undetected: 10, scanDate: 1750000000,
    });
  });

  test("distinguishes missing reports, throttling and upstream errors", async () => {
    const reply = (status: number) => getVirusTotalReport(hash, "secret", async () =>
      new Response(null, { status }));
    expect(await reply(404)).toEqual({ status: "not_found" });
    expect(await reply(429)).toEqual({ status: "rate_limited" });
    expect(await reply(503)).toEqual({ status: "unavailable" });
    expect(await getVirusTotalReport(hash, "secret", async () => {
      throw new Error("Network error");
    })).toEqual({ status: "unavailable" });
  });
});
