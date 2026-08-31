import type { Prisma, RevisionStatus } from "@prisma/client";
import { assertAuthorized } from "@/lib/project-management/authorization";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  createLifecycleNotificationsTx,
  revisionCreatorAndOwnersTx,
} from "@/lib/project-management/application/lifecycle-notifications";
import { jsonValue } from "@/lib/project-management/application/prisma-json";
import type { CreateRevisionInput } from "@/lib/project-management/validations/lifecycle";
import {
  notFoundError,
  planChronologyInvalidError,
  planVersionConflictError,
  stateConflictError,
} from "@/lib/project-management/application/errors";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import { taskAuthorizationResource } from "@/lib/project-management/application/task-authorization-resource";
import {
  type LifecyclePlanEntry,
  type LifecycleTaskForAuthorization,
} from "@/lib/project-management/application/lifecycle-records";
import { hashLifecyclePlan } from "@/lib/project-management/application/lifecycle-plan-audit";
import {
  activateNextMilestoneInPlanTx,
  assertRevisionTargetPlanValid,
  assertTaskVisible,
  loadPlanEntriesTx,
  loadPlanForValidationTx,
  loadTaskForAuthorizationTx,
  lockTaskTx,
} from "@/lib/project-management/application/lifecycle-domain";
import { inspectRevisionTargetStructure } from "@/lib/project-management/domain/revision-target-structure";

type PrismaTx = Prisma.TransactionClient;

type PlanEntry = LifecyclePlanEntry;
type TaskForAuthorization = LifecycleTaskForAuthorization;

export type RevisionMutationResult = {
  taskId: string;
  revisionNodeId: string;
  targetPlanVersionId: string | null;
  status: RevisionStatus;
  currentPlanVersionId: string;
  lockVersion: number;
};

export async function cancelRevisionApprovalNotificationsTx(
  tx: PrismaTx,
  revisionNodeId: string,
) {
  const outboxes = await tx.notificationOutbox.findMany({
    where: {
      channel: "project-management",
      type: "revision_pending_review",
      status: { in: ["PENDING", "PROCESSING", "FAILED"] },
      OR: [
        {
          eventKey: {
            startsWith: `pm:revision:pending_review:${revisionNodeId}:`,
          },
        },
        {
          eventKey: {
            startsWith: `pm:revision:pending_review:global-admin:v2:${revisionNodeId}:`,
          },
        },
      ],
    },
    select: { id: true },
  });
  const outboxIds = outboxes.map((outbox) => outbox.id);
  const cancellationReason = "计划修订已取消，原审批请求不再有效";
  if (outboxIds.length > 0) {
    // Keep the same parent -> recipient lock order as the delivery worker.
    // Reversing it can deadlock cancellation against a claim heartbeat.
    await tx.notificationOutbox.updateMany({
      where: {
        id: { in: outboxIds },
        status: { in: ["PENDING", "PROCESSING", "FAILED"] },
      },
      data: {
        status: "CANCELED",
        lockedUntil: null,
        lastError: cancellationReason,
      },
    });
    await tx.notificationOutboxRecipient.updateMany({
      where: {
        outboxId: { in: outboxIds },
        status: { in: ["PENDING", "PROCESSING", "FAILED"] },
      },
      data: {
        status: "CANCELED",
        lockedUntil: null,
        lastError: cancellationReason,
      },
    });
  }
  await tx.inAppNotification.updateMany({
    where: {
      entityType: "RevisionNode",
      entityId: revisionNodeId,
      readAt: null,
      payload: {
        path: ["kind"],
        equals: "revision_pending_review",
      },
    },
    data: { readAt: new Date() },
  });
}

