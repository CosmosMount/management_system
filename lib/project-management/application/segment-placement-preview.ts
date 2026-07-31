import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertAuthorized,
  authorize,
  segmentReadableWhere,
  taskReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import {
  associationInvalidError,
  notFoundError,
  queryLimitExceededError,
  stateConflictError,
} from "@/lib/project-management/application/errors";
import {
  ACTIVE_PLANNED_CONFLICT_STATUSES,
  detectResourceConflictsForSegments,
  type ConflictDetectionSegment,
} from "@/lib/project-management/domain/conflict-detection";
import { isTaskCreatableForSegment } from "@/lib/project-management/domain/task-segment-policy";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  segmentPlacementPreviewDtoSchema,
  type SegmentPlacementPreviewDto,
} from "@/lib/project-management/types/time-canvas";
import {
  MAX_TIME_CANVAS_VISIBLE_SEGMENTS,
  previewSegmentPlacementInputSchema,
} from "@/lib/project-management/validations/time-canvas";

const previewTaskSelect = {
  id: true,
  team: true,
  techGroup: true,
  status: true,
  priority: true,
  allowSelfReview: true,
  currentPlanVersionId: true,
  members: {
    where: { removedAt: null },
    select: { personId: true, role: true, removedAt: true },
  },
} satisfies Prisma.TaskSelect;

const previewSegmentSelect = {
  id: true,
  personId: true,
  type: true,
  status: true,
  startAt: true,
  endAt: true,
  allocation: true,
  priority: true,
  role: true,
  taskId: true,
  nodeId: true,
  associationNeedsReview: true,
  deletedAt: true,
  task: { select: previewTaskSelect },
} satisfies Prisma.WorkSegmentSelect;

type PreviewSegment = Prisma.WorkSegmentGetPayload<{
  select: typeof previewSegmentSelect;
}>;
type PreviewTask = NonNullable<PreviewSegment["task"]>;

export async function previewSegmentPlacement({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}): Promise<SegmentPlacementPreviewDto> {
  const parsed = previewSegmentPlacementInputSchema.parse(input);
  const existing = parsed.segmentId
    ? await prisma.workSegment.findFirst({
        where: {
          AND: [{ id: parsed.segmentId }, segmentReadableWhere(actor)],
        },
        select: previewSegmentSelect,
      })
    : null;
  if (parsed.segmentId && !existing) throw notFoundError();
  if (existing) {
    assertCanManageSegment(actor, existing);
    if (existing.personId !== parsed.personId) {
      throw associationInvalidError("放置预览不能改变 Segment 所属人员", {
        personId: ["放置预览不能改变 Segment 所属人员"],
      });
    }
    if (
      existing.type !== "PLANNED" ||
      existing.deletedAt ||
      existing.status === "CONFIRMED" ||
      existing.status === "CANCELLED"
    ) {
      throw stateConflictError("只有未确认且未取消的 Planned Segment 可以预览放置");
    }
    if (parsed.role && parsed.role !== existing.role) {
      throw associationInvalidError("已有 Segment 的放置预览不能改变人员职责", {
        role: ["已有 Segment 的放置预览不能改变人员职责"],
      });
    }
  }

  const isRelink = parsed.associationIntent === "RELINK";
  if (isRelink && existing && !existing.associationNeedsReview) {
    throw associationInvalidError(
      "只有待重关联的 Planned Segment 可以执行 RELINK",
    );
  }
  const nextTaskId = isRelink
    ? parsed.taskId ?? null
    : existing?.taskId ?? null;
  const nextNodeId = isRelink
    ? parsed.nodeId ?? null
    : existing?.nodeId ?? null;
  const task =
    existing && !isRelink
      ? existing.task
      : await assertPlacementAssociation({
          actor,
          personId: parsed.personId,
          taskId: nextTaskId,
          nodeId: nextNodeId,
        });
  if (!existing) {
    assertAuthorized({
      actor,
      action:
        parsed.personId === actor.personId
          ? "segment.manage_self"
          : "segment.manage_others",
      resource: {
        type: "segment",
        personId: parsed.personId,
        task: task ? taskResource(task) : null,
      },
    });
  }

  const person = await prisma.person.findFirst({
    where: { id: parsed.personId, status: "ACTIVE" },
    select: { id: true },
  });
  if (!person) throw notFoundError();

  const overlaps = await prisma.workSegment.findMany({
    where: {
      personId: parsed.personId,
      deletedAt: null,
      startAt: { lt: parsed.endAt },
      endAt: { gt: parsed.startAt },
      ...(existing ? { id: { not: existing.id } } : {}),
      OR: [
        {
          type: "PLANNED",
          status: { in: [...ACTIVE_PLANNED_CONFLICT_STATUSES] },
        },
        { type: "ACTUAL", status: "CONFIRMED" },
      ],
    },
    select: previewSegmentSelect,
    orderBy: [{ startAt: "asc" }, { id: "asc" }],
    take: MAX_TIME_CANVAS_VISIBLE_SEGMENTS + 1,
  });
  if (overlaps.length > MAX_TIME_CANVAS_VISIBLE_SEGMENTS) {
    throw queryLimitExceededError(
      "放置预览的重叠候选超过 5000 条，请缩小时间范围后重试",
    );
  }

  const candidateId = existing?.id ?? "placement-candidate";
  const candidate: ConflictDetectionSegment = {
    id: candidateId,
    type: "PLANNED",
    status: existing?.status ?? "PLANNED",
    startAt: parsed.startAt,
    endAt: parsed.endAt,
    allocation: Object.hasOwn(parsed, "allocation")
      ? parsed.allocation ?? null
      : decimalToNumber(existing?.allocation ?? null),
    priority: parsed.priority ?? existing?.priority ?? "MEDIUM",
    role: existing?.role ?? parsed.role ?? "DEVELOPER",
    taskId: nextTaskId,
    associationNeedsReview:
      existing?.associationNeedsReview && isRelink
        ? false
        : (existing?.associationNeedsReview ?? false),
    deleted: false,
  };
  const detected = detectResourceConflictsForSegments(
    parsed.personId,
    { startAt: parsed.startAt, endAt: parsed.endAt },
    [...overlaps.map(toDetectionSegment), candidate],
  ).filter((conflict) => conflict.segmentIds.includes(candidateId));
  const overlapById = new Map(overlaps.map((segment) => [segment.id, segment]));
  const visible = [];
  let hasHidden = false;
  for (const conflict of detected) {
    const evidence = conflict.segmentIds.flatMap((segmentId) => {
      if (segmentId === candidateId) return [];
      const segment = overlapById.get(segmentId);
      return segment ? [segment] : [];
    });
    if (evidence.some((segment) => !segmentVisible(actor, segment))) {
      hasHidden = true;
      continue;
    }
    visible.push({
      kind: "PLACEMENT_CONFLICT" as const,
      visibility: "VISIBLE" as const,
      reason: conflict.kind,
      severity: conflict.severity,
      range: {
        startAt: conflict.startAt.toISOString(),
        endAt: conflict.endAt.toISOString(),
      },
    });
  }

  return segmentPlacementPreviewDtoSchema.parse({
    personId: parsed.personId,
    range: {
      startAt: parsed.startAt.toISOString(),
      endAt: parsed.endAt.toISOString(),
    },
    allocation: candidate.allocation,
    conflicts: [
      ...visible,
      ...(hasHidden
        ? [
            {
              kind: "PLACEMENT_CONFLICT" as const,
              visibility: "HIDDEN" as const,
              blocked: true as const,
            },
          ]
        : []),
    ],
    generatedAt: new Date().toISOString(),
  });
}

