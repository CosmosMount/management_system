import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  ProjectManagementServiceError,
  validationError,
} from "@/lib/project-management/application/errors";
import {
  DAY_MS,
  contentTimeBounds,
  floorShanghaiDay,
} from "@/lib/project-management/time-canvas/time-math";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  timeCanvasDataDtoSchema,
  type BusyBlockDto,
  type TimeSegmentDto,
} from "@/lib/project-management/types/time-canvas";
import {
  getTimeCanvasDataInputSchema,
  MAX_TIME_CANVAS_VISIBLE_SEGMENTS,
  type GetTimeCanvasDataInput,
} from "@/lib/project-management/validations/time-canvas";
import {
  fullSegmentSelect,
  type FullSegment,
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
import { loadBoundedAdaptiveLeaves } from "@/lib/project-management/queries/time-canvas-adaptive-loader";
import { loadTaskAnchors } from "@/lib/project-management/queries/time-canvas-anchor-loader";
import { listGlobalTimeMarkers } from "@/lib/project-management/global-time-markers";
import { resolveContentNavigationWindow } from "@/lib/project-management/time-canvas/content-window";

export async function getContentDrivenTimeCanvasData({
  actor,
  input,
  preferredCenterMs,
  includePreferredCenterInFullRange = false,
  anchorTaskIds = [],
  load = { mode: "ALL" },
}: {
  actor: ProjectManagementActor;
  input: unknown;
  preferredCenterMs?: number;
  includePreferredCenterInFullRange?: boolean;
  anchorTaskIds?: string[];
  load?:
    | { mode: "ALL" | "INITIAL" }
    | {
        mode: "BLOCK";
        range: { startMs: number; endMs: number };
        expectedRowPageKey: string;
      };
}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw validationError("内容驱动画布查询格式不正确");
  }
  const record = input as Record<string, unknown>;
  if ("rangeStart" in record || "rangeEnd" in record || "cursor" in record) {
    throw validationError("内容驱动画布的范围和行游标必须由服务端派生");
  }
  const requestedCenterMs = preferredCenterMs !== undefined && Number.isFinite(preferredCenterMs)
    ? preferredCenterMs
    : null;
  const seedStart = floorShanghaiDay(requestedCenterMs ?? Date.now());
  const parsed = getTimeCanvasDataInputSchema.parse({
    ...record,
    rangeStart: new Date(seedStart).toISOString(),
    rangeEnd: new Date(seedStart + DAY_MS).toISOString(),
  });
  const authorizedAllTimeFilter = authorizedSegmentFilterWhere(actor, parsed, false);
  const scopeTask = await authorizeScopeAndExplicitFilters(
    actor,
    parsed,
    authorizedAllTimeFilter,
  );
  const rowPage = parsed.groupBy === "PERSON"
    ? await loadPersonRows(
        actor,
        parsed,
        scopeTask,
        authorizedAllTimeFilter,
      )
    : await loadTaskRows(
        actor,
        parsed,
        scopeTask,
      );
  const allTimeUniverseWhere = fullSegmentUniverseWhere(
    parsed,
    rowPage.rowUniverseWhere,
    authorizedAllTimeFilter,
  );
  const currentPageAllTimeWhere: Prisma.WorkSegmentWhereInput = {
    AND: [
      allTimeUniverseWhere,
      parsed.groupBy === "PERSON"
        ? { personId: { in: rowPage.rowIds } }
        : { taskId: { in: rowPage.rowIds } },
    ],
  };
  const [segmentBounds, anchors, globalMarkers] = await Promise.all([
    rowPage.rowIds.length === 0
      ? Promise.resolve({
          _min: { startAt: null },
          _max: { endAt: null, updatedAt: null },
          _count: { _all: 0 },
        })
      : prisma.workSegment.aggregate({
          where: currentPageAllTimeWhere,
          _min: { startAt: true },
          _max: { endAt: true, updatedAt: true },
          _count: { _all: true },
        }),
    parsed.includeTaskAnchors
      ? loadTaskAnchors(
          actor,
          anchorTaskIds.length > 0 ? { ...parsed, taskIds: anchorTaskIds } : parsed,
          scopeTask,
          rowPage.rowIds,
          [],
        )
      : Promise.resolve([]),
    listGlobalTimeMarkers(),
  ]);
  const businessTimestamps: number[] = [];
  if (segmentBounds._min.startAt) {
    businessTimestamps.push(segmentBounds._min.startAt.getTime());
  }
  if (segmentBounds._max.endAt) {
    businessTimestamps.push(segmentBounds._max.endAt.getTime() - 1);
  }
  for (const task of anchors) {
    businessTimestamps.push(Date.parse(task.plannedStartAt ?? task.createdAt));
    for (const node of task.nodes) {
      if (node.plannedAt) businessTimestamps.push(Date.parse(node.plannedAt));
    }
  }
  const businessContentRange = contentTimeBounds(businessTimestamps);
  const contentRange = contentTimeBounds([
    ...businessTimestamps,
    ...globalMarkers.map((marker) => Date.parse(marker.markedAt)),
  ]);
  const navigation = resolveContentNavigationWindow({ contentRange, businessContentRange, preferredCenterMs, includePreferredCenterInFullRange });
  const { fullRange, resolvedCenterMs } = navigation;
  const logical = { range: navigation.range, clipped: navigation.rangeClipped };
  const rowPageKey = createRowPageKey(
    actor,
    parsed,
    rowPage.rows,
    anchors,
    logical.range,
    {
      count: segmentBounds._count._all,
      latestUpdatedAt: segmentBounds._max.updatedAt?.toISOString() ?? null,
      globalMarkers: globalMarkers.map((marker) => [
        marker.id,
        marker.versionToken,
      ]),
    },
  );
  const loadRange = resolveContentLoadRange(load, logical.range, resolvedCenterMs);
  if (load.mode === "BLOCK" && load.expectedRowPageKey !== rowPageKey) {
    throw new ProjectManagementServiceError(
      "STATE_CONFLICT",
      "时间画布结构已更新，请刷新后重试",
    );
  }
  const blockResult = await loadContentDrivenSegmentBlocks({
    actor,
    input: parsed,
    where: currentPageAllTimeWhere,
    rangeStart: loadRange.startMs,
    rangeEnd: loadRange.endMs,
  });
  const data = timeCanvasDataDtoSchema.parse({
    scope: parsed.scope,
    timezone: "Asia/Shanghai",
    range: {
      startAt: new Date(logical.range.startMs).toISOString(),
      endAt: new Date(logical.range.endMs).toISOString(),
    },
    rowPageKey,
    groupBy: parsed.groupBy,
    rows: rowPage.rows,
    anchors,
    globalMarkers,
    segments: blockResult.segments,
    generatedAt: new Date().toISOString(),
  });
  return {
    data,
    contentRange,
    fullRange,
    rangeClipped: logical.clipped,
    resolvedCenterMs,
    leafBlockCount: blockResult.leafBlockCount,
    failedRanges: blockResult.failedRanges,
    loadedRange: loadRange,
  };
}

