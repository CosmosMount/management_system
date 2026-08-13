import { createHash } from "node:crypto";
import { validationError } from "@/lib/project-management/application/errors";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import type {
  TimeCanvasRowDto,
  TimeCanvasTaskAnchorDto,
} from "@/lib/project-management/types/time-canvas";
import type { GetTimeCanvasDataInput } from "@/lib/project-management/validations/time-canvas";

type CanvasCursor = {
  v: 1;
  groupBy: "PERSON" | "TASK";
  filter: string;
  id: string;
};

type PersonalDueCursor = {
  v: 1;
  kind: "PERSONAL_DUE";
  personId: string;
  endAt: string;
  id: string;
};

export function encodePersonalDueCursor(
  row: { id: string; endAt: Date } | undefined,
  personId: string,
): string | null {
  if (!row) return null;
  return Buffer.from(
    JSON.stringify({
      v: 1,
      kind: "PERSONAL_DUE",
      personId,
      endAt: row.endAt.toISOString(),
      id: row.id,
    } satisfies PersonalDueCursor),
  ).toString("base64url");
}

export function decodePersonalDueCursor(
  value: string,
  personId: string,
): PersonalDueCursor | null {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return null;
    }
    const record = decoded as Record<string, unknown>;
    if (
      record.v !== 1 ||
      record.kind !== "PERSONAL_DUE" ||
      record.personId !== personId ||
      typeof record.endAt !== "string" ||
      !Number.isFinite(Date.parse(record.endAt)) ||
      typeof record.id !== "string" ||
      !UUID_PATTERN.test(record.id)
    ) {
      return null;
    }
    return record as PersonalDueCursor;
  } catch {
    return null;
  }
}

export function canvasCursorFilter(
  input: GetTimeCanvasDataInput,
  includeRange = true,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        scope: input.scope,
        range: includeRange
          ? [input.rangeStart.toISOString(), input.rangeEnd.toISOString()]
          : undefined,
        personIds: [...input.personIds].sort(),
        taskIds: [...input.taskIds].sort(),
        types: [...input.types].sort(),
        statuses: [...input.statuses].sort(),
        groupBy: input.groupBy,
        includeTaskAnchors: input.includeTaskAnchors,
        includeActual: input.includeActual,
        includeBusyBlocks: input.includeBusyBlocks,
      }),
    )
    .digest("base64url")
    .slice(0, 22);
}

export function createRowPageKey(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  rows: TimeCanvasRowDto[],
  anchors: TimeCanvasTaskAnchorDto[],
  logicalRange?: { startMs: number; endMs: number },
  segmentEpoch?: unknown,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        actorAccountId: actor.accountId,
        semanticFilter: canvasCursorFilter(input, !logicalRange),
        logicalRange: logicalRange
          ? [
              new Date(logicalRange.startMs).toISOString(),
              new Date(logicalRange.endMs).toISOString(),
            ]
          : [input.rangeStart.toISOString(), input.rangeEnd.toISOString()],
        rows,
        anchors: anchors.map((task) => [
          task.id,
          task.versionToken,
          task.nodes.map((node) => [node.id, node.versionToken]),
        ]),
        segmentEpoch,
      }),
    )
    .digest("base64url")
    .slice(0, 32);
}

export function encodeCanvasCursor(
  groupBy: "PERSON" | "TASK",
  filter: string,
  id: string | undefined,
): string | null {
  if (!id) return null;
  return Buffer.from(
    JSON.stringify({ v: 1, groupBy, filter, id } satisfies CanvasCursor),
  ).toString("base64url");
}

export async function validateCanvasCursor({
  cursor,
  groupBy,
  filter,
  exists,
}: {
  cursor: string | undefined;
  groupBy: "PERSON" | "TASK";
  filter: string;
  exists: (id: string) => Promise<{ id: string } | null>;
}): Promise<string | null> {
  if (!cursor) return null;
  const decoded = decodeCanvasCursor(cursor);
  if (
    !decoded ||
    decoded.groupBy !== groupBy ||
    decoded.filter !== filter ||
    !(await exists(decoded.id))
  ) {
    throw validationError("画布行分页游标无效或已不匹配当前查询", {
      cursor: ["画布行分页游标无效或已不匹配当前查询"],
    });
  }
  return decoded.id;
}

function decodeCanvasCursor(cursor: string): CanvasCursor | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      record.v !== 1 ||
      (record.groupBy !== "PERSON" && record.groupBy !== "TASK") ||
      typeof record.filter !== "string" ||
      typeof record.id !== "string" ||
      !UUID_PATTERN.test(record.id)
    ) {
      return null;
    }
    return record as CanvasCursor;
  } catch {
    return null;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
