export function encodeTimestampCursor(timestamp: Date, id: string) {
  return Buffer.from(JSON.stringify({ timestamp: timestamp.toISOString(), id })).toString("base64url");
}

export function decodeTimestampCursor(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { timestamp?: unknown; id?: unknown };
    const timestamp = typeof parsed.timestamp === "string" ? new Date(parsed.timestamp) : null;
    return timestamp && !Number.isNaN(timestamp.getTime()) && typeof parsed.id === "string" && parsed.id
      ? { timestamp, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}
