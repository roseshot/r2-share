import { RequestError, requestJson, type Share } from "./lib";

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
  values: Uint32Array = crypto.getRandomValues(new Uint32Array(12)),
): Share {
  const modifiedAt = new Date(Date.now() - (1 + values[3] % 365) * 86400000).toISOString();
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
  };
}

type PlaceholderStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const placeholderCachePrefix = "tuckbox:missing-share:v1:";

function browserStorage(): PlaceholderStorage | null {
  try { return globalThis.localStorage ?? null; }
  catch { return null; }
}

function isCachedPlaceholder(value: unknown, id: string): value is Share {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const checksums = entry.checksums as Record<string, unknown> | null | undefined;
  return entry.id === id &&
    entry.mode === "public" &&
    typeof entry.filename === "string" && entry.filename.length > 0 && entry.filename.length <= 255 &&
    typeof entry.mime === "string" && entry.mime.length > 0 &&
    typeof entry.size === "number" && Number.isSafeInteger(entry.size) &&
    entry.size > 0 && entry.size <= maxPlaceholderSize &&
    typeof entry.originalModifiedAt === "string" &&
    Number.isFinite(Date.parse(entry.originalModifiedAt)) &&
    !!checksums && typeof checksums === "object" &&
    typeof checksums.sha256 === "string" && /^[a-f0-9]{64}$/.test(checksums.sha256);
}

function missingShareDetails(id: string, storage: PlaceholderStorage | null): Share {
  const key = placeholderCachePrefix + id;
  try {
    const cached = storage?.getItem(key);
    if (cached) {
      const parsed: unknown = JSON.parse(cached);
      if (isCachedPlaceholder(parsed, id)) return parsed;
    }
  } catch { /* Corrupt or unavailable browser storage should not block the page. */ }

  const details = createPlaceholderShare(id);
  try { storage?.setItem(key, JSON.stringify(details)); }
  catch { /* The placeholder still works when persistence is unavailable. */ }
  return details;
}

export async function loadShareDetails(
  id: string,
  load: (url: string) => Promise<Share> = requestJson,
  storage: PlaceholderStorage | null = browserStorage(),
): Promise<{ file: Share; isPlaceholder: boolean }> {
  try {
    const file = await load("/api/files/" + id);
    try { storage?.removeItem(placeholderCachePrefix + id); }
    catch { /* A valid share must not depend on browser storage. */ }
    return { file, isPlaceholder: false };
  } catch (error) {
    if (!(error instanceof RequestError) || error.status !== 404) throw error;
    return { file: missingShareDetails(id, storage), isPlaceholder: true };
  }
}
