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
} from "@/lib/project-management/time-canvas/time-math";
import {
  isTaskCreatableForSegment,
  TASK_SEGMENT_CREATABLE_STATUSES,
} from "@/lib/project-management/domain/task-segment-policy";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  timeCanvasDataDtoSchema,
  type BusyBlockDto,
  type TimeCanvasDataDto,
  type TimeCanvasRowDto,
  type TimeCanvasTaskAnchorDto,
  type TimeSegmentDto,
} from "@/lib/project-management/types/time-canvas";
import {
  getTimeCanvasDataInputSchema,
  getMyTimelinePageInputSchema,
  getAdaptiveTimeCanvasBlockInputSchema,
  MAX_TIME_CANVAS_ANCHOR_NODES,
  MAX_TIME_CANVAS_VISIBLE_SEGMENTS,
  type GetTimeCanvasDataInput,
} from "@/lib/project-management/validations/time-canvas";
import { listPersonalDueSegmentsInputSchema } from "@/lib/project-management/validations/segments";
import { listMyTaskOptions } from "@/lib/project-management/queries/option-queries";
import { getProjectDetail } from "@/lib/project-management/queries/project-queries";
import { getResourcePlanSelection } from "@/lib/project-management/queries/resource-plan-queries";
import { taskAuthorizationResource } from "@/lib/project-management/application/task-authorization-resource";
import {
  anchorTaskSelect,
  busyCandidateSelect,
  canvasRowTaskSelect,
  fullSegmentSelect,
  type CanvasTask,
  type FullSegment,
} from "@/lib/project-management/queries/time-canvas-records";
import {
  canCreateForPerson,
  toFullSegmentDto,
  toTaskAnchorDto,
} from "@/lib/project-management/queries/time-canvas-dto";
import {
  createRowPageKey,
  decodePersonalDueCursor,
  encodePersonalDueCursor,
} from "@/lib/project-management/queries/time-canvas-cursor";
import { loadBoundedAdaptiveLeaves } from "@/lib/project-management/queries/time-canvas-adaptive-loader";

export { loadBoundedAdaptiveLeaves } from "@/lib/project-management/queries/time-canvas-adaptive-loader";

type RowPage = {
  rows: TimeCanvasRowDto[];
  rowIds: string[];
  rowUniverseWhere: Prisma.PersonWhereInput | Prisma.TaskWhereInput;
};

