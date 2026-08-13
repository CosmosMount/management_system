import { Prisma } from "@prisma/client";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  authorize,
  segmentReadableWhere,
  taskReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { notFoundError } from "@/lib/project-management/application/errors";
import { toWorkSegmentDto } from "@/lib/project-management/application/segment-record";
import {
  taskPriorityLabels,
  workSegmentStatusLabels,
} from "@/lib/project-management/labels";
import {
  getWorkSegmentInputSchema,
  listWorkSegmentChangesInputSchema,
  listWorkSegmentsInputSchema,
} from "@/lib/project-management/validations/segments";

const segmentTaskSelect = {
  id: true,
  title: true,
  team: true,
  techGroup: true,
  status: true,
  priority: true,
  deletedAt: true,
  members: {
    where: { removedAt: null },
    select: { personId: true, role: true, removedAt: true },
  },
} satisfies Prisma.TaskSelect;

const segmentQueryInclude = {
  person: { select: { displayName: true } },
  task: { select: segmentTaskSelect },
  plannedSources: {
    select: {
      id: true,
      actualSegmentId: true,
      coveredStartAt: true,
      coveredEndAt: true,
      actualSegment: {
        select: {
          id: true,
          personId: true,
          startAt: true,
          endAt: true,
          deletedAt: true,
          task: { select: segmentTaskSelect },
        },
      },
    },
  },
  actualSources: {
    select: {
      id: true,
      plannedSegmentId: true,
      coveredStartAt: true,
      coveredEndAt: true,
      plannedSegment: {
        select: {
          id: true,
          personId: true,
          startAt: true,
          endAt: true,
          status: true,
          deletedAt: true,
          task: { select: segmentTaskSelect },
        },
      },
    },
  },
} satisfies Prisma.WorkSegmentInclude;

export async function listWorkSegments({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}) {
  const parsed = listWorkSegmentsInputSchema.parse(input);
  const where: Prisma.WorkSegmentWhereInput = {
    AND: [
      segmentReadableWhere(actor),
      parsed.personId ? { personId: parsed.personId } : {},
      parsed.taskId ? { taskId: parsed.taskId } : {},
      parsed.type ? { type: parsed.type } : {},
      parsed.status ? { status: parsed.status } : {},
      timeOverlapWhere(parsed.startAt, parsed.endAt),
    ],
  };
  const rows = await prisma.workSegment.findMany({
    where,
    include: segmentQueryInclude,
    orderBy: [{ startAt: "asc" }, { id: "asc" }],
    take: parsed.limit + 1,
    ...(parsed.cursor ? { cursor: { id: parsed.cursor }, skip: 1 } : {}),
  });
  return {
    items: rows.slice(0, parsed.limit).map((row) =>
      toWorkSegmentDetailDto(row, actor),
    ),
    nextCursor:
      rows.length > parsed.limit
        ? rows.slice(0, parsed.limit).at(-1)?.id ?? null
        : null,
  };
}

export async function getWorkSegment({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}) {
  const parsed = getWorkSegmentInputSchema.parse(input);
  const row = await prisma.workSegment.findFirst({
    where: {
      AND: [{ id: parsed.segmentId }, segmentReadableWhere(actor)],
    },
    include: segmentQueryInclude,
  });
  if (!row) throw notFoundError();
  return toWorkSegmentDetailDto(row, actor);
}