export async function applyRevisionTx(
  tx: PrismaTx,
  {
    actor,
    task,
    revisionNodeId,
    reviewComment,
    allowedRevisionStatuses,
  }: {
    actor: ProjectManagementActor;
    task: TaskForAuthorization;
    revisionNodeId: string;
    reviewComment: string;
    allowedRevisionStatuses: RevisionStatus[];
  },
): Promise<RevisionMutationResult> {
  const revision = await tx.revisionNode.findUnique({
    where: { id: revisionNodeId },
    include: {
      node: true,
      targetPlanVersion: true,
    },
  });
  if (!revision) throw notFoundError();
  const targetPlanVersionId = revision.targetPlanVersion?.id;
  if (!targetPlanVersionId) {
    throw stateConflictError("Revision 缺少目标计划版本");
  }
  if (!allowedRevisionStatuses.includes(revision.status)) {
    throw stateConflictError("Revision 状态已变化，请刷新后重试");
  }
  if (revision.targetPlanVersion?.status !== "DRAFT") {
    throw stateConflictError("Revision 目标计划已失效，请刷新后重试");
  }
  if (
    revision.node.taskId !== task.id ||
    revision.targetPlanVersion.taskId !== task.id ||
    revision.targetPlanVersion.baseVersionId !== revision.basePlanVersionId ||
    revision.targetPlanVersion.revisionNodeId !== revision.id
  ) {
    throw stateConflictError("Revision 目标计划关联异常，请驳回或取消后重新提交");
  }
  if (revision.basePlanVersionId !== task.currentPlanVersionId) {
    throw planVersionConflictError();
  }
  if (revision.baseTaskLockVersion !== task.lockVersion) {
    throw planVersionConflictError();
  }
  if (task.status !== "ACTIVE") {
    throw stateConflictError("只有执行中的 Task 可以生效 Revision");
  }

  await assertRevisionTargetValidTx(tx, task, revision, targetPlanVersionId);
  const baseEntries = await loadPlanEntriesTx(tx, revision.basePlanVersionId);
  const targetPlan = await loadPlanForValidationTx(tx, targetPlanVersionId);
  assertRevisionTargetPlanValid(targetPlan);
  const targetEntries = targetPlan.nodes;
  if (
    targetEntries.some(
      (entry) => entry.node.taskId !== task.id || entry.node.deletedAt !== null,
    ) ||
    !targetEntries.some((entry) => entry.nodeId === revision.nodeId)
  ) {
    throw stateConflictError("Revision 目标计划结构异常，请驳回或取消后重新提交");
  }
  const carriedBaseNodeIds = new Set(
    targetEntries
      .filter((entry) => entry.isCarryForward)
      .map((entry) => entry.nodeId),
  );
  const replacedNodeIds = baseEntries
    .filter(
      (entry) =>
        !carriedBaseNodeIds.has(entry.nodeId) &&
        entry.node.type !== "REVISION" &&
        entry.node.status !== "COMPLETED",
    )
    .map((entry) => entry.nodeId);
  const now = new Date();
  const revisionMarkedEffective = await tx.revisionNode.updateMany({
    where: {
      id: revisionNodeId,
      status: { in: allowedRevisionStatuses },
    },
    data: {
      status: "EFFECTIVE",
      reviewedAt: now,
      reviewedByAccountId: actor.accountId,
      effectiveAt: now,
      reviewComment,
    },
  });
  if (revisionMarkedEffective.count !== 1) {
    throw stateConflictError("Revision 状态已变化，请刷新后重试");
  }
  const oldCurrentUpdated = await tx.taskPlanVersion.updateMany({
    where: { id: task.currentPlanVersionId, status: "CURRENT" },
    data: { status: "HISTORICAL" },
  });
  if (oldCurrentUpdated.count !== 1) {
    throw planVersionConflictError();
  }
  const targetCurrentUpdated = await tx.taskPlanVersion.updateMany({
    where: { id: targetPlanVersionId, status: "DRAFT" },
    data: {
      status: "CURRENT",
      activatedAt: now,
      snapshotHash: hashLifecyclePlan(targetPlan),
    },
  });
  if (targetCurrentUpdated.count !== 1) {
    throw stateConflictError("Revision 目标计划已失效，请刷新后重试");
  }
  if (replacedNodeIds.length > 0) {
    await tx.taskNode.updateMany({
      where: {
        id: { in: replacedNodeIds },
        status: { in: ["PENDING", "ACTIVE"] },
      },
      data: { status: "REVISED" },
    });
  }
  await tx.taskNode.update({
    where: { id: revision.nodeId },
    data: { status: "COMPLETED" },
  });

  const activeMilestoneNodeId = await activateNextMilestoneInPlanTx(
    tx,
    targetEntries,
  );
  const updatedTask = await tx.task.update({
    where: { id: task.id },
    data: {
      currentPlanVersionId: targetPlanVersionId,
      activeMilestoneNodeId,
      lockVersion: { increment: 1 },
    },
    select: {
      currentPlanVersionId: true,
      lockVersion: true,
      activeMilestoneNodeId: true,
    },
  });
  const taskAfterPlanSwitch = {
    ...task,
    currentPlanVersionId: updatedTask.currentPlanVersionId,
  };
  await createDomainAuditEventTx(tx, {
    actorAccountId: actor.accountId,
    actorPersonId: actor.personId,
    action: "pm.revision.apply",
    entityType: "RevisionNode",
    entityId: revisionNodeId,
    taskId: task.id,
    before: jsonValue({
      currentPlanVersionId: task.currentPlanVersionId,
      lockVersion: task.lockVersion,
      revisionStatus: revision.status,
    }),
    after: jsonValue({
      currentPlanVersionId: updatedTask.currentPlanVersionId,
      lockVersion: updatedTask.lockVersion,
      activeMilestoneNodeId,
      revisedNodeCount: replacedNodeIds.length,
    }),
    reason: reviewComment || revision.reason,
  });
  await createLifecycleNotificationsTx(tx, {
    actor,
    task: taskAfterPlanSwitch,
    kind: "revision_applied",
    category: "REVISION",
    eventKey: `pm:revision:applied:${revisionNodeId}`,
    title: "计划修订已生效",
    summary: `任务「${task.title}」的当前计划已更新`,
    entityType: "RevisionNode",
    entityId: revisionNodeId,
    mandatory: true,
    recipients: await revisionCreatorAndOwnersTx(
      tx,
      taskAfterPlanSwitch,
      revision,
    ),
  });

  return {
    taskId: task.id,
    revisionNodeId,
    targetPlanVersionId,
    status: "EFFECTIVE",
    currentPlanVersionId: updatedTask.currentPlanVersionId,
    lockVersion: updatedTask.lockVersion,
  };
}