function resolveContentLoadRange(
  load:
    | { mode: "ALL" | "INITIAL" }
    | {
        mode: "BLOCK";
        range: { startMs: number; endMs: number };
        expectedRowPageKey: string;
      },
  logicalRange: { startMs: number; endMs: number },
  preferredCenterMs: number,
) {
  if (load.mode === "ALL") return logicalRange;
  if (load.mode === "BLOCK") {
    const { startMs, endMs } = load.range;
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs <= startMs ||
      endMs - startMs > 366 * DAY_MS ||
      startMs < logicalRange.startMs ||
      endMs > logicalRange.endMs
    ) {
      throw validationError("时间数据块必须完整位于当前授权逻辑范围内");
    }
    return load.range;
  }
  const target = Math.max(
    logicalRange.startMs,
    Math.min(preferredCenterMs, logicalRange.endMs - 1),
  );
  const blockIndex = Math.floor((target - logicalRange.startMs) / (180 * DAY_MS));
  const startMs = logicalRange.startMs + blockIndex * 180 * DAY_MS;
  return { startMs, endMs: Math.min(logicalRange.endMs, startMs + 180 * DAY_MS) };
}
async function loadContentDrivenSegmentBlocks({
  actor,
  input,
  where,
  rangeStart,
  rangeEnd,
}: {
  actor: ProjectManagementActor;
  input: GetTimeCanvasDataInput;
  where: Prisma.WorkSegmentWhereInput;
  rangeStart: number;
  rangeEnd: number;
}) {
  const blocks: Array<{ startMs: number; endMs: number }> = [];
  for (let startMs = rangeStart; startMs < rangeEnd;) {
    const endMs = Math.min(rangeEnd, startMs + 180 * DAY_MS);
    blocks.push({ startMs, endMs });
    startMs = endMs;
  }
  const { leaves: leafResults, failedRanges } = await loadBoundedAdaptiveLeaves({
    ranges: blocks,
    loadRange: (range) => loadContentDrivenLeaf(where, range.startMs, range.endMs),
  });
  const byId = new Map<string, FullSegment>();
  for (const leaf of leafResults) {
    for (const segment of leaf) {
      const current = byId.get(segment.id);
      if (!current || current.updatedAt < segment.updatedAt) byId.set(segment.id, segment);
    }
  }
  const segments: Array<TimeSegmentDto | BusyBlockDto> = [...byId.values()]
    .sort((left, right) =>
      left.startAt.getTime() - right.startAt.getTime() ||
      left.endAt.getTime() - right.endAt.getTime() ||
      left.id.localeCompare(right.id),
    )
    .map((segment) => toFullSegmentDto(actor, segment));
  // With the current global Segment visibility policy there are no Busy projections.
  if (input.includeBusyBlocks && input.groupBy !== "PERSON") {
    throw validationError("Busy 只允许在按人员分组的画布中返回");
  }
  return {
    segments,
    failedRanges,
    leafBlockCount: leafResults.length + failedRanges.length,
  };
}
async function loadContentDrivenLeaf(
  where: Prisma.WorkSegmentWhereInput,
  startMs: number,
  endMs: number,
): Promise<FullSegment[]> {
  return prisma.workSegment.findMany({
    where: {
      AND: [
        where,
        { startAt: { lt: new Date(endMs) }, endAt: { gt: new Date(startMs) } },
      ],
    },
    select: fullSegmentSelect,
    orderBy: [{ startAt: "asc" }, { endAt: "asc" }, { id: "asc" }],
    take: MAX_TIME_CANVAS_VISIBLE_SEGMENTS + 1,
  });
}