export async function listWorkSegmentChanges({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}) {
  const parsed = listWorkSegmentChangesInputSchema.parse(input);
  const segment = await prisma.workSegment.findFirst({
    where: {
      AND: [{ id: parsed.segmentId }, segmentReadableWhere(actor)],
    },
    select: { id: true },
  });
  if (!segment) throw notFoundError();
  if (parsed.cursor) {
    const cursor = await prisma.workSegmentChange.findFirst({
      where: { id: parsed.cursor, segmentId: parsed.segmentId },
      select: { id: true },
    });
    if (!cursor) throw notFoundError();
  }
  const rows = await prisma.workSegmentChange.findMany({
    where: { segmentId: parsed.segmentId },
    include: {
      actor: {
        select: { person: { select: { displayName: true } } },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: parsed.limit + 1,
    ...(parsed.cursor ? { cursor: { id: parsed.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, parsed.limit);
  const referencedIds = collectHistoryReferenceIds(page);
  const [people, tasks] = await Promise.all([
    prisma.person.findMany({
      where: { id: { in: [...referencedIds.personIds] } },
      select: { id: true, displayName: true },
    }),
    prisma.task.findMany({
      where: {
        AND: [
          { id: { in: [...referencedIds.taskIds] } },
          taskReadableWhere(actor),
        ],
      },
      select: { id: true, title: true },
    }),
  ]);
  const names: WorkSegmentHistoryNames = {
    people: new Map(people.map((person) => [person.id, person.displayName])),
    tasks: new Map(tasks.map((task) => [task.id, task.title])),
  };
  return {
    items: page.map((row) => formatWorkSegmentChange(row, names)),
    nextCursor: rows.length > parsed.limit ? page.at(-1)?.id ?? null : null,
  };
}

type HistoryRow = Prisma.WorkSegmentChangeGetPayload<{
  include: {
    actor: { select: { person: { select: { displayName: true } } } };
  };
}>;

export type WorkSegmentHistoryNames = {
  people: Map<string, string>;
  tasks: Map<string, string>;
};

export type WorkSegmentHistoryFormatterRow = {
  id: string;
  action: string;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
  reason: string;
  actorAccountId: string | null;
  createdAt: Date;
  actor: { person: { displayName: string } | null } | null;
};

const historyFieldLabels = {
  startAt: "开始时间",
  endAt: "结束时间",
  personId: "人员",
  content: "内容",
  priority: "优先级",
  expectedOutput: "预期输出",
  actualOutput: "实际输出",
  taskId: "Task",
  status: "状态",
} as const;

export function formatWorkSegmentChange(
  row: WorkSegmentHistoryFormatterRow,
  names: WorkSegmentHistoryNames,
) {
  const before = jsonObject(row.before);
  const after = jsonObject(row.after);
  const splitFromPartialConfirmation = Boolean(
    stringValue(after?.sourcePartialConfirmSegmentId),
  );
  const action = (() => {
    switch (row.action) {
      case "CREATE": return "创建投入";
      case "UPDATE": return "修改投入";
      case "SPLIT": return splitFromPartialConfirmation
        ? "部分确认后生成剩余计划"
        : "拆分计划（历史）";
      case "MERGE": return "合并计划（历史）";
      case "CONFIRM": return "确认投入";
      case "CANCEL": return "取消计划";
      case "DELETE": return "删除实际投入";
      default:
        logger.warn("pm.segment_history.unknown_action", {
          module: "project-management",
          action: row.action,
        });
        return "发生了系统变更";
    }
  })();
  const differences = row.action === "UPDATE"
    ? Object.entries(historyFieldLabels).flatMap(([field, label]) => {
        const previous = formatHistoryValue(field, before?.[field], names);
        const next = formatHistoryValue(field, after?.[field], names);
        return previous === next ? [] : [{ label, before: previous, after: next }];
      })
    : [];
  return {
    key: row.id,
    action,
    actorName:
      row.actor?.person?.displayName ??
      (row.actorAccountId ? "管理员或未知操作者" : "系统"),
    reason: row.reason.trim() || "未填写原因",
    createdAt: row.createdAt.toISOString(),
    differences,
  };
}

function collectHistoryReferenceIds(rows: HistoryRow[]) {
  const personIds = new Set<string>();
  const taskIds = new Set<string>();
  for (const row of rows) {
    for (const value of [jsonObject(row.before), jsonObject(row.after)]) {
      if (!value) continue;
      const personId = stringValue(value.personId);
      const taskId = stringValue(value.taskId);
      if (personId) personIds.add(personId);
      if (taskId) taskIds.add(taskId);
    }
  }
  return { personIds, taskIds };
}

function formatHistoryValue(
  field: string,
  value: Prisma.JsonValue | undefined,
  names: WorkSegmentHistoryNames,
) {
  if (field === "personId") {
    const id = stringValue(value);
    return id ? names.people.get(id) ?? "不可见对象" : "未关联";
  }
  if (field === "taskId") {
    const id = stringValue(value);
    return id ? names.tasks.get(id) ?? "不可见对象" : "独立投入";
  }
  if (field === "startAt" || field === "endAt") {
    const date = stringValue(value);
    return date ? formatHistoryDate(date) : "未填写";
  }
  if (field === "priority") {
    const priority = stringValue(value);
    return priority && priority in taskPriorityLabels
      ? taskPriorityLabels[priority as keyof typeof taskPriorityLabels]
      : "未填写";
  }
  if (field === "status") {
    const status = stringValue(value);
    return status && status in workSegmentStatusLabels
      ? workSegmentStatusLabels[status as keyof typeof workSegmentStatusLabels]
      : "未填写";
  }
  const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
  if (!text) return "未填写";
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function jsonObject(value: Prisma.JsonValue | null): Prisma.JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Prisma.JsonObject
    : null;
}

function stringValue(value: Prisma.JsonValue | undefined) {
  return typeof value === "string" ? value : "";
}

function formatHistoryDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "无效时间";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export async function listTimelinePeople({
  actor,
}: {
  actor: ProjectManagementActor;
}): Promise<Array<{ id: string; displayName: string }>> {
  const people = await prisma.person.findMany({
    where: {
      OR: [
        { status: "ACTIVE" },
        { workSegments: { some: segmentReadableWhere(actor) } },
      ],
    },
    select: { id: true, displayName: true, status: true },
    orderBy: [{ displayName: "asc" }, { id: "asc" }],
    take: 5_000,
  });
  return people.map((person) => ({
    id: person.id,
    displayName:
      person.status === "INACTIVE"
        ? `${person.displayName}（已停用）`
        : person.displayName,
  })).sort((left, right) =>
    left.displayName.localeCompare(right.displayName, "zh-CN"),
  );
}

export type WorkSegmentListResult = Awaited<ReturnType<typeof listWorkSegments>>;
export type WorkSegmentDetail = WorkSegmentListResult["items"][number];
function timeOverlapWhere(
  startAt?: Date,
  endAt?: Date,
): Prisma.WorkSegmentWhereInput {
  if (!startAt && !endAt) return {};
  return {
    ...(endAt ? { startAt: { lt: endAt } } : {}),
    ...(startAt ? { endAt: { gt: startAt } } : {}),
  };
}

function toWorkSegmentDetailDto(
  segment: Prisma.WorkSegmentGetPayload<{ include: typeof segmentQueryInclude }>,
  actor: ProjectManagementActor,
) {
  const task = segment.task
    ? {
        id: segment.task.id,
        title: segment.task.title,
        team: segment.task.team,
        techGroup: segment.task.techGroup,
        deleted: Boolean(segment.task.deletedAt),
      }
    : null;
  return {
    ...toWorkSegmentDto({
      ...segment,
      task: null,
      person: {
        id: segment.personId,
        displayName: segment.person.displayName,
        status: "ACTIVE",
        accountId: null,
      },
    }),
    personName: segment.person.displayName,
    task,
    plannedSources: segment.plannedSources
      .filter((source) => sourceSegmentVisible(actor, source.actualSegment))
      .map((source) => ({
        id: source.id,
        actualSegmentId: source.actualSegmentId,
        coveredStartAt: source.coveredStartAt.toISOString(),
        coveredEndAt: source.coveredEndAt.toISOString(),
        actualSegment: {
          id: source.actualSegment.id,
          startAt: source.actualSegment.startAt.toISOString(),
          endAt: source.actualSegment.endAt.toISOString(),
          deletedAt: source.actualSegment.deletedAt?.toISOString() ?? null,
        },
      })),
    actualSources: segment.actualSources
      .filter((source) => sourceSegmentVisible(actor, source.plannedSegment))
      .map((source) => ({
        id: source.id,
        plannedSegmentId: source.plannedSegmentId,
        coveredStartAt: source.coveredStartAt.toISOString(),
        coveredEndAt: source.coveredEndAt.toISOString(),
        plannedSegment: {
          id: source.plannedSegment.id,
          startAt: source.plannedSegment.startAt.toISOString(),
          endAt: source.plannedSegment.endAt.toISOString(),
          status: source.plannedSegment.status,
        },
      })),
  };
}

type SegmentQueryPayload = Prisma.WorkSegmentGetPayload<{
  include: typeof segmentQueryInclude;
}>;

function sourceSegmentVisible(
  actor: ProjectManagementActor,
  segment: {
    personId: string;
    deletedAt?: Date | null;
    task: NonNullable<SegmentQueryPayload["task"]> | null;
  },
) {
  if (segment.deletedAt) return false;
  return authorize({
    actor,
    action: "segment.view",
    resource: {
      type: "segment",
      personId: segment.personId,
      task: segment.task ? taskResource(segment.task) : null,
    },
  }).allowed;
}

function taskResource(
  task: NonNullable<SegmentQueryPayload["task"]>,
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
