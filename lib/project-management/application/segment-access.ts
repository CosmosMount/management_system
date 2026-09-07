import { Prisma, type WorkSegment } from "@prisma/client";
import {
  assertAuthorized,
  authorize,
} from "@/lib/project-management/authorization";
import {
  associationInvalidError,
  notFoundError,
  staleSegmentError,
  stateConflictError,
  validationError,
} from "@/lib/project-management/application/errors";
import {
  segmentInclude,
  type SegmentForMutation,
  type TaskForSegmentAuthorization,
} from "@/lib/project-management/application/segment-record";
import { lockTaskSegmentAssociationsTx } from "@/lib/project-management/application/task-segment-association-lock";
import { taskAuthorizationResource } from "@/lib/project-management/application/task-authorization-resource";
import { isTaskCreatableForSegment } from "@/lib/project-management/domain/task-segment-policy";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import type { CreateWorkSegmentInput } from "@/lib/project-management/validations/segments";

type PrismaTx = Prisma.TransactionClient;

export async function assertCanManageNewSegment(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  input: Pick<CreateWorkSegmentInput, "personId" | "taskId">,
) {
  const task = input.taskId
    ? await loadTaskForAuthorizationTx(tx, input.taskId)
    : null;
  const action =
    input.personId === actor.personId ? "segment.manage_self" : "segment.manage_others";
  assertAuthorized({
    actor,
    action,
    resource: {
      type: "segment",
      personId: input.personId,
      task: task ? taskAuthorizationResource(task) : null,
    },
  });
  if (task && action === "segment.manage_self") {
    assertTaskVisible(actor, task);
  }
}

export async function assertSegmentReferenceTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    personId: string;
    taskId?: string | null;
    requireCreatableTask?: boolean;
  },
) {
  if (!input.taskId) return;
  const task = await loadTaskForAuthorizationTx(tx, input.taskId);
  if (
    !task.members.some(
      (member) =>
        member.personId === input.personId &&
        (member.role === "OWNER" || member.role === "PARTICIPANT"),
    )
  ) {
    throw associationInvalidError("任务关联投入只能属于负责人或参与人", {
      personId: ["请先将该人员添加为负责人或参与人"],
    });
  }
  assertActorCanReferenceTaskForSegment(input.actor, {
    personId: input.personId,
    task,
  });
  if (
    input.requireCreatableTask &&
    !isTaskCreatableForSegment(task.status)
  ) {
    throw associationInvalidError("当前任务状态不允许新增或关联投入记录", {
      taskId: ["当前任务状态不允许新增或关联投入记录"],
    });
  }
}

export function assertSegmentVisible(
  actor: ProjectManagementActor,
  segment: SegmentForMutation,
) {
  const decision = authorize({
    actor,
    action: "segment.view",
    resource: {
      type: "segment",
      personId: segment.personId,
      task: segment.task ? taskAuthorizationResource(segment.task) : null,
    },
  });
  if (!decision.allowed) throw notFoundError();
}

export function assertCanManageSegment(
  actor: ProjectManagementActor,
  segment: SegmentForMutation,
) {
  if (
    segment.task &&
    !segment.task.members.some(
      (member) =>
        member.personId === segment.personId &&
        (member.role === "OWNER" || member.role === "PARTICIPANT"),
    )
  ) {
    throw associationInvalidError("任务关联投入只能属于负责人或参与人", {
      personId: ["请先将该人员添加为负责人或参与人"],
    });
  }
  assertAuthorized({
    actor,
    action:
      segment.personId === actor.personId
        ? "segment.manage_self"
        : "segment.manage_others",
    resource: {
      type: "segment",
      personId: segment.personId,
      task: segment.task ? taskAuthorizationResource(segment.task) : null,
    },
  });
}

export async function lockWorkSegmentTx(tx: PrismaTx, segmentId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "WorkSegment" WHERE "id" = ${segmentId} FOR UPDATE
  `;
  if (rows.length === 0) throw notFoundError();
}

export async function lockSegmentAssociationTasksTx(
  tx: PrismaTx,
  input: {
    segmentIds: string[];
    prospectiveTaskIds?: string[];
  },
) {
  const uniqueSegmentIds = [...new Set(input.segmentIds)];
  const associations = await tx.workSegment.findMany({
    where: { id: { in: uniqueSegmentIds } },
    select: { id: true, taskId: true },
  });
  if (associations.length !== uniqueSegmentIds.length) throw notFoundError();
  return lockTaskSegmentAssociationsTx(tx, [
    ...associations.flatMap((association) =>
      association.taskId ? [association.taskId] : [],
    ),
    ...(input.prospectiveTaskIds ?? []),
  ]);
}

export function assertAssociationTaskLocked(
  lockedTaskIds: ReadonlySet<string>,
  association: { taskId?: string | null },
) {
  if (!association.taskId) return;
  if (association.taskId && lockedTaskIds.has(association.taskId)) return;
  throw stateConflictError(
    "投入记录关联在并发操作中已变化，请刷新后重试",
  );
}

export function assertSegmentAssociationLocatorUnchanged(
  before: Pick<SegmentForMutation, "taskId">,
  after: Pick<SegmentForMutation, "taskId">,
) {
  if (before.taskId === after.taskId) return;
  throw stateConflictError("投入记录关联在并发操作中已变化，请刷新后重试");
}

export async function loadSegmentForMutationTx(
  tx: PrismaTx,
  segmentId: string,
): Promise<SegmentForMutation> {
  const segment = await tx.workSegment.findUnique({
    where: { id: segmentId },
    include: segmentInclude,
  });
  if (!segment) throw notFoundError();
  return segment;
}

export async function assertPersonActiveTx(
  tx: PrismaTx,
  personId: string,
) {
  const person = await tx.person.findUnique({
    where: { id: personId },
    select: { status: true },
  });
  if (!person || person.status !== "ACTIVE") {
    throw validationError("人员不存在或已停用", {
      personId: ["人员不存在或已停用"],
    });
  }
}

export function assertExpectedUpdatedAt(
  segment: Pick<WorkSegment, "id" | "updatedAt">,
  expectedUpdatedAt: Date | undefined,
) {
  if (!expectedUpdatedAt || segment.updatedAt.getTime() === expectedUpdatedAt.getTime()) {
    return;
  }
  throw staleSegmentError(segment);
}

async function loadTaskForAuthorizationTx(
  tx: PrismaTx,
  taskId: string,
): Promise<TaskForSegmentAuthorization> {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      team: true,
      techGroup: true,
      status: true,
      priority: true,
      currentPlanVersionId: true,
      deletedAt: true,
      members: {
        where: { removedAt: null },
        select: { personId: true, role: true, removedAt: true },
      },
    },
  });
  if (!task || task.deletedAt) throw notFoundError();
  return task;
}

function assertTaskVisible(
  actor: ProjectManagementActor,
  task: TaskForSegmentAuthorization,
) {
  const decision = authorize({
    actor,
    action: "task.view",
    resource: taskAuthorizationResource(task),
  });
  if (!decision.allowed) throw notFoundError();
}

function assertActorCanReferenceTaskForSegment(
  actor: ProjectManagementActor,
  input: { personId: string; task: TaskForSegmentAuthorization },
) {
  assertAuthorized({
    actor,
    action:
      input.personId === actor.personId
        ? "segment.manage_self"
        : "segment.manage_others",
    resource: {
      type: "segment",
      personId: input.personId,
      task: taskAuthorizationResource(input.task),
    },
  });
}
