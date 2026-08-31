import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { segmentReadableWhere } from "@/lib/project-management/authorization";
import { queryLimitExceededError } from "@/lib/project-management/application/errors";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  timeCanvasDataDtoSchema,
  type BusyBlockDto,
  type TimeCanvasDataDto,
  type TimeSegmentDto,
} from "@/lib/project-management/types/time-canvas";
import {
  getTimeCanvasDataInputSchema,
  MAX_TIME_CANVAS_VISIBLE_SEGMENTS,
  type GetTimeCanvasDataInput,
} from "@/lib/project-management/validations/time-canvas";
import {
  busyCandidateSelect,
  fullSegmentSelect,
} from "@/lib/project-management/queries/time-canvas-records";
import { toFullSegmentDto } from "@/lib/project-management/queries/time-canvas-dto";
import {
  authorizeScopeAndExplicitFilters,
  authorizedSegmentFilterWhere,
  fullSegmentUniverseWhere,
} from "@/lib/project-management/queries/time-canvas-query-scope";
import {
  loadPersonRows,
  loadTaskRows,
} from "@/lib/project-management/queries/time-canvas-row-loader";
import { createRowPageKey } from "@/lib/project-management/queries/time-canvas-cursor";
import { loadTaskAnchors } from "@/lib/project-management/queries/time-canvas-anchor-loader";
import { listGlobalTimeMarkers } from "@/lib/project-management/global-time-markers";

export async function getTimeCanvasData({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}): Promise<TimeCanvasDataDto> {
  const parsed = getTimeCanvasDataInputSchema.parse(input);
  const authorizedSegmentFilter = authorizedSegmentFilterWhere(actor, parsed);
  const scopeTask = await authorizeScopeAndExplicitFilters(
    actor,
    parsed,
    authorizedSegmentFilter,
  );
  const rowPage =
    parsed.groupBy === "PERSON"
      ? await loadPersonRows(
          actor,
          parsed,
          scopeTask,
          authorizedSegmentFilter,
        )
      : await loadTaskRows(
          actor,
          parsed,
          scopeTask,
        );
  const fullUniverseWhere = fullSegmentUniverseWhere(
    parsed,
    rowPage.rowUniverseWhere,
    authorizedSegmentFilter,
  );

  const currentPageFullWhere: Prisma.WorkSegmentWhereInput = {
    AND: [
      fullUniverseWhere,
      parsed.groupBy === "PERSON"
        ? { personId: { in: rowPage.rowIds } }
        : { taskId: { in: rowPage.rowIds } },
    ],
  };
  const fullSegments =
    rowPage.rowIds.length === 0
      ? []
      : await prisma.workSegment.findMany({
          where: currentPageFullWhere,
          select: fullSegmentSelect,
          orderBy: [{ startAt: "asc" }, { endAt: "asc" }, { id: "asc" }],
          take: MAX_TIME_CANVAS_VISIBLE_SEGMENTS + 1,
        });
  assertTimeObjectLimit(fullSegments.length);
  const segments: Array<TimeSegmentDto | BusyBlockDto> = fullSegments.map(
    (segment) => toFullSegmentDto(actor, segment),
  );
  if (
    parsed.groupBy === "PERSON" &&
    parsed.includeBusyBlocks &&
    rowPage.rowIds.length > 0
  ) {
    const busy = await loadBusyBlocks(
      actor,
      parsed,
      rowPage.rowIds,
      MAX_TIME_CANVAS_VISIBLE_SEGMENTS - segments.length,
    );
    segments.push(...busy);
  }

  const anchors = parsed.includeTaskAnchors
    ? await loadTaskAnchors(
        actor,
        parsed,
        scopeTask,
        rowPage.rowIds,
        fullSegments,
      )
    : [];
  const globalMarkers = await listGlobalTimeMarkers();
  const rowPageKey = createRowPageKey(
    actor,
    parsed,
    rowPage.rows,
    anchors,
    undefined,
    {
      segments: fullSegments.map((segment) => [
        segment.id,
        segment.updatedAt.toISOString(),
      ]),
      globalMarkers: globalMarkers.map((marker) => [
        marker.id,
        marker.versionToken,
      ]),
    },
  );
  return timeCanvasDataDtoSchema.parse({
    scope: parsed.scope,
    timezone: "Asia/Shanghai",
    range: {
      startAt: parsed.rangeStart.toISOString(),
      endAt: parsed.rangeEnd.toISOString(),
    },
    rowPageKey,
    groupBy: parsed.groupBy,
    rows: rowPage.rows,
    anchors,
    globalMarkers,
    segments,
    generatedAt: new Date().toISOString(),
  });
}
function assertTimeObjectLimit(count: number) {
  if (count > MAX_TIME_CANVAS_VISIBLE_SEGMENTS) {
    throw queryLimitExceededError(
      "授权过滤后的返回时间对象超过 5000 条，请缩小范围后重试",
    );
  }
}
async function loadBusyBlocks(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  personIds: string[],
  remainingLimit: number,
): Promise<BusyBlockDto[]> {
  const candidates = await prisma.workSegment.findMany({
    where: {
      AND: [
        {
          personId: { in: personIds },
          deletedAt: null,
          startAt: { lt: input.rangeEnd },
          endAt: { gt: input.rangeStart },
          OR: [
            {
              type: "PLANNED",
              status: {
                in: ["PLANNED", "IN_PROGRESS", "PENDING_CONFIRMATION"],
              },
            },
            { type: "ACTUAL", status: "CONFIRMED" },
          ],
        },
        { NOT: segmentReadableWhere(actor) },
      ],
    },
    select: busyCandidateSelect,
    orderBy: [
      { startAt: "asc" },
      { endAt: "asc" },
      { personId: "asc" },
      { id: "asc" },
    ],
    take: remainingLimit + 1,
  });
  assertTimeObjectLimit(
    MAX_TIME_CANVAS_VISIBLE_SEGMENTS - remainingLimit + candidates.length,
  );
  return candidates.map((candidate) => {
    return {
      kind: "BUSY" as const,
      visibility: "BUSY_ONLY" as const,
      personId: candidate.personId,
      startAt: candidate.startAt.toISOString(),
      endAt: candidate.endAt.toISOString(),
    };
  });
}