async function assertPlacementAssociation({
  actor,
  personId,
  taskId,
  nodeId,
}: {
  actor: ProjectManagementActor;
  personId: string;
  taskId: string | null;
  nodeId: string | null;
}): Promise<PreviewTask | null> {
  if (nodeId && !taskId) {
    throw associationInvalidError("关联 Node 时必须同时关联 Task", {
      nodeId: ["关联 Node 时必须同时关联 Task"],
    });
  }
  if (!taskId) return null;
  const task = await prisma.task.findFirst({
    where: {
      AND: [
        { id: taskId, deletedAt: null },
        personId === actor.personId ? taskReadableWhere(actor) : {},
      ],
    },
    select: previewTaskSelect,
  });
  if (!task) throw notFoundError();
  const canReference =
    personId === actor.personId
      ? authorize({
          actor,
          action: "task.view",
          resource: taskResource(task),
        }).allowed
      : authorize({
          actor,
          action: "segment.manage_others",
          resource: {
            type: "segment",
            personId,
            task: taskResource(task),
          },
        }).allowed;
  if (!canReference) throw notFoundError();
  if (!isTaskCreatableForSegment(task.status)) {
    throw associationInvalidError("当前 Task 状态不允许创建或重关联 Segment", {
      taskId: ["当前 Task 状态不允许创建或重关联 Segment"],
    });
  }
  if (!nodeId) return task;
  const node = await prisma.taskNode.findFirst({
    where: {
      id: nodeId,
      taskId,
      deletedAt: null,
      status: { notIn: ["REVISED", "CANCELLED"] },
      planVersionEntries: {
        some: { planVersionId: task.currentPlanVersionId },
      },
    },
    select: { id: true },
  });
  if (!node) throw associationInvalidError();
  return task;
}

function assertCanManageSegment(
  actor: ProjectManagementActor,
  segment: PreviewSegment,
) {
  assertAuthorized({
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
  });
}

function segmentVisible(
  actor: ProjectManagementActor,
  segment: PreviewSegment,
): boolean {
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

function taskResource(task: PreviewTask): AuthorizationTaskResource {
  return {
    type: "task",
    id: task.id,
    team: task.team,
    techGroup: task.techGroup,
    status: task.status,
    priority: task.priority,
    allowSelfReview: task.allowSelfReview,
    members: task.members,
  };
}

function toDetectionSegment(segment: PreviewSegment): ConflictDetectionSegment {
  return {
    id: segment.id,
    type: segment.type,
    status: segment.status,
    startAt: segment.startAt,
    endAt: segment.endAt,
    allocation: decimalToNumber(segment.allocation),
    priority: segment.priority,
    role: segment.role,
    taskId: segment.taskId,
    associationNeedsReview: segment.associationNeedsReview,
    deleted: segment.deletedAt !== null,
  };
}

function decimalToNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value.toString());
}
