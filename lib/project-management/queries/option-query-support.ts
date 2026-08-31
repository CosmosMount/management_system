import { createHash } from "node:crypto";
import { validationError } from "@/lib/project-management/application/errors";

type OptionCursorKind = "people" | "tasks";

type OptionCursor = {
  v: 1;
  kind: OptionCursorKind;
  filter: string;
  id: string;
};

export const FUZZY_CANDIDATE_LIMIT = 501;
export const QUERY_RESULT_LIMIT = 50;

export function mergeRowsById<T extends { id: string }>(
  ...groups: readonly T[][]
): T[] {
  const rows = new Map<string, T>();
  for (const group of groups) {
    for (const row of group) rows.set(row.id, row);
  }
  return [...rows.values()];
}

export function cursorFilter(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("base64url")
    .slice(0, 22);
}

export function nextOptionCursor(
  kind: OptionCursorKind,
  filter: string,
  id: string | undefined,
): string | null {
  if (!id) return null;
  return Buffer.from(
    JSON.stringify({ v: 1, kind, filter, id } satisfies OptionCursor),
  ).toString("base64url");
}

export async function validateOptionCursor({
  cursor,
  kind,
  filter,
  exists,
}: {
  cursor: string | undefined;
  kind: OptionCursorKind;
  filter: string;
  exists: (id: string) => Promise<{ id: string } | null>;
}): Promise<string | null> {
  if (!cursor) return null;
  const decoded = decodeOptionCursor(cursor);
  if (
    !decoded ||
    decoded.kind !== kind ||
    decoded.filter !== filter ||
    !(await exists(decoded.id))
  ) {
    throw validationError("分页游标无效或已不再匹配当前查询", {
      cursor: ["分页游标无效或已不再匹配当前查询"],
    });
  }
  return decoded.id;
}

function decodeOptionCursor(cursor: string): OptionCursor | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      record.v !== 1 ||
      (record.kind !== "people" &&
        record.kind !== "tasks") ||
      typeof record.filter !== "string" ||
      typeof record.id !== "string" ||
      !UUID_PATTERN.test(record.id)
    ) {
      return null;
    }
    return record as OptionCursor;
  } catch {
    return null;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
