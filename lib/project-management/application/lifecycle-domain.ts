import type { Prisma, TaskNodeType } from "@prisma/client";
import { authorize, taskReadableWhere } from "@/lib/project-management/authorization";
import {
  notFoundError,
  stateConflictError,
  validationError,
} from "@/lib/project-management/application/errors";
import { assertPersistedPlanChronologyValid } from "@/lib/project-management/application/persisted-plan-chronology";
import {
  lifecyclePlanNodeInclude,
  type LifecyclePlanEntry,
  type LifecycleTaskForAuthorization,
} from "@/lib/project-management/application/lifecycle-records";
import { taskAuthorizationResource } from "@/lib/project-management/application/task-authorization-resource";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import type { CreateTaskDraftInput } from "@/lib/project-management/validations/lifecycle";

type PrismaTx = Prisma.TransactionClient;

export async function assertCreateTaskReferencesTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  input: CreateTaskDraftInput,
) {
  const memberPersonIds = [
    ...new Set(input.members.map((member) => member.personId)),
  ];
  const personCount = await tx.person.count({
    where: {
      id: { in: memberPersonIds },
      OR: [{ status: "ACTIVE" }, { id: actor.personId }],
    },
  });
  if (personCount !== memberPersonIds.length) {
    throw validationError("成员不存在或已停用", {
      members: ["成员不存在或已停用"],
    });
  }
  if (input.relatedTaskId) {
    const relatedTask = await tx.task.findFirst({
      where: {
        AND: [{ id: input.relatedTaskId }, taskReadableWhere(actor)],
      },
      select: { id: true },
    });
    if (!relatedTask) throw notFoundError();
  }
}

export async function createPlanNodesTx(
  tx: PrismaTx,
  input: {
    taskId: string;
    planVersionId: string;
    actorAccountId: string;
    milestones: CreateTaskDraftInput["milestones"];
    termination: CreateTaskDraftInput["termination"];
    startingSequence: number;
    carryForward: boolean;
  },
) {
  let sequence = input.startingSequence;
  for (const milestone of input.milestones) {
    const node = await tx.taskNode.create({
      data: {
        taskId: input.taskId,
        type: "MILESTONE",
        status: "PENDING",
        businessDescription: milestone.businessDescription,
        createdByAccountId: input.actorAccountId,
        milestone: {
          create: {
            goal: milestone.goal,
            completionCriteria: milestone.completionCriteria,
            expectedCompletedAt: milestone.expectedCompletedAt,
            reviewRequirements: milestone.reviewRequirements,
          },
        },
      },
      select: { id: true },
    });
    await tx.planVersionNode.create({
      data: {
        planVersionId: input.planVersionId,
        nodeId: node.id,
        sequence,
        isCarryForward: input.carryForward,
      },
    });
    sequence += 1;
  }

  const terminationNode = await tx.taskNode.create({
    data: {
      taskId: input.taskId,
      type: "TERMINATION",
      status: "PENDING",
      businessDescription: input.termination.businessDescription,
      createdByAccountId: input.actorAccountId,
      termination: {
        create: {
          name: input.termination.name,
          plannedOutcomeCriteria: input.termination.plannedOutcomeCriteria,
          plannedAt: input.termination.plannedAt,
        },
      },
    },
    select: { id: true },
  });
  await tx.planVersionNode.create({
    data: {
      planVersionId: input.planVersionId,
      nodeId: terminationNode.id,
      sequence,
      isCarryForward: input.carryForward,
    },
  });
}

export async function loadTaskForAuthorizationTx(
  tx: PrismaTx,
  taskId: string,
): Promise<LifecycleTaskForAuthorization> {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      team: true,
      techGroup: true,
      status: true,
      priority: true,
      createdByAccountId: true,
      currentPlanVersionId: true,
      activeMilestoneNodeId: true,
      lockVersion: true,
      updatedAt: true,
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

export function assertTaskVisible(
  actor: ProjectManagementActor,
  task: LifecycleTaskForAuthorization,
) {
  const visible = authorize({
    actor,
    action: "task.view",
    resource: taskAuthorizationResource(task),
  });
  if (!visible.allowed) throw notFoundError();
}

export async function lockIdempotencyKeyTx(
  tx: PrismaTx,
  accountId: string,
  idempotencyKey: string,
) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`pm-lifecycle:${accountId}:${idempotencyKey}`}, 0)
    )
  `;
}

export async function lockTaskTx(tx: PrismaTx, taskId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task" WHERE "id" = ${taskId} FOR UPDATE
  `;
  if (rows.length === 0) throw notFoundError();
}

export async function loadCurrentPlanEntriesTx(
  tx: PrismaTx,
  task: LifecycleTaskForAuthorization,
) {
  const plan = await tx.taskPlanVersion.findFirst({
    where: {
      id: task.currentPlanVersionId,
      taskId: task.id,
      status: "CURRENT",
    },
    include: {
      nodes: {
        include: lifecyclePlanNodeInclude,
        orderBy: { sequence: "asc" },
      },
    },
  });
  if (!plan) throw stateConflictError("当前计划不存在");
  return plan;
}

