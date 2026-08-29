import { z } from "zod";
import { validationError } from "@/lib/project-management/application/errors";

const cursorKinds = [
  "IN_APP_NOTIFICATION",
  "TASK",
  "RISK",
  "COMMENT",
  "ACTIVITY",
] as const;
export type KeysetCursorKind = (typeof cursorKinds)[number];

const cursorSchema = z
  .object({
    v: z.literal(1),
    kind: z.enum(cursorKinds),
    scope: z.string().min(1).max(1000),
    timestamp: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();

export type KeysetCursor = {
  timestamp: Date;
  id: string;
};

export function encodeKeysetCursor(
  kind: KeysetCursorKind,
  scope: string,
  row: { timestamp: Date; id: string } | undefined,
): string | null {
  if (!row) return null;
  return Buffer.from(
    JSON.stringify({
      v: 1,
      kind,
      scope,
      timestamp: row.timestamp.toISOString(),
      id: row.id,
    }),
  ).toString("base64url");
}

export function decodeKeysetCursor(
  value: string | undefined,
  kind: KeysetCursorKind,
  scope: string,
  message: string,
): KeysetCursor | null {
  if (!value) return null;
  if (value.length > 4096) throw validationError(message);
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    const parsed = cursorSchema.safeParse(decoded);
    if (
      !parsed.success ||
      parsed.data.kind !== kind ||
      parsed.data.scope !== scope
    ) {
      throw new Error("invalid cursor");
    }
    return {
      timestamp: new Date(parsed.data.timestamp),
      id: parsed.data.id,
    };
  } catch {
    throw validationError(message);
  }
}
