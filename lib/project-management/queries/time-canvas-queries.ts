import { createHash } from "node:crypto";
import type {
  Prisma,
  Task,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  authorize,
  isSystemAdministrator,
  segmentReadableWhere,
  taskReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import {
  notFoundError,
  ProjectManagementServiceError,
  queryLimitExceededError,
  validationError,
} from "@/lib/project-management/application/errors";
import {
  DAY_MS,
  clampLogicalRangeToThreeYears,
  contentTimeBounds,
  floorShanghaiDay,
  padShanghaiCalendarRange,
} from "@/components/project-management/time-canvas/time-math";
import {
  isTaskCreatableForSegment,
  TASK_SEGMENT_CREATABLE_STATUSES,
} from "@/lib/project-management/domain/task-segment-policy";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  timeCanvasDataDtoSchema,
  type BusyBlockDto,
  type SegmentPermissionsDto,
  type TimeCanvasDataDto,
  type TimeCanvasNodeAnchorDto,
  type TimeCanvasRowDto,
  type TimeCanvasTaskAnchorDto,
  type TimeSegmentDto,
} from "@/lib/project-management/types/time-canvas";
import {
  getTimeCanvasDataInputSchema,
  getMyTimelinePageInputSchema,
  getAdaptiveTimeCanvasBlockInputSchema,
  MAX_TIME_CANVAS_ANCHOR_NODES,
  MAX_TIME_CANVAS_ANCHOR_TASKS,
  MAX_TIME_CANVAS_VISIBLE_SEGMENTS,
  type GetTimeCanvasDataInput,
} from "@/lib/project-management/validations/time-canvas";
import { searchTaskOptions } from "@/lib/project-management/queries/option-queries";
import { getProjectDetail } from "@/lib/project-management/queries/project-queries";

const canvasTaskAuthorizationSelect = {
  id: true,
  team: true,
  techGroup: true,
  status: true,
  priority: true,
  members: {
    where: { removedAt: null },
    select: { personId: true, role: true, removedAt: true },
  },
} satisfies Prisma.TaskSelect;

const canvasRowTaskSelect = {
  ...canvasTaskAuthorizationSelect,
  title: true,
  createdAt: true,
} satisfies Prisma.TaskSelect;

const fullSegmentSelect = {
  id: true,
  personId: true,
  type: true,
  status: true,
  startAt: true,
  endAt: true,
  content: true,
  priority: true,
  expectedOutput: true,
  actualOutput: true,
  completionPercent: true,
  taskId: true,
  deletedAt: true,
  updatedAt: true,
  task: { select: canvasTaskAuthorizationSelect },
  tags: {
    select: {
      tag: { select: { id: true, name: true, color: true } },
    },
    orderBy: { tagId: "asc" },
  },
} satisfies Prisma.WorkSegmentSelect;

const busyCandidateSelect = {
  personId: true,
  startAt: true,
  endAt: true,
} satisfies Prisma.WorkSegmentSelect;