export async function loadPlanEntriesTx(
  tx: PrismaTx,
  planVersionId: string,
): Promise<LifecyclePlanEntry[]> {
  return tx.planVersionNode.findMany({
    where: { planVersionId },
    include: lifecyclePlanNodeInclude,
    orderBy: { sequence: "asc" },
  });
}

export async function loadPlanForValidationTx(
  tx: PrismaTx,
  planVersionId: string,
): Promise<{ plannedStartAt: Date | null; nodes: LifecyclePlanEntry[] }> {
  const plan = await tx.taskPlanVersion.findUnique({
    where: { id: planVersionId },
    select: {
      plannedStartAt: true,
      nodes: {
        include: lifecyclePlanNodeInclude,
        orderBy: { sequence: "asc" },
      },
    },
  });
  if (!plan) throw stateConflictError("计划版本不存在");
  return plan;
}

export function assertAuthoritativePlanValid(plan: {
  plannedStartAt: Date | null;
  nodes: LifecyclePlanEntry[];
}) {
  assertPersistedPlanChronologyValid(plan, "STRICT");
}

export function assertLegacyCurrentPlanUsableAsRepairBase(plan: {
  plannedStartAt: Date | null;
  nodes: LifecyclePlanEntry[];
}) {
  assertPersistedPlanChronologyValid(plan, "LEGACY_CURRENT_BASE");
}

export function assertRevisionTargetPlanValid(plan: {
  plannedStartAt: Date | null;
  nodes: LifecyclePlanEntry[];
}) {
  assertPersistedPlanChronologyValid(plan, "STRICT");
}

export async function activateNextMilestoneInPlanTx(
  tx: PrismaTx,
  entries: LifecyclePlanEntry[],
): Promise<string | null> {
  const existingActive = entries.find(
    (entry) =>
      entry.node.type === "MILESTONE" && entry.node.status === "ACTIVE",
  );
  if (existingActive) return existingActive.nodeId;
  const nextMilestone = entries.find(
    (entry) =>
      entry.node.type === "MILESTONE" && entry.node.status === "PENDING",
  );
  if (nextMilestone) {
    await tx.taskNode.update({
      where: { id: nextMilestone.nodeId },
      data: { status: "ACTIVE" },
    });
    return nextMilestone.nodeId;
  }
  const termination = entries.find(
    (entry) => entry.node.type === "TERMINATION",
  );
  if (termination && termination.node.status === "PENDING") {
    await tx.taskNode.update({
      where: { id: termination.nodeId },
      data: { status: "ACTIVE" },
    });
  }
  return null;
}

export async function advanceCurrentPlanAfterNodeTx(
  tx: PrismaTx,
  task: LifecycleTaskForAuthorization,
  completedNodeId: string,
): Promise<{ activeMilestoneNodeId: string | null }> {
  const entries = (await loadCurrentPlanEntriesTx(tx, task)).nodes;
  const completedIndex = entries.findIndex(
    (entry) => entry.nodeId === completedNodeId,
  );
  if (completedIndex < 0) {
    throw stateConflictError("当前节点不在 Current Plan 中");
  }
  for (const entry of entries.slice(completedIndex + 1)) {
    if (entry.node.type === "REVISION") {
      if (entry.node.status !== "COMPLETED") {
        await tx.taskNode.update({
          where: { id: entry.nodeId },
          data: { status: "COMPLETED" },
        });
      }
      continue;
    }
    if (entry.node.type === "MILESTONE") {
      if (entry.node.status === "PENDING") {
        await tx.taskNode.update({
          where: { id: entry.nodeId },
          data: { status: "ACTIVE" },
        });
        return { activeMilestoneNodeId: entry.nodeId };
      }
      if (entry.node.status === "ACTIVE") {
        return { activeMilestoneNodeId: entry.nodeId };
      }
      continue;
    }
    if (entry.node.type === "TERMINATION") {
      if (entry.node.status === "PENDING") {
        await tx.taskNode.update({
          where: { id: entry.nodeId },
          data: { status: "ACTIVE" },
        });
      }
      return { activeMilestoneNodeId: null };
    }
  }
  throw stateConflictError("计划缺少结束节点");
}

export async function assertNodeInCurrentPlanTx(
  tx: PrismaTx,
  task: LifecycleTaskForAuthorization,
  nodeId: string,
  type: TaskNodeType,
) {
  const exists = await tx.planVersionNode.findFirst({
    where: {
      planVersionId: task.currentPlanVersionId,
      nodeId,
      node: { type },
    },
    select: { id: true },
  });
  if (!exists) throw stateConflictError("节点不属于 Current Plan");
}
