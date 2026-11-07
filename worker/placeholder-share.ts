import type { Share } from "../src/lib";

const pick = (items: readonly string[], value: number): string => items[value % items.length];

// Heavy-tailed sizes are type-aware but never exceed the GiB display range.
const maxPlaceholderSize = 999 * 1024 ** 3;
function placeholderSize(baseSize: number, tailExponent: number, high: number, low: number): number {
  const fraction = (high * 0x200000 + (low >>> 11)) / 0x20000000000000;
  const size = Math.round(baseSize / Math.pow(1 - fraction, tailExponent));
  return Math.min(size, maxPlaceholderSize);
}

export function createPlaceholderShare(
  id: string,
  values: Uint32Array,
  referenceTime = Date.now(),
): Share {
  // Choose both the day and the time of day. The reference time is fixed for
  // the lease so that repeated requests return exactly the same timestamp.
  const modifiedAt = new Date(referenceTime -
    (1 + values[3] % 365) * 86400000 - values[7] % 86400000).toISOString();
  const day = modifiedAt.slice(0, 10);
  const month = day.slice(0, 7);
  const year = day.slice(0, 4);
  const compactDay = day.replaceAll("-", "");
  const time = modifiedAt.slice(11, 19).replaceAll(":", "");
  const fileNumber = String(1000 + values[4] % 9000);
  const sequence = String(1 + values[5] % 99).padStart(2, "0");
  const revision = 2 + values[5] % 4;
  const subject = pick(["Kitchen remodel", "Website update", "Summer trip", "Home office",
    "School project", "Garden plans", "Family photos", "Weekend getaway"], values[4]);
  const pdfTopic = pick(["Flight itinerary", "Electric bill", "Apartment lease",
    "Car insurance", "Course registration", "Repair estimate"], values[5]);
  const photoTopic = pick(["beach", "hiking", "birthday", "garden", "weekend", "concert"], values[4]);
  const noteTopic = pick(["packing list", "meeting notes", "gift ideas",
    "shopping list", "things to fix", "recipe notes"], values[4]);
  const archiveTopic = pick(["documents", "holiday photos", "work files",
    "old laptop", "project assets", "receipts"], values[4]);
  const videoTopic = pick(["birthday dinner", "weekend trip", "school concert",
    "family barbecue", "product demo", "basketball game"], values[4]);
  const sheetTopic = pick(["Household budget", "Travel expenses", "Inventory",
    "Client list", "Monthly expenses", "Project costs"], values[4]);
  const formats = [
    {
      mime: "application/pdf", baseSize: 60 * 1024, tailExponent: 0.9,
      names: [
        `${pdfTopic} ${year}.pdf`,
        `Invoice_${compactDay}_${fileNumber}.pdf`,
        `Rent receipt - ${month}.pdf`,
        `${subject} - proposal v${revision}.pdf`,
        `scan${sequence}.pdf`,
        `${pdfTopic} (1).pdf`,
        `${day}_receipt.pdf`,
        `${year} taxes - copy.pdf`,
        `${subject} FINAL.pdf`,
        `Statement_${month.replace("-", "")}.pdf`,
      ],
    },
    {
      mime: "image/jpeg", baseSize: 500 * 1024, tailExponent: 0.65,
      names: [
        `IMG_${fileNumber}.jpg`,
        `DSC_${fileNumber}.jpg`,
        `PXL_${compactDay}_${time}${modifiedAt.slice(20, 23)}.jpg`,
        `${photoTopic} ${sequence}.jpg`,
        `${subject} ${year}.jpg`,
        `IMG_${compactDay}_${time}.jpg`,
        `photo_${fileNumber}.jpg`,
        `${photoTopic} (1).jpg`,
        `${photoTopic}_${day}.jpg`,
        `IMG_${fileNumber} (2).jpg`,
      ],
    },
    {
      mime: "application/zip", baseSize: 1024 * 1024, tailExponent: 1.3,
      names: [
        `${archiveTopic} backup ${day}.zip`,
        `${subject} files.zip`,
        `backup_${compactDay}.zip`,
        `Photos ${year} (1).zip`,
        `export_${compactDay}_${sequence}.zip`,
        `${archiveTopic} - copy.zip`,
        `${subject} final.zip`,
        `${archiveTopic}_${year}.zip`,
        `archive (${revision}).zip`,
        `downloads_${month.replace("-", "")}.zip`,
      ],
    },
    {
      mime: "text/plain", baseSize: 400, tailExponent: 0.66,
      names: [
        `notes.txt`,
        `todo.txt`,
        `${noteTopic}.txt`,
        `${day} notes.txt`,
        `${noteTopic} (1).txt`,
        `${subject.toLowerCase()} notes.txt`,
        `README.txt`,
        `ideas_${year}.txt`,
        `notes - ${month}.txt`,
        `${noteTopic} v${revision}.txt`,
      ],
    },
    {
      mime: "video/mp4", baseSize: 12 * 1024 * 1024, tailExponent: 1.1,
      names: [
        `VID_${compactDay}_${time}.mp4`,
        `VID_${fileNumber}.mp4`,
        `${videoTopic}.mp4`,
        `${videoTopic} - clip ${sequence}.mp4`,
        `ScreenRecording_${compactDay}_${time}.mp4`,
        `${subject} ${year}.mp4`,
        `video_${fileNumber}.mp4`,
        `${videoTopic} (1).mp4`,
        `final_cut_v${revision}.mp4`,
        `clip_${compactDay}_${sequence}.mp4`,
      ],
    },
    {
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      baseSize: 16 * 1024, tailExponent: 1.0,
      names: [
        `${sheetTopic} ${year}.xlsx`,
        `Expenses ${month}.xlsx`,
        `budget_${year}.xlsx`,
        `${subject} - costs.xlsx`,
        `inventory (1).xlsx`,
        `${sheetTopic} v${revision}.xlsx`,
        `${month} expenses.xlsx`,
        `work_hours_${month.replace("-", "")}.xlsx`,
        `${sheetTopic} FINAL.xlsx`,
        `spreadsheet (${revision}).xlsx`,
      ],
    },
  ];
  const format = formats[values[0] % formats.length];
  return {
    id,
    mode: "public",
    filename: format.names[values[1] % format.names.length],
    size: placeholderSize(format.baseSize, format.tailExponent, values[2], values[6]),
    mime: format.mime,
    originalModifiedAt: modifiedAt,
    checksums: {
      sha256: Array.from(values.subarray(4), value => value.toString(16).padStart(8, "0")).join(""),
    },
    virusTotal: { status: "pending" },
  };
}