const anchorTaskSelect = {
  ...canvasRowTaskSelect,
  updatedAt: true,
  nodes: {
    where: {
      OR: [
        {
          milestone: {
            is: {
              reviews: {
                some: { result: "PENDING", revokedAt: null },
              },
            },
          },
        },
        { revision: { is: { status: "PENDING_APPROVAL" } } },
      ],
    },
    select: { id: true },
    take: 2,
  },
  currentPlanVersion: {
    select: {
      plannedStartAt: true,
      activatedAt: true,
      nodes: {
        where: { node: { deletedAt: null } },
        orderBy: { sequence: "asc" },
        select: {
          sequence: true,
          node: {
            select: {
              id: true,
              taskId: true,
              type: true,
              status: true,
              businessDescription: true,
              deletedAt: true,
              updatedAt: true,
              milestone: {
                select: {
                  goal: true,
                  expectedCompletedAt: true,
                },
              },
              revision: {
                select: {
                  reason: true,
                  revisionAt: true,
                },
              },
              termination: {
                select: {
                  name: true,
                  plannedOutcomeCriteria: true,
                  plannedAt: true,
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.TaskSelect;

type CanvasTask = Prisma.TaskGetPayload<{
  select: typeof canvasRowTaskSelect;
}>;
type FullSegment = Prisma.WorkSegmentGetPayload<{
  select: typeof fullSegmentSelect;
}>;
type AnchorTask = Prisma.TaskGetPayload<{ select: typeof anchorTaskSelect }>;

type RowPage = {
  rows: TimeCanvasRowDto[];
  rowIds: string[];
  nextCursor: string | null;
  rowUniverseWhere: Prisma.PersonWhereInput | Prisma.TaskWhereInput;
};

type CanvasCursor = {
  v: 1;
  groupBy: "PERSON" | "TASK";
  filter: string;
  id: string;
};

export async function getPersonalDueSegments({
  actor,
  now = new Date(),
  limit = 100,
}: {
  actor: ProjectManagementActor;
  now?: Date;
  limit?: number;
}) {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const rows = await prisma.workSegment.findMany({
    where: {
      personId: actor.personId,
      type: "PLANNED",
      status: "PENDING_CONFIRMATION",
      deletedAt: null,
    },
    select: fullSegmentSelect,
    orderBy: [{ endAt: "asc" }, { id: "asc" }],
    take: boundedLimit + 1,
  });
  return {
    items: rows.slice(0, boundedLimit).map((row) => toFullSegmentDto(actor, row)),
    nextCursor: rows.length > boundedLimit ? rows[boundedLimit]?.id ?? null : null,
    generatedAt: now.toISOString(),
  };
}

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
  const rowFilter = canvasCursorFilter(parsed);
  const rowPage =
    parsed.groupBy === "PERSON"
      ? await loadPersonRows(
          actor,
          parsed,
          scopeTask,
          rowFilter,
          authorizedSegmentFilter,
        )
      : await loadTaskRows(
          actor,
          parsed,
          scopeTask,
          rowFilter,
          authorizedSegmentFilter,
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
  const rowPageKey = createRowPageKey(
    actor,
    parsed,
    rowPage,
    anchors,
    undefined,
    fullSegments.map((segment) => [segment.id, segment.updatedAt.toISOString()]),
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
    segments,
    nextCursor: rowPage.nextCursor,
    generatedAt: new Date().toISOString(),
  });
}

export async function getContentDrivenTimeCanvasData({
  actor,
  input,
  preferredCenterMs,
  anchorTaskIds = [],
  load = { mode: "ALL" },
}: {
  actor: ProjectManagementActor;
  input: unknown;
  preferredCenterMs?: number;
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
  const authorizedAllTimeFilter = authorizedSegmentFilterWhere(
    actor,
    parsed,
    true,
    false,
  );
  const scopeTask = await authorizeScopeAndExplicitFilters(
    actor,
    parsed,
    authorizedAllTimeFilter,
  );
  const rowFilter = canvasCursorFilter(parsed, false);
  const rowPage = parsed.groupBy === "PERSON"
    ? await loadPersonRows(
        actor,
        parsed,
        scopeTask,
        rowFilter,
        authorizedAllTimeFilter,
      )
    : await loadTaskRows(
        actor,
        parsed,
        scopeTask,
        rowFilter,
        authorizedAllTimeFilter,
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
  const [segmentBounds, anchors] = await Promise.all([
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
  ]);
  const timestamps: number[] = [];
  if (segmentBounds._min.startAt) timestamps.push(segmentBounds._min.startAt.getTime());
  if (segmentBounds._max.endAt) timestamps.push(segmentBounds._max.endAt.getTime() - 1);
  for (const task of anchors) {
    timestamps.push(Date.parse(task.plannedStartAt ?? task.createdAt));
    for (const node of task.nodes) {
      if (node.plannedAt) timestamps.push(Date.parse(node.plannedAt));
    }
  }
  const contentRange = contentTimeBounds(timestamps);
  const fullRange = padShanghaiCalendarRange(contentRange, 2, seedStart);
  const now = Date.now();
  const fallbackCenterMs = now >= fullRange.startMs && now < fullRange.endMs
    ? now
    : (contentRange?.startMs ?? (fullRange.startMs + fullRange.endMs) / 2);
  const resolvedCenterMs = requestedCenterMs !== null &&
      requestedCenterMs >= fullRange.startMs &&
      requestedCenterMs < fullRange.endMs
    ? requestedCenterMs
    : fallbackCenterMs;
  const logical = clampLogicalRangeToThreeYears(fullRange, resolvedCenterMs);
  const rowPageKey = createRowPageKey(
    actor,
    parsed,
    rowPage,
    anchors,
    logical.range,
    {
      count: segmentBounds._count._all,
      latestUpdatedAt: segmentBounds._max.updatedAt?.toISOString() ?? null,
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
    segments: blockResult.segments,
    nextCursor: rowPage.nextCursor,
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

export async function getMyTimelinePageData({
  actor,
  input,
  preferredCenterMs,
  load,
}: {
  actor: ProjectManagementActor;
  input: unknown;
  preferredCenterMs?: number;
  load?: Parameters<typeof getContentDrivenTimeCanvasData>[0]["load"];
}) {
  const selector = getMyTimelinePageInputSchema.parse(input);
  const taskPage = await searchTaskOptions({
    actor,
    input: {
      mine: true,
      statuses: selector.showAll ? [] : ["ACTIVE"],
      cursor: selector.taskCursor,
      limit: 25,
    },
  });
  const canvas = await getContentDrivenTimeCanvasData({
    actor,
    preferredCenterMs,
    anchorTaskIds: taskPage.items.map((task) => task.id),
    load,
    input: {
      scope: { kind: "PERSONAL" },
      personIds: [actor.personId],
      taskIds: [],
      tagIds: [],
      types: [],
      statuses: [],
      groupBy: "PERSON",
      includeTaskAnchors: true,
      includeActual: true,
      includeBusyBlocks: false,
      rowLimit: 25,
    },
  });
  return { taskPage, ...canvas };
}

export async function getAdaptiveTimeCanvasBlock({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}) {
  const parsed = getAdaptiveTimeCanvasBlockInputSchema.parse(input);
  const preferredCenterMs = parsed.preferredCenter.getTime();
  const load = {
    mode: "BLOCK" as const,
    range: {
      startMs: parsed.blockStart.getTime(),
      endMs: parsed.blockEnd.getTime(),
    },
    expectedRowPageKey: parsed.rowPageKey,
  };
  const result = parsed.kind === "MY_TIMELINE"
    ? await getMyTimelinePageData({
        actor,
        input: { showAll: parsed.showAll, taskCursor: parsed.taskCursor },
        preferredCenterMs,
        load,
      })
    : parsed.kind === "TASK"
      ? await getContentDrivenTimeCanvasData({
          actor,
          preferredCenterMs,
          load,
          input: {
            scope: { kind: "TASK_SCOPED", taskId: parsed.taskId },
            personIds: [],
            taskIds: [],
            tagIds: [],
            types: [],
            statuses: [],
            groupBy: "PERSON",
            includeTaskAnchors: true,
            includeActual: true,
            includeBusyBlocks: false,
            rowLimit: 50,
          },
        })
      : await loadProjectTimeCanvasBlock(actor, parsed, preferredCenterMs, load);
  return {
    rowPageKey: result.data.rowPageKey,
    logicalRange: result.data.range,
    loadedRange: result.loadedRange,
    groupBy: result.data.groupBy,
    segments: result.data.segments,
    generatedAt: result.data.generatedAt,
    leafBlockCount: result.leafBlockCount,
    failedRanges: result.failedRanges,
  };
}

async function loadProjectTimeCanvasBlock(
  actor: ProjectManagementActor,
  input: Extract<
    ReturnType<typeof getAdaptiveTimeCanvasBlockInputSchema.parse>,
    { kind: "PROJECT" }
  >,
  preferredCenterMs: number,
  load: Extract<
    NonNullable<Parameters<typeof getContentDrivenTimeCanvasData>[0]["load"]>,
    { mode: "BLOCK" }
  >,
) {
  const project = await getProjectDetail({
    actor,
    projectId: input.projectId,
    pagination: { taskCursor: input.taskCursor, pageSize: 25 },
  });
  const personIds = [...new Set([
    ...project.members.map((member) => member.personId),
    ...project.tasks.flatMap((task) => task.members.map((member) => member.personId)),
  ])];
  if (personIds.length > 50) {
    throw queryLimitExceededError("当前页 Project/Task 有效成员超过 50 人");
  }
  return getContentDrivenTimeCanvasData({
    actor,
    preferredCenterMs,
    load,
    anchorTaskIds: project.tasks.map((task) => task.id),
    input: {
      scope: { kind: "RESOURCE_PLANNER" },
      personIds,
      taskIds: project.tasks.map((task) => task.id),
      tagIds: [],
      types: [],
      statuses: [],
      groupBy: "PERSON",
      includeTaskAnchors: true,
      includeActual: true,
      includeBusyBlocks: false,
      rowLimit: 50,
    },
  });
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

export async function loadBoundedAdaptiveLeaves<T>({
  ranges,
  loadRange,
}: {
  ranges: Array<{ startMs: number; endMs: number }>;
  loadRange: (range: { startMs: number; endMs: number }) => Promise<T[]>;
}) {
  const pending = [...ranges];
  const leaves: T[][] = [];
  const failedRanges: Array<{ startMs: number; endMs: number; message: string }> = [];
  let objectCount = 0;
  let queryCount = 0;
  while (pending.length > 0) {
    const range = pending.shift()!;
    if (queryCount >= 31) {
      throw queryLimitExceededError("时间对象过于密集，自动细分查询超过安全预算");
    }
    queryCount += 1;
    const values = await loadRange(range);
    if (values.length <= MAX_TIME_CANVAS_VISIBLE_SEGMENTS) {
      if (leaves.length + failedRanges.length >= 16) {
        throw queryLimitExceededError("时间对象过于密集，自动细分后超过 16 个数据块");
      }
      objectCount += values.length;
      if (objectCount > 20_000) {
        throw queryLimitExceededError("时间画布对象超过 20000 条缓存预算，请缩小筛选范围");
      }
      leaves.push(values);
      continue;
    }
    if (range.endMs - range.startMs <= DAY_MS) {
      if (leaves.length + failedRanges.length >= 16) {
        throw queryLimitExceededError("时间对象过于密集，自动细分后超过 16 个数据块");
      }
      failedRanges.push({
        ...range,
        message: "单个上海自然日内的时间对象超过 5000 条，请缩小筛选范围",
      });
      continue;
    }
    if (leaves.length + failedRanges.length + pending.length + 2 > 16) {
      throw queryLimitExceededError("时间对象过于密集，自动细分后超过 16 个数据块");
    }
    const middle = floorShanghaiDay((range.startMs + range.endMs) / 2);
    const split = middle > range.startMs && middle < range.endMs
      ? middle
      : Math.min(range.endMs, range.startMs + DAY_MS);
    pending.unshift(
      { startMs: range.startMs, endMs: split },
      { startMs: split, endMs: range.endMs },
    );
  }
  return {
    leaves,
    failedRanges: failedRanges.sort((left, right) => left.startMs - right.startMs),
    queryCount,
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

async function authorizeScopeAndExplicitFilters(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  authorizedSegmentFilter: Prisma.WorkSegmentWhereInput,
): Promise<CanvasTask | null> {
  let scopeTask: CanvasTask | null = null;
  if (input.scope.kind === "TASK_SCOPED") {
    scopeTask = await prisma.task.findFirst({
      where: {
        AND: [{ id: input.scope.taskId }, taskReadableWhere(actor)],
      },
      select: canvasRowTaskSelect,
    });
    if (!scopeTask) throw notFoundError();
    if (
      input.taskIds.length > 0 &&
      input.taskIds.some((taskId) => taskId !== scopeTask?.id)
    ) {
      throw notFoundError();
    }
  }
  if (
    (input.scope.kind === "PERSONAL" || input.scope.kind === "DASHBOARD") &&
    input.personIds.some((personId) => personId !== actor.personId)
  ) {
    throw notFoundError();
  }

  if (input.personIds.length > 0) {
    const personWhere = personUniverseWhere(actor, input, scopeTask);
    const count = await prisma.person.count({
      where: {
        AND: [
          { id: { in: input.personIds } },
          personWhere,
          personAvailableInRangeWhere(authorizedSegmentFilter),
        ],
      },
    });
    if (count !== input.personIds.length) throw notFoundError();
  }
  if (input.taskIds.length > 0) {
    const count = await prisma.task.count({
      where: {
        AND: [
          { id: { in: input.taskIds } },
          taskReadableWhere(actor),
        ],
      },
    });
    if (count !== input.taskIds.length) throw notFoundError();
  }
  if (input.tagIds.length > 0) {
    const count = await prisma.tag.count({
      where: { id: { in: input.tagIds }, archivedAt: null },
    });
    if (count !== input.tagIds.length) throw notFoundError();
  }
  return scopeTask;
}

async function loadPersonRows(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  scopeTask: CanvasTask | null,
  filter: string,
  authorizedSegmentFilter: Prisma.WorkSegmentWhereInput,
): Promise<RowPage> {
  const universe = personUniverseWhere(actor, input, scopeTask);
  const where: Prisma.PersonWhereInput = {
    AND: [
      universe,
      personAvailableInRangeWhere(authorizedSegmentFilter),
      input.personIds.length > 0 ? { id: { in: input.personIds } } : {},
      tagFilteredRowWhere(input, authorizedSegmentFilter),
    ],
  };
  const cursorId = await validateCanvasCursor({
    cursor: input.cursor,
    groupBy: "PERSON",
    filter,
    exists: (id) =>
      prisma.person.findFirst({ where: { AND: [{ id }, where] }, select: { id: true } }),
  });
  const people = await prisma.person.findMany({
    where,
    select: {
      id: true,
      displayName: true,
      status: true,
      taskMembers:
        input.scope.kind === "TASK_SCOPED"
          ? {
              where: { taskId: input.scope.taskId, removedAt: null },
              select: { role: true },
              orderBy: { role: "asc" as const },
            }
          : false,
    },
    orderBy: [{ displayName: "asc" }, { id: "asc" }],
    take: input.rowLimit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
  });
  const page = people.slice(0, input.rowLimit);
  const canCreateByPersonId = await loadPersonCreateCapabilities(
    actor,
    input,
    scopeTask,
    page.map((person) => person.id),
  );
  const rows = page.map((person) => {
    const taskMembers = "taskMembers" in person ? person.taskMembers : [];
    return {
      kind: "PERSON" as const,
      id: person.id,
      label:
        person.status === "INACTIVE"
          ? `${person.displayName}（已停用）`
          : person.displayName,
      sublabel:
        taskMembers.length > 0
          ? taskMembers.map((member) => member.role).join(" / ")
          : null,
      capabilities: {
        canCreateSegment:
          person.status === "ACTIVE" &&
          (canCreateByPersonId.get(person.id) ?? false),
      },
    };
  });
  return {
    rows,
    rowIds: rows.map((row) => row.id),
    nextCursor:
      people.length > input.rowLimit
        ? encodeCanvasCursor("PERSON", filter, rows.at(-1)?.id)
        : null,
    rowUniverseWhere: where,
  };
}

function personAvailableInRangeWhere(
  authorizedSegmentFilter: Prisma.WorkSegmentWhereInput,
): Prisma.PersonWhereInput {
  return {
    OR: [
      { status: "ACTIVE" },
      { workSegments: { some: authorizedSegmentFilter } },
    ],
  };
}

async function loadTaskRows(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  scopeTask: CanvasTask | null,
  filter: string,
  authorizedSegmentFilter?: Prisma.WorkSegmentWhereInput,
): Promise<RowPage> {
  const actorCanCreateSegments = Boolean(
    await prisma.person.findFirst({
      where: {
        id: actor.personId,
        accountId: actor.accountId,
        status: "ACTIVE",
      },
      select: { id: true },
    }),
  );
  const universe = taskUniverseWhere(actor, input, scopeTask);
  const where: Prisma.TaskWhereInput = {
    AND: [
      universe,
      input.taskIds.length > 0 ? { id: { in: input.taskIds } } : {},
      taskTagFilteredRowWhere(actor, input, authorizedSegmentFilter),
    ],
  };
  const cursorId = await validateCanvasCursor({
    cursor: input.cursor,
    groupBy: "TASK",
    filter,
    exists: (id) =>
      prisma.task.findFirst({ where: { AND: [{ id }, where] }, select: { id: true } }),
  });
  const tasks = await prisma.task.findMany({
    where,
    select: canvasRowTaskSelect,
    orderBy: [{ title: "asc" }, { id: "asc" }],
    take: input.rowLimit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
  });
  const page = tasks.slice(0, input.rowLimit);
  const rows = page.map((task) => ({
    kind: "TASK" as const,
    id: task.id,
    label: task.title,
    sublabel: `${task.status} / ${task.priority}`,
    capabilities: {
      canCreateSegment:
        actorCanCreateSegments &&
        isTaskCreatableForSegment(task.status) &&
        authorize({
          actor,
          action: "segment.manage_self",
          resource: {
            type: "segment",
            personId: actor.personId,
            task: taskResource(task),
          },
        }).allowed,
    },
  }));
  return {
    rows,
    rowIds: rows.map((row) => row.id),
    nextCursor:
      tasks.length > input.rowLimit
        ? encodeCanvasCursor("TASK", filter, rows.at(-1)?.id)
        : null,
    rowUniverseWhere: where,
  };
}

function personUniverseWhere(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  scopeTask: CanvasTask | null,
): Prisma.PersonWhereInput {
  if (input.scope.kind === "PERSONAL" || input.scope.kind === "DASHBOARD") {
    return { id: actor.personId };
  }
  if (input.scope.kind === "TASK_SCOPED") {
    return {
      taskMembers: {
        some: { taskId: scopeTask?.id ?? input.scope.taskId, removedAt: null },
      },
    };
  }
  return {
    OR: [
      { status: "ACTIVE" },
      {
        workSegments: {
          some: segmentReadableWhere(actor),
        },
      },
    ],
  };
}

function taskUniverseWhere(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  scopeTask: CanvasTask | null,
): Prisma.TaskWhereInput {
  if (input.scope.kind === "TASK_SCOPED") {
    return {
      AND: [taskReadableWhere(actor), { id: scopeTask?.id ?? input.scope.taskId }],
    };
  }
  if (input.scope.kind === "PERSONAL" || input.scope.kind === "DASHBOARD") {
    return {
      AND: [
        taskReadableWhere(actor),
        {
          members: {
            some: { personId: actor.personId, removedAt: null },
          },
        },
      ],
    };
  }
  return taskReadableWhere(actor);
}

function fullSegmentUniverseWhere(
  input: GetTimeCanvasDataInput,
  rowUniverseWhere: Prisma.PersonWhereInput | Prisma.TaskWhereInput,
  authorizedSegmentFilter: Prisma.WorkSegmentWhereInput,
): Prisma.WorkSegmentWhereInput {
  return {
    AND: [
      authorizedSegmentFilter,
      input.groupBy === "PERSON"
        ? { person: rowUniverseWhere as Prisma.PersonWhereInput }
        : {
            task: {
              is: rowUniverseWhere as Prisma.TaskWhereInput,
            },
          },
    ],
  };
}

function authorizedSegmentFilterWhere(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  includeTagFilter = true,
  includeRange = true,
): Prisma.WorkSegmentWhereInput {
  return {
    AND: [
      segmentReadableWhere(actor),
      segmentFilterWhere(input, actor.personId, includeTagFilter, includeRange),
    ],
  };
}

function tagFilteredRowWhere(
  input: GetTimeCanvasDataInput,
  authorizedSegmentFilter: Prisma.WorkSegmentWhereInput,
) {
  return input.tagIds.length > 0
    ? { workSegments: { some: authorizedSegmentFilter } }
    : {};
}

function taskTagFilteredRowWhere(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  authorizedSegmentFilter?: Prisma.WorkSegmentWhereInput,
): Prisma.TaskWhereInput {
  if (input.tagIds.length === 0) return {};
  return {
    OR: [
      {
        AND: [
          { tags: { some: { tagId: { in: input.tagIds } } } },
          input.personIds.length > 0
            ? {
                members: {
                  some: {
                    personId: { in: input.personIds },
                    removedAt: null,
                  },
                },
              }
            : {},
          input.types.length > 0 ||
          input.statuses.length > 0
            ? { id: { in: [] } }
            : {},
        ],
      },
      {
        workSegments: {
          some: {
            AND: [
              authorizedSegmentFilter ?? authorizedSegmentFilterWhere(actor, input, false),
              { tags: { some: { tagId: { in: input.tagIds } } } },
            ],
          },
        },
      },
    ],
  };
}

function segmentFilterWhere(
  input: GetTimeCanvasDataInput,
  actorPersonId: string,
  includeTagFilter = true,
  includeRange = true,
): Prisma.WorkSegmentWhereInput {
  return {
    AND: [
      {
        deletedAt: null,
        NOT: {
          AND: [
            { type: "PLANNED" },
            { status: { in: ["CONFIRMED", "CANCELLED"] } },
          ],
        },
        ...(includeRange
          ? {
              startAt: { lt: input.rangeEnd },
              endAt: { gt: input.rangeStart },
            }
          : {}),
      },
      input.scope.kind === "PERSONAL" || input.scope.kind === "DASHBOARD"
        ? { personId: actorPersonId }
        : {},
      input.personIds.length > 0
        ? { personId: { in: input.personIds } }
        : {},
      input.taskIds.length > 0 ? { taskId: { in: input.taskIds } } : {},
      includeTagFilter && input.tagIds.length > 0
        ? {
            OR: [
              { tags: { some: { tagId: { in: input.tagIds } } } },
              {
                task: {
                  tags: { some: { tagId: { in: input.tagIds } } },
                },
              },
            ],
          }
        : {},
      input.types.length > 0 ? { type: { in: input.types } } : {},
      input.statuses.length > 0 ? { status: { in: input.statuses } } : {},
      input.includeActual ? {} : { type: { not: "ACTUAL" } },
    ],
  };
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

async function loadTaskAnchors(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  scopeTask: CanvasTask | null,
  rowIds: string[],
  segments: FullSegment[],
): Promise<TimeCanvasTaskAnchorDto[]> {
  const candidateIds = new Set<string>();
  if (input.groupBy === "TASK") {
    rowIds.forEach((taskId) => candidateIds.add(taskId));
  } else {
    if (scopeTask) candidateIds.add(scopeTask.id);
    input.taskIds.forEach((taskId) => candidateIds.add(taskId));
    segments.forEach((segment) => {
      if (segment.taskId) candidateIds.add(segment.taskId);
    });
  }
  if (candidateIds.size === 0) return [];
  const anchorWhere: Prisma.TaskWhereInput = {
    AND: [{ id: { in: [...candidateIds] } }, taskReadableWhere(actor)],
  };
  const candidates = await prisma.task.findMany({
    where: anchorWhere,
    select: { id: true, currentPlanVersionId: true },
    orderBy: [{ title: "asc" }, { id: "asc" }],
    take: MAX_TIME_CANVAS_ANCHOR_TASKS + 1,
  });
  if (candidates.length > MAX_TIME_CANVAS_ANCHOR_TASKS) {
    throw queryLimitExceededError(
      "授权过滤后的 Task anchor 超过 50 条，请缩小范围后重试",
    );
  }
  const nodeCount = await prisma.planVersionNode.count({
    where: {
      planVersionId: {
        in: candidates.map((task) => task.currentPlanVersionId),
      },
      node: { deletedAt: null },
    },
  });
  if (nodeCount > MAX_TIME_CANVAS_ANCHOR_NODES) {
    throw queryLimitExceededError(
      "授权过滤后的 anchor Node 超过 5000 条，请缩小范围后重试",
    );
  }
  const tasks = await prisma.task.findMany({
    where: {
      AND: [
        { id: { in: candidates.map((task) => task.id) } },
        taskReadableWhere(actor),
      ],
    },
    select: anchorTaskSelect,
    orderBy: [{ title: "asc" }, { id: "asc" }],
  });
  const serializedNodeCount = tasks.reduce(
    (count, task) => count + task.currentPlanVersion.nodes.length,
    0,
  );
  if (serializedNodeCount > MAX_TIME_CANVAS_ANCHOR_NODES) {
    throw queryLimitExceededError(
      "授权过滤后的 anchor Node 超过 5000 条，请缩小范围后重试",
    );
  }
  return tasks.map((task) => toTaskAnchorDto(actor, task));
}

function toTaskAnchorDto(
  actor: ProjectManagementActor,
  task: AnchorTask,
): TimeCanvasTaskAnchorDto {
  const resource = taskResource(task);
  const taskCanEdit =
    (task.status === "DRAFT" || task.status === "ACTIVE") &&
    authorize({ actor, action: "task.update_metadata", resource }).allowed;
  const canManageMembers =
    (task.status === "DRAFT" || task.status === "ACTIVE") &&
    authorize({ actor, action: "task.manage_members", resource }).allowed;
  const hasPendingApproval = task.nodes.length > 0;
  const updatedAt = task.updatedAt.toISOString();
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    createdAt: task.createdAt.toISOString(),
    plannedStartAt: task.currentPlanVersion.plannedStartAt?.toISOString() ?? null,
    capabilities: {
      canView: true,
      canUpdateMetadata: taskCanEdit,
      canManageMembers,
      canManageTags: taskCanEdit,
      canActivate:
        task.status === "DRAFT" &&
        authorize({ actor, action: "task.activate", resource }).allowed,
      canArchive:
        isTerminalTaskStatus(task.status) &&
        authorize({ actor, action: "task.archive", resource }).allowed,
      canCreateRevision:
        task.status === "ACTIVE" &&
        !hasPendingApproval &&
        authorize({ actor, action: "revision.create", resource }).allowed,
    },
    nodes: task.currentPlanVersion.nodes.flatMap((entry) => {
      if (entry.node.deletedAt) return [];
      return [toNodeAnchorDto(actor, task, entry.sequence, entry.node)];
    }),
    updatedAt,
    versionToken: updatedAt,
  };
}

function toNodeAnchorDto(
  actor: ProjectManagementActor,
  task: AnchorTask,
  sequence: number,
  node: AnchorTask["currentPlanVersion"]["nodes"][number]["node"],
): TimeCanvasNodeAnchorDto {
  const resource = taskResource(task);
  const isDraftEditable =
    task.status === "DRAFT" &&
    task.currentPlanVersion.activatedAt === null &&
    authorize({ actor, action: "task.update_metadata", resource }).allowed;
  const isActivePlannedNode =
    task.status === "ACTIVE" &&
    node.status !== "REVISED" &&
    node.status !== "CANCELLED";
  const hasPendingApproval = task.nodes.length > 0;
  const updatedAt = node.updatedAt.toISOString();
  return {
    id: node.id,
    taskId: node.taskId,
    type: node.type,
    status: node.status,
    sequence,
    label: nodeLabel(node),
    plannedAt: nodePlannedAt(node)?.toISOString() ?? null,
    capabilities: {
      canView: true,
      canEditDraft: isDraftEditable,
      canCreateSegment:
        isTaskCreatableForSegment(task.status) &&
        (isDraftEditable || isActivePlannedNode) &&
        authorize({
          actor,
          action: "segment.manage_self",
          resource: {
            type: "segment",
            personId: actor.personId,
            task: resource,
          },
        }).allowed,
      canSubmitReview:
        node.type === "MILESTONE" &&
        node.status === "ACTIVE" &&
        !hasPendingApproval &&
        authorize({
          actor,
          action: "milestone.submit_review",
          resource,
        }).allowed,
      canReview:
        node.type === "MILESTONE" &&
        node.status === "ACTIVE" &&
        authorize({ actor, action: "milestone.review", resource }).allowed,
      canConfirmTermination:
        node.type === "TERMINATION" &&
        task.status === "ACTIVE" &&
        !hasPendingApproval &&
        authorize({ actor, action: "task.terminate", resource }).allowed,
    },
    updatedAt,
    versionToken: updatedAt,
  };
}

function toFullSegmentDto(
  actor: ProjectManagementActor,
  segment: FullSegment,
): TimeSegmentDto {
  const updatedAt = segment.updatedAt.toISOString();
  return {
    kind: "SEGMENT",
    visibility: "FULL",
    id: segment.id,
    personId: segment.personId,
    type: segment.type,
    status: segment.status,
    startAt: segment.startAt.toISOString(),
    endAt: segment.endAt.toISOString(),
    content: segment.content,
    priority: segment.priority,
    expectedOutput: segment.expectedOutput,
    actualOutput: segment.actualOutput,
    completionPercent: decimalToNumber(segment.completionPercent),
    taskId: segment.taskId,
    tags: segment.tags.map((entry) => ({
      id: entry.tag.id,
      name: entry.tag.name,
      color: entry.tag.color,
    })),
    permissions: segmentPermissions(actor, segment),
    updatedAt,
    versionToken: updatedAt,
  };
}

function segmentPermissions(
  actor: ProjectManagementActor,
  segment: FullSegment,
): SegmentPermissionsDto {
  const canManage = authorize({
    actor,
    action:
      segment.personId === actor.personId
        ? "segment.manage_self"
        : "segment.manage_others",
    resource: {
      type: "segment",
      personId: segment.personId,
      task: segment.task ? taskResource(segment.task) : null,
    },
  }).allowed;
  const available = !segment.deletedAt && segment.status !== "CANCELLED";
  if (segment.type === "ACTUAL") {
    const editable = canManage && available && segment.status === "CONFIRMED";
    return {
      canViewDetails: true,
      canEdit: editable,
      canMove: false,
      canResize: false,
      canMerge: false,
      canCancel: false,
      canConfirm: false,
      canSoftDelete: editable,
    };
  }
  const editable =
    canManage &&
    available &&
    segment.status !== "CONFIRMED";
  return {
    canViewDetails: true,
    canEdit: editable,
    canMove: editable,
    canResize: editable,
    canMerge: editable,
    canCancel: editable,
    canConfirm: editable,
    canSoftDelete: false,
  };
}

function canCreateForPerson(
  actor: ProjectManagementActor,
  personId: string,
  task: CanvasTask | null,
) {
  return authorize({
    actor,
    action:
      personId === actor.personId
        ? "segment.manage_self"
        : "segment.manage_others",
    resource: {
      type: "segment",
      personId,
      task: task ? taskResource(task) : null,
    },
  }).allowed;
}

async function loadPersonCreateCapabilities(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  scopeTask: CanvasTask | null,
  personIds: string[],
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (personIds.length === 0) return result;

  const singleTaskId =
    scopeTask?.id ?? (input.taskIds.length === 1 ? input.taskIds[0] : undefined);
  if (singleTaskId) {
    const task =
      scopeTask ??
      (await prisma.task.findFirst({
        where: {
          AND: [{ id: singleTaskId }, taskReadableWhere(actor)],
        },
        select: canvasRowTaskSelect,
      }));
    for (const personId of personIds) {
      result.set(
        personId,
        Boolean(
          task &&
            isEligibleSegmentTask(task.status) &&
            hasActiveTaskMember(task, personId) &&
            canCreateForPerson(actor, personId, task),
        ),
      );
    }
    return result;
  }

  const hasOtherPeople = personIds.some(
    (personId) => personId !== actor.personId,
  );
  const selfRequiresTask = input.taskIds.length > 0;
  const otherPersonIds = personIds.filter(
    (personId) => personId !== actor.personId,
  );
  const [hasSelfEligibleTask, manageablePersonIds] = await Promise.all([
    selfRequiresTask && personIds.includes(actor.personId)
      ? eligibleTaskExists(input, {
          AND: [
            taskReadableWhere(actor),
            {
              members: {
                some: {
                  personId: actor.personId,
                  role: { in: ["OWNER", "PARTICIPANT"] },
                  removedAt: null,
                },
              },
            },
          ],
        })
      : Promise.resolve(false),
    hasOtherPeople
      ? manageableEligibleTaskPersonIds(actor, input, otherPersonIds)
      : Promise.resolve(new Set<string>()),
  ]);
  for (const personId of personIds) {
    result.set(
      personId,
      personId === actor.personId
        ? selfRequiresTask
          ? hasSelfEligibleTask
          : canCreateForPerson(actor, personId, null)
        : manageablePersonIds.has(personId),
    );
  }
  return result;
}

async function manageableEligibleTaskPersonIds(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  personIds: string[],
): Promise<Set<string>> {
  const memberships = await prisma.taskMember.findMany({
    where: {
      personId: { in: personIds },
      role: { in: ["OWNER", "PARTICIPANT"] },
      removedAt: null,
      task: {
        AND: [
          manageableTaskWhere(actor),
          {
            status: { in: [...TASK_SEGMENT_CREATABLE_STATUSES] },
          },
          input.taskIds.length > 0 ? { id: { in: input.taskIds } } : {},
        ],
      },
    },
    select: { personId: true },
    distinct: ["personId"],
  });
  return new Set(memberships.map((membership) => membership.personId));
}

async function eligibleTaskExists(
  input: GetTimeCanvasDataInput,
  authorizationWhere: Prisma.TaskWhereInput,
): Promise<boolean> {
  const task = await prisma.task.findFirst({
    where: {
      AND: [
        authorizationWhere,
        {
          deletedAt: null,
          status: { in: [...TASK_SEGMENT_CREATABLE_STATUSES] },
        },
        input.taskIds.length > 0 ? { id: { in: input.taskIds } } : {},
      ],
    },
    select: { id: true },
  });
  return task !== null;
}

function manageableTaskWhere(
  actor: ProjectManagementActor,
): Prisma.TaskWhereInput {
  if (isSystemAdministrator(actor)) return { deletedAt: null };
  return {
    deletedAt: null,
    members: {
      some: {
        personId: actor.personId,
        role: "OWNER",
        removedAt: null,
      },
    },
  };
}

function isEligibleSegmentTask(status: Task["status"]): boolean {
  return isTaskCreatableForSegment(status);
}

function hasActiveTaskMember(task: CanvasTask, personId: string): boolean {
  return task.members.some(
    (member) =>
      member.personId === personId &&
      member.removedAt === null &&
      (member.role === "OWNER" || member.role === "PARTICIPANT"),
  );
}

function taskResource(
  task: Pick<
    CanvasTask,
    | "id"
    | "team"
    | "techGroup"
    | "status"
    | "priority"
    | "members"
  >,
): AuthorizationTaskResource {
  return {
    type: "task",
    id: task.id,
    team: task.team,
    techGroup: task.techGroup,
    status: task.status,
    priority: task.priority,
    members: task.members,
  };
}

function nodeLabel(
  node: AnchorTask["currentPlanVersion"]["nodes"][number]["node"],
): string {
  if (node.milestone) return node.milestone.goal;
  if (node.revision) return node.revision.reason;
  if (node.termination) return node.termination.name;
  return node.businessDescription.trim() || node.type;
}

function nodePlannedAt(
  node: AnchorTask["currentPlanVersion"]["nodes"][number]["node"],
): Date | null {
  if (node.milestone) return node.milestone.expectedCompletedAt;
  if (node.termination) return node.termination.plannedAt;
  if (node.revision) return node.revision.revisionAt;
  return null;
}

function isTerminalTaskStatus(status: Task["status"]): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "TIMEOUT"
  );
}

function decimalToNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value.toString());
}

function canvasCursorFilter(
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
        tagIds: [...input.tagIds].sort(),
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

function createRowPageKey(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  rowPage: RowPage,
  anchors: TimeCanvasTaskAnchorDto[],
  logicalRange?: { startMs: number; endMs: number },
  segmentEpoch?: unknown,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        actorAccountId: actor.accountId,
        semanticFilter: canvasCursorFilter(input, !logicalRange),
        logicalRange: logicalRange
          ? [new Date(logicalRange.startMs).toISOString(), new Date(logicalRange.endMs).toISOString()]
          : [input.rangeStart.toISOString(), input.rangeEnd.toISOString()],
        rows: rowPage.rows,
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

function encodeCanvasCursor(
  groupBy: "PERSON" | "TASK",
  filter: string,
  id: string | undefined,
): string | null {
  if (!id) return null;
  return Buffer.from(
    JSON.stringify({ v: 1, groupBy, filter, id } satisfies CanvasCursor),
  ).toString("base64url");
}

async function validateCanvasCursor({
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