export function assertTaskActiveForPlanChange(task: TaskForAuthorization) {
  if (task.status !== "ACTIVE") {
    throw stateConflictError("只有执行中的 Task 可以修订计划");
  }
}

export function assertCanManageRevision(
  actor: ProjectManagementActor,
  task: TaskForAuthorization,
  revision: { node: { createdByAccountId: string } },
) {
  assertAuthorized({
    actor,
    action: "revision.create",
    resource: taskAuthorizationResource(task),
  });
  if (revision.node.createdByAccountId === actor.accountId) return;
  assertAuthorized({
    actor,
    action: "task.manage_members",
    resource: taskAuthorizationResource(task),
  });
}

export function assertRevisionBaseline(
  task: TaskForAuthorization,
  input: CreateRevisionInput,
) {
  if (input.basePlanVersionId !== task.currentPlanVersionId) {
    throw planVersionConflictError();
  }
  if (input.baseTaskLockVersion !== task.lockVersion) {
    throw planVersionConflictError();
  }
}

export async function nextPlanVersionNoTx(tx: PrismaTx, taskId: string): Promise<number> {
  const latest = await tx.taskPlanVersion.findFirst({
    where: { taskId },
    orderBy: { versionNo: "desc" },
    select: { versionNo: true },
  });
  return (latest?.versionNo ?? 0) + 1;
}

export function summarizeRevisionCandidate(
  currentEntries: PlanEntry[],
  carriedEntries: PlanEntry[],
  input: CreateRevisionInput,
) {
  return {
    revisionAt: input.revisionAt,
    carriedNodeCount: carriedEntries.length,
    replacedNodeCount: currentEntries.length - carriedEntries.length,
    replacementMilestoneCount: input.replacementMilestones.length,
    terminationName: input.termination.name,
  };
}

export async function loadRevisionForMutationTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  revisionNodeId: string,
) {
  const locator = await tx.revisionNode.findUnique({
    where: { id: revisionNodeId },
    select: {
      basePlanVersion: { select: { taskId: true } },
    },
  });
  if (!locator) throw notFoundError();
  await lockTaskTx(tx, locator.basePlanVersion.taskId);
  const revision = await tx.revisionNode.findUnique({
    where: { id: revisionNodeId },
    include: {
      node: true,
      targetPlanVersion: true,
      basePlanVersion: { select: { taskId: true } },
    },
  });
  if (!revision) throw notFoundError();
  const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
  const task = await loadTaskForAuthorizationTx(tx, revision.basePlanVersion.taskId);
  assertTaskVisible(refreshedActor, task);
  return {
    refreshedActor,
    task,
    revision,
    targetPlanVersionId: revision.targetPlanVersion?.id ?? null,
  };
}