export async function getPersonalDueSegments({
  actor,
  input,
  now = new Date(),
}: {
  actor: ProjectManagementActor;
  input?: unknown;
  now?: Date;
}) {
  const parsed = listPersonalDueSegmentsInputSchema.parse(input ?? {});
  const cursor = parsed.cursor
    ? decodePersonalDueCursor(parsed.cursor, actor.personId)
    : null;
  if (parsed.cursor && !cursor) {
    throw validationError("分页游标无效或已不再匹配当前到期队列", {
      cursor: ["分页游标无效或已不再匹配当前到期队列"],
    });
  }
  if (cursor) {
    const anchor = await prisma.workSegment.findFirst({
      where: { id: cursor.id, personId: actor.personId },
      select: { id: true },
    });
    if (!anchor) {
      throw validationError("分页游标无效或已不再匹配当前到期队列", {
        cursor: ["分页游标无效或已不再匹配当前到期队列"],
      });
    }
  }
  const rows = await prisma.workSegment.findMany({
    where: {
      AND: [
        {
          personId: actor.personId,
          type: "PLANNED",
          status: "PENDING_CONFIRMATION",
          endAt: { lte: now },
          deletedAt: null,
        },
        isSystemAdministrator(actor)
          ? {}
          : {
              OR: [
                { taskId: null },
                {
                  task: {
                    members: {
                      some: {
                        personId: actor.personId,
                        role: { in: ["OWNER", "PARTICIPANT"] },
                        removedAt: null,
                      },
                    },
                  },
                },
              ],
            },
        cursor
          ? {
              OR: [
                { endAt: { gt: new Date(cursor.endAt) } },
                {
                  endAt: new Date(cursor.endAt),
                  id: { gt: cursor.id },
                },
              ],
            }
          : {},
      ],
    },
    select: fullSegmentSelect,
    orderBy: [{ endAt: "asc" }, { id: "asc" }],
    take: parsed.limit + 1,
  });
  const page = rows.slice(0, parsed.limit);
  return {
    items: page.map((row) => ({
      ...toFullSegmentDto(actor, row),
      taskTitle: row.task?.title ?? null,
    })),
    nextCursor: rows.length > parsed.limit
      ? encodePersonalDueCursor(page.at(-1), actor.personId)
      : null,
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
  const rowPageKey = createRowPageKey(
    actor,
    parsed,
    rowPage.rows,
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
  const now = Date.now();
  const contentNavigationRange = padShanghaiCalendarRange(contentRange, 2, seedStart);
  const todayNavigationRange = padShanghaiCalendarRange(null, 2, now);
  const fullRange = {
    startMs: Math.min(contentNavigationRange.startMs, todayNavigationRange.startMs),
    endMs: Math.max(contentNavigationRange.endMs, todayNavigationRange.endMs),
  };
  const fallbackCenterMs = now >= contentNavigationRange.startMs &&
      now < contentNavigationRange.endMs
    ? now
    : (contentRange?.startMs ??
      (contentNavigationRange.startMs + contentNavigationRange.endMs) / 2);
  const resolvedCenterMs = requestedCenterMs !== null &&
      requestedCenterMs >= fullRange.startMs &&
      requestedCenterMs < fullRange.endMs
    ? requestedCenterMs
    : fallbackCenterMs;
  const logical = clampLogicalRangeToThreeYears(fullRange, resolvedCenterMs);
  const rowPageKey = createRowPageKey(
    actor,
    parsed,
    rowPage.rows,
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
  const tasks = await listMyTaskOptions({
    actor,
    statuses: selector.showAll ? [] : ["ACTIVE"],
  });
  const canvas = await getContentDrivenTimeCanvasData({
    actor,
    preferredCenterMs,
    anchorTaskIds: tasks.map((task) => task.id),
    load,
    input: {
      scope: { kind: "PERSONAL" },
      personIds: [actor.personId],
      taskIds: [],
      types: [],
      statuses: [],
      groupBy: "PERSON",
      includeTaskAnchors: true,
      includeActual: true,
      includeBusyBlocks: false,
    },
  });
  return { tasks, ...canvas };
}

export async function getResourcePlanPageData({
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
  const selection = await getResourcePlanSelection({ actor, input });
  const canvas = await getContentDrivenTimeCanvasData({
    actor,
    preferredCenterMs,
    load,
    anchorTaskIds: selection.taskIds,
    input: {
      scope: { kind: "RESOURCE_PLANNER" },
      personIds: selection.personIds,
      taskIds: [],
      types: [],
      statuses: [],
      groupBy: "PERSON",
      includeTaskAnchors: true,
      includeActual: true,
      emptyPersonIdsMeansNone: true,
      includeBusyBlocks: false,
    },
  });
  return { selection, ...canvas };
}

export async function resolveProjectTimelinePersonIds({
  actor,
  personIds,
}: {
  actor: ProjectManagementActor;
  personIds: string[];
}) {
  const uniquePersonIds = [...new Set(personIds)];
  if (uniquePersonIds.length === 0) return [];
  const seedStart = floorShanghaiDay(Date.now());
  const input = getTimeCanvasDataInputSchema.parse({
    scope: { kind: "RESOURCE_PLANNER" },
    personIds: uniquePersonIds,
    taskIds: [],
    types: [],
    statuses: [],
    groupBy: "PERSON",
    includeTaskAnchors: true,
    includeActual: true,
    includeBusyBlocks: false,
    rangeStart: new Date(seedStart).toISOString(),
    rangeEnd: new Date(seedStart + DAY_MS).toISOString(),
  });
  const authorizedAllTimeFilter = authorizedSegmentFilterWhere(actor, input, false);
  const people = await prisma.person.findMany({
    where: {
      AND: [
        { id: { in: uniquePersonIds } },
        personUniverseWhere(actor, input, null),
        personAvailableInRangeWhere(authorizedAllTimeFilter),
      ],
    },
    select: { id: true },
  });
  const availableIds = new Set(people.map((person) => person.id));
  return uniquePersonIds.filter((personId) => availableIds.has(personId));
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
        input: { showAll: parsed.showAll },
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
            types: [],
            statuses: [],
            groupBy: "PERSON",
            includeTaskAnchors: true,
            includeActual: true,
            includeBusyBlocks: false,
          },
        })
      : parsed.kind === "PROJECT"
        ? await loadProjectTimeCanvasBlock(actor, parsed, preferredCenterMs, load)
        : await getResourcePlanPageData({
            actor,
            input: {
              all: parsed.all,
              taskStatuses: parsed.taskStatuses,
              projectIds: parsed.projectIds,
              taskIds: parsed.taskIds,
              personIds: parsed.personIds,
              pinnedTaskIds: parsed.pinnedTaskIds,
              pinnedPersonIds: parsed.pinnedPersonIds,
            },
            preferredCenterMs,
            load,
          });
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
  });
  const personIds = await resolveProjectTimelinePersonIds({
    actor,
    personIds: [
      ...project.members.map((member) => member.personId),
      ...project.tasks.flatMap((task) => task.members.map((member) => member.personId)),
    ],
  });
  return getContentDrivenTimeCanvasData({
    actor,
    preferredCenterMs,
    load,
    anchorTaskIds: project.tasks.map((task) => task.id),
    input: {
      scope: { kind: "RESOURCE_PLANNER" },
      personIds,
      taskIds: [],
      types: [],
      statuses: [],
      groupBy: "PERSON",
      includeTaskAnchors: true,
      includeActual: true,
      includeBusyBlocks: false,
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
  return scopeTask;
}

async function loadPersonRows(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  scopeTask: CanvasTask | null,
  authorizedSegmentFilter: Prisma.WorkSegmentWhereInput,
): Promise<RowPage> {
  const universe = personUniverseWhere(actor, input, scopeTask);
  const where: Prisma.PersonWhereInput = {
    AND: [
      universe,
      personAvailableInRangeWhere(authorizedSegmentFilter),
      input.personIds.length > 0 ? { id: { in: input.personIds } } : {},
    ],
  };
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
  });
  const canCreateByPersonId = await loadPersonCreateCapabilities(
    actor,
    input,
    scopeTask,
    people.map((person) => person.id),
  );
  const rows = people.map((person) => {
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
    ],
  };
  const tasks = await prisma.task.findMany({
    where,
    select: canvasRowTaskSelect,
    orderBy: [{ title: "asc" }, { id: "asc" }],
  });
  const rows = tasks.map((task) => ({
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
            task: taskAuthorizationResource(task),
          },
        }).allowed,
    },
  }));
  return {
    rows,
    rowIds: rows.map((row) => row.id),
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
  includeRange = true,
): Prisma.WorkSegmentWhereInput {
  return {
    AND: [
      segmentReadableWhere(actor),
      segmentFilterWhere(input, actor.personId, includeRange),
    ],
  };
}

function segmentFilterWhere(
  input: GetTimeCanvasDataInput,
  actorPersonId: string,
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
        : input.emptyPersonIdsMeansNone
          ? { personId: { in: [] } }
          : {},
      input.taskIds.length > 0 ? { taskId: { in: input.taskIds } } : {},
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
  });
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
