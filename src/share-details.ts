import { RequestError, requestJson, type Share } from "./lib";

export function createPlaceholderShare(
  id: string,
  values: Uint32Array = crypto.getRandomValues(new Uint32Array(12)),
): Share {
  const modifiedAt = new Date(Date.now() - (1 + values[3] % 365) * 86400000).toISOString();
  const day = modifiedAt.slice(0, 10);
  const month = day.slice(0, 7);
  const year = day.slice(0, 4);
  const time = modifiedAt.slice(11, 19).replaceAll(":", "");
  const quarter = Math.ceil(Number(day.slice(5, 7)) / 3);
  const formats = [
    {
      mime: "application/pdf", minSize: 80 * 1024, maxSize: 4 * 1024 * 1024,
      names: [
        "Project Proposal.pdf", `Annual Report ${year}.pdf`,
        `Meeting Agenda ${day}.pdf`, "Travel Itinerary.pdf",
        "User Guide.pdf", `Invoice ${month}.pdf`,
      ],
    },
    {
      mime: "image/jpeg", minSize: 300 * 1024, maxSize: 5 * 1024 * 1024,
      names: [
        `IMG_${day.replaceAll("-", "")}_${time}.jpg`, "Beach Sunset.jpg",
        "Family Photo.jpg", "Mountain View.jpg",
        `Vacation Photo ${year}.jpg`, "Garden Flowers.jpg",
      ],
    },
    {
      mime: "application/zip", minSize: 2 * 1024 * 1024, maxSize: 40 * 1024 * 1024,
      names: [
        `Website Backup ${day}.zip`, `Family Photos ${year}.zip`,
        "Project Files.zip", "Design Assets.zip",
        `Receipts ${year}.zip`, "Travel Photos.zip",
      ],
    },
    {
      mime: "text/plain", minSize: 200, maxSize: 12 * 1024,
      names: [
        `Meeting Notes ${day}.txt`, "Shopping List.txt",
        "Project Ideas.txt", "README.txt", "To Do List.txt",
        "Instructions.txt",
      ],
    },
    {
      mime: "video/mp4", minSize: 8 * 1024 * 1024, maxSize: 88 * 1024 * 1024,
      names: [
        `Screen Recording ${day}.mp4`, "Birthday Party.mp4",
        `Weekend Trip ${year}.mp4`, "Product Demo.mp4",
        "Concert Highlights.mp4", "Family Video.mp4",
      ],
    },
    {
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      minSize: 16 * 1024, maxSize: 800 * 1024,
      names: [
        `Monthly Budget ${month}.xlsx`, `Expense Report ${year}.xlsx`,
        "Inventory List.xlsx", `Sales Summary Q${quarter} ${year}.xlsx`,
        "Project Schedule.xlsx", "Client Contacts.xlsx",
      ],
    },
  ];
  const format = formats[values[0] % formats.length];
  return {
    id,
    mode: "public",
    filename: format.names[values[1] % format.names.length],
    size: format.minSize + values[2] % (format.maxSize - format.minSize + 1),
    mime: format.mime,
    originalModifiedAt: modifiedAt,
    checksums: {
      sha256: Array.from(values.subarray(4), value => value.toString(16).padStart(8, "0")).join(""),
    },
  };
}

export async function loadShareDetails(
  id: string,
  load: (url: string) => Promise<Share> = requestJson,
): Promise<{ file: Share; isPlaceholder: boolean }> {
  try {
    return { file: await load("/api/files/" + id), isPlaceholder: false };
  } catch (error) {
    if (!(error instanceof RequestError) || error.status !== 404) throw error;
    return { file: createPlaceholderShare(id), isPlaceholder: true };
  }
}
