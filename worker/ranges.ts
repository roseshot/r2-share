/** A single RFC 9110 byte range; multipart ranges are intentionally unsupported. */
export function parseByteRange(value: string, size: number): { start: number; end: number } | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : null;
  const end = match[2] ? Number(match[2]) : null;
  if (start !== null && (!Number.isSafeInteger(start) || start >= size)) return null;
  if (end !== null && (!Number.isSafeInteger(end) || end < 0)) return null;
  if (start === null) {
    if (end === null || end === 0) return null;
    return { start: Math.max(0, size - end), end: size - 1 };
  }
  if (end !== null && end < start) return null;
  return { start, end: Math.min(end ?? size - 1, size - 1) };
}