// A random, per-ID lease duration (1 hour to 7 days) and time offset keep
// placeholders stable between requests without writing attacker-supplied IDs
// into storage. When a lease ends, the next period gets different metadata.
const minLeaseMs = 60 * 60 * 1000;
const maxLeaseMs = 7 * 24 * minLeaseMs;
const leaseSpanMs = maxLeaseMs - minLeaseMs + 1;
const encoder = new TextEncoder();
async function signPlaceholder(key: CryptoKey, payload: string): Promise<ArrayBuffer> {
  return crypto.subtle.sign("HMAC", key, encoder.encode("tuckbox/placeholder/v2:" + payload));
}

async function leaseForKey(
  key: CryptoKey,
  id: string,
  now: number,
): Promise<{ startsAt: number; expiresAt: number; durationMs: number; period: number }> {
  const schedule = new DataView(await signPlaceholder(key, "schedule:" + id));
  const durationMs = minLeaseMs + schedule.getUint32(0, false) % leaseSpanMs;
  const offsetMs = schedule.getUint32(4, false) % durationMs;
  const period = Math.floor((now + offsetMs) / durationMs);
  const startsAt = period * durationMs - offsetMs;
  return { startsAt, expiresAt: startsAt + durationMs, durationMs, period };
}

export async function placeholderLease(
  id: string,
  secret: string,
  now = Date.now(),
): Promise<{ startsAt: number; expiresAt: number; durationMs: number }> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const { startsAt, expiresAt, durationMs } = await leaseForKey(key, id, now);
  return { startsAt, expiresAt, durationMs };
}

export async function generatePlaceholderShare(
  id: string,
  secret: string,
  now = Date.now(),
): Promise<Share> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const { startsAt, period } = await leaseForKey(key, id, now);
  const [first, second] = await Promise.all([0, 1].map(index =>
    signPlaceholder(key, "file:" + id + ":" + period + ":" + index),
  ));
  const bytes = new Uint8Array(48);
  bytes.set(new Uint8Array(first), 0);
  bytes.set(new Uint8Array(second).subarray(0, 16), 32);
  const view = new DataView(bytes.buffer);
  const values = Uint32Array.from({ length: 12 }, (_, index) => view.getUint32(index * 4, false));
  return createPlaceholderShare(id, values, startsAt);
}