async function assertRevisionTargetValidTx(
  tx: PrismaTx,
  task: TaskForAuthorization,
  revision: {
    id: string;
    nodeId: string;
    basePlanVersionId: string;
    baseTaskLockVersion: number;
    revisionAt: Date;
  },
  targetPlanVersionId: string,
) {
  if (revision.basePlanVersionId !== task.currentPlanVersionId) {
    throw planVersionConflictError();
  }
  if (revision.baseTaskLockVersion !== task.lockVersion) {
    throw planVersionConflictError();
  }
  const targetPlan = await loadPlanForValidationTx(tx, targetPlanVersionId);
  assertRevisionTargetPlanValid(targetPlan);
  const basePlan = await loadPlanForValidationTx(
    tx,
    revision.basePlanVersionId,
  );
  assertRevisionStartUnchanged(
    basePlan.plannedStartAt,
    targetPlan.plannedStartAt,
  );
  if (
    inspectRevisionTargetStructure({
      basePlan,
      targetPlan,
      targetPlanVersionId,
      revisionId: revision.id,
      revisionTaskNodeId: revision.nodeId,
    }).length > 0
  ) {
    throw stateConflictError(
      "Revision 目标计划结构异常，请驳回或取消后重新提交",
    );
  }
  const terminalAt = targetPlan.nodes.find(
    (entry) => entry.node.type === "TERMINATION",
  )?.node.termination?.plannedAt;
  if (!terminalAt) {
    throw stateConflictError("Revision 候选计划缺少 Terminal");
  }
  await assertRevisionAtValidTx(tx, {
    taskId: task.id,
    revisionAt: revision.revisionAt,
    plannedStartAt: targetPlan.plannedStartAt,
    terminalAt,
    completedMilestoneTimes: targetPlan.nodes.flatMap((entry) =>
      entry.node.milestone && entry.node.status === "COMPLETED"
        ? [entry.node.milestone.expectedCompletedAt]
        : [],
    ),
  });
}

export async function assertRevisionAtValidTx(
  tx: PrismaTx,
  input: {
    taskId: string;
    revisionAt: Date;
    plannedStartAt: Date | null;
    terminalAt: Date;
    completedMilestoneTimes: Date[];
  },
) {
  if (!input.plannedStartAt) {
    throw planChronologyInvalidError("计划开始时间不能为空", {
      revisionAt: ["Revision 必须位于有效计划范围内"],
    });
  }
  const fail = (message: string): never => {
    throw planChronologyInvalidError(message, { revisionAt: [message] });
  };
  if (input.revisionAt < input.plannedStartAt) {
    fail("Revision 时间不能早于计划开始时间");
  }
  if (input.revisionAt > input.terminalAt) {
    fail("Revision 时间不能晚于 Terminal");
  }
  const lastCompletedMilestoneAt = input.completedMilestoneTimes.reduce<Date | null>(
    (latest, value) => (!latest || value > latest ? value : latest),
    null,
  );
  if (lastCompletedMilestoneAt && input.revisionAt < lastCompletedMilestoneAt) {
    fail("Revision 时间不能早于最后一个已完成 Milestone");
  }
  const lastEffectiveRevision = await tx.revisionNode.findFirst({
    where: {
      status: "EFFECTIVE",
      node: { taskId: input.taskId },
    },
    orderBy: [{ revisionAt: "desc" }, { id: "desc" }],
    select: { revisionAt: true },
  });
  if (
    lastEffectiveRevision &&
    input.revisionAt < lastEffectiveRevision.revisionAt
  ) {
    fail("Revision 时间不能早于上一条已生效 Revision");
  }
}

export function assertRevisionStartUnchanged(
  basePlannedStartAt: Date | null,
  targetPlannedStartAt: Date | null,
) {
  if (
    !basePlannedStartAt ||
    !targetPlannedStartAt ||
    basePlannedStartAt.getTime() !== targetPlannedStartAt.getTime()
  ) {
    throw planVersionConflictError("Revision 不能修改计划开始时间");
  }
}
