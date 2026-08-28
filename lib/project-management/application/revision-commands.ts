import { randomUUID } from "node:crypto";
import {
  Prisma,
  type RevisionStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertAuthorized,
} from "@/lib/project-management/authorization";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  createLifecycleNotificationsTx,
  notifyGlobalAdministratorsTx,
  notifyRevisionResultTx,
  revisionCreatorAndOwnersTx,
} from "@/lib/project-management/application/lifecycle-notifications";
import { recipientsForAccountsOrPeopleTx } from "@/lib/project-management/application/notification-utils";
import {
  cancelRevisionInputSchema,
  createRevisionInputSchema,
  rejectRevisionInputSchema,
  revisionDecisionInputSchema,
  reviseRejectedRevisionInputSchema,
  type CreateRevisionInput,
} from "@/lib/project-management/validations/lifecycle";
import {
  notFoundError,
  planChronologyInvalidError,
  planVersionConflictError,
  stateConflictError,
} from "@/lib/project-management/application/errors";
import { assertTaskApprovalAvailableTx } from "@/lib/project-management/task-approval-gate";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import { taskAuthorizationResource } from "@/lib/project-management/application/task-authorization-resource";
import {
  activeGlobalApprovalAdministratorAccountIdsTx,
  lockGlobalApprovalAdministratorSetTx,
} from "@/lib/project-management/approval-administrators";
import {
  type LifecyclePlanEntry,
  type LifecycleTaskForAuthorization,
} from "@/lib/project-management/application/lifecycle-records";
import {
  hashLifecyclePlan,
  hashLifecycleRequest,
  revisionPlanAuditState,
  summarizeRevisionPlanChanges,
} from "@/lib/project-management/application/lifecycle-plan-audit";
import {
  activateNextMilestoneInPlanTx,
  assertLegacyCurrentPlanUsableAsRepairBase,
  assertRevisionTargetPlanValid,
  assertTaskVisible,
  createPlanNodesTx,
  loadCurrentPlanEntriesTx,
  loadPlanEntriesTx,
  loadPlanForValidationTx,
  loadTaskForAuthorizationTx,
  lockIdempotencyKeyTx,
  lockTaskTx,
} from "@/lib/project-management/application/lifecycle-domain";

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

export async function createRevision(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<RevisionMutationResult & { created: boolean }> {
  const parsed = createRevisionInputSchema.parse(input);
  const requestHash = hashLifecycleRequest("revision.create", parsed);

  return prisma.$transaction(async (tx) => {
    await lockGlobalApprovalAdministratorSetTx(tx);
    await lockTaskTx(tx, parsed.taskId);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const task = await loadTaskForAuthorizationTx(tx, parsed.taskId);
    assertTaskVisible(refreshedActor, task);
    assertAuthorized({
      actor: refreshedActor,
      action: "revision.create",
      resource: taskAuthorizationResource(task),
    });
    assertTaskActiveForPlanChange(task);
    await lockIdempotencyKeyTx(
      tx,
      refreshedActor.accountId,
      parsed.idempotencyKey,
    );

    const existing = await tx.taskPlanVersion.findFirst({
      where: {
        createdByAccountId: refreshedActor.accountId,
        idempotencyKey: parsed.idempotencyKey,
      },
      select: {
        id: true,
        taskId: true,
        status: true,
        revisionNodeId: true,
        creationRequestHash: true,
        revisionNode: { select: { status: true } },
      },
    });
    if (existing) {
      if (existing.creationRequestHash !== requestHash) {
        throw stateConflictError("相同请求键已用于不同内容，请刷新后重试");
      }
      return {
        taskId: existing.taskId,
        revisionNodeId: existing.revisionNodeId ?? "",
        targetPlanVersionId: existing.id,
        status: existing.revisionNode?.status ?? "PENDING_APPROVAL",
        currentPlanVersionId: task.currentPlanVersionId,
        lockVersion: task.lockVersion,
        created: false,
      };
    }

    await assertTaskApprovalAvailableTx(tx, task.id);
    assertRevisionBaseline(task, parsed);
    const activeCandidate = await tx.taskPlanVersion.findFirst({
      where: {
        taskId: task.id,
        status: "DRAFT",
        revisionNodeId: { not: null },
      },
      select: { id: true },
    });
    if (activeCandidate) {
      throw stateConflictError("当前 Task 已有待处理的 Revision");
    }
    const currentPlan = await loadCurrentPlanEntriesTx(tx, task);
    assertLegacyCurrentPlanUsableAsRepairBase(currentPlan);
    await assertRevisionAtValidTx(tx, {
      taskId: task.id,
      revisionAt: parsed.revisionAt,
      plannedStartAt: currentPlan.plannedStartAt,
      terminalAt: parsed.termination.plannedAt,
      completedMilestoneTimes: currentPlan.nodes.flatMap((entry) =>
        entry.node.milestone && entry.node.status === "COMPLETED"
          ? [entry.node.milestone.expectedCompletedAt]
          : [],
      ),
    });

    const carriedEntries = currentPlan.nodes.filter(isRevisionCarryForwardEntry);
    const targetPlanVersionId = randomUUID();
    const revisionTaskNodeId = randomUUID();
    const revisionNodeId = randomUUID();
    const versionNo = await nextPlanVersionNoTx(tx, task.id);
    await tx.taskPlanVersion.create({
      data: {
        id: targetPlanVersionId,
        taskId: task.id,
        versionNo,
        status: "DRAFT",
        baseVersionId: task.currentPlanVersionId,
        reason: parsed.reason,
        createdByAccountId: refreshedActor.accountId,
        idempotencyKey: parsed.idempotencyKey,
        creationRequestHash: requestHash,
        snapshotHash: "",
        plannedStartAt: currentPlan.plannedStartAt,
      },
    });
    for (const [index, entry] of carriedEntries.entries()) {
      await tx.planVersionNode.create({
        data: {
          planVersionId: targetPlanVersionId,
          nodeId: entry.nodeId,
          sequence: index + 1,
          isCarryForward: true,
        },
      });
    }
    await tx.taskNode.create({
      data: {
        id: revisionTaskNodeId,
        taskId: task.id,
        type: "REVISION",
        status: "PENDING",
        businessDescription: parsed.description,
        createdByAccountId: refreshedActor.accountId,
      },
    });
    await tx.revisionNode.create({
      data: {
        id: revisionNodeId,
        nodeId: revisionTaskNodeId,
        reason: parsed.reason,
        revisionAt: parsed.revisionAt,
        reviewRound: 1,
        basePlanVersionId: task.currentPlanVersionId,
        baseTaskLockVersion: task.lockVersion,
        status: "PENDING_APPROVAL",
        affectedSummary: jsonValue(
          summarizeRevisionCandidate(currentPlan.nodes, carriedEntries, parsed),
        ),
      },
    });
    await tx.planVersionNode.create({
      data: {
        planVersionId: targetPlanVersionId,
        nodeId: revisionTaskNodeId,
        sequence: carriedEntries.length + 1,
      },
    });
    await tx.taskPlanVersion.update({
      where: { id: targetPlanVersionId },
      data: { revisionNodeId },
    });
    await createPlanNodesTx(tx, {
      taskId: task.id,
      planVersionId: targetPlanVersionId,
      actorAccountId: refreshedActor.accountId,
      milestones: parsed.replacementMilestones,
      termination: parsed.termination,
      startingSequence: carriedEntries.length + 2,
      carryForward: false,
    });
    const targetPlan = await loadPlanForValidationTx(tx, targetPlanVersionId);
    assertRevisionTargetPlanValid(targetPlan);
    await tx.taskPlanVersion.update({
      where: { id: targetPlanVersionId },
      data: { snapshotHash: hashLifecyclePlan(targetPlan) },
    });

    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.revision.create",
      entityType: "RevisionNode",
      entityId: revisionNodeId,
      taskId: task.id,
      after: jsonValue({
        status: "PENDING_APPROVAL",
        basePlanVersionId: task.currentPlanVersionId,
        targetPlanVersionId,
        baseTaskLockVersion: task.lockVersion,
        revisionAt: parsed.revisionAt,
        name: parsed.reason,
        description: parsed.description,
        reviewRound: 1,
        replacementMilestoneCount: parsed.replacementMilestones.length,
        terminationName: parsed.termination.name,
      }),
      reason: parsed.reason,
    });
    await notifyGlobalAdministratorsTx(tx, {
      actor: refreshedActor,
      task,
      kind: "revision_pending_review",
      category: "REVISION",
      eventKey: `pm:revision:pending_review:${revisionNodeId}:round:1`,
      title: "计划修订待审批",
      summary: `任务「${task.title}」有新的计划修订等待审批`,
      entityType: "RevisionNode",
      entityId: revisionNodeId,
      mandatory: true,
      context: {
        round: 1,
        beforeStatus: null,
        afterStatus: "PENDING_APPROVAL",
      },
    });

    return {
      taskId: task.id,
      revisionNodeId,
      targetPlanVersionId,
      status: "PENDING_APPROVAL",
      currentPlanVersionId: task.currentPlanVersionId,
      lockVersion: task.lockVersion,
      created: true,
    };
  });
}

export async function reviseRejectedRevision(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<RevisionMutationResult> {
  const parsed = reviseRejectedRevisionInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    await lockGlobalApprovalAdministratorSetTx(tx);
    const { refreshedActor, task, revision, targetPlanVersionId } =
      await loadRevisionForMutationTx(tx, actor, parsed.revisionNodeId);
    assertCanManageRevision(refreshedActor, task, revision);
    assertTaskActiveForPlanChange(task);
    if (revision.status !== "REJECTED") {
      throw stateConflictError("只有已驳回的 Revision 可以修改后重新送审");
    }
    if (!targetPlanVersionId || !revision.targetPlanVersion) {
      throw stateConflictError("Revision 缺少候选计划");
    }
    if (
      revision.targetPlanVersion.status !== "DRAFT" ||
      revision.targetPlanVersion.updatedAt.getTime() !==
        parsed.expectedTargetPlanUpdatedAt.getTime()
    ) {
      throw planVersionConflictError("Revision 候选计划已更新，请刷新后重试");
    }
    if (
      revision.basePlanVersionId !== task.currentPlanVersionId ||
      revision.baseTaskLockVersion !== task.lockVersion
    ) {
      throw planVersionConflictError();
    }
    await assertTaskApprovalAvailableTx(tx, task.id);

    const currentPlan = await loadCurrentPlanEntriesTx(tx, task);
    await assertRevisionAtValidTx(tx, {
      taskId: task.id,
      revisionAt: parsed.revisionAt,
      plannedStartAt: currentPlan.plannedStartAt,
      terminalAt: parsed.termination.plannedAt,
      completedMilestoneTimes: currentPlan.nodes.flatMap((entry) =>
        entry.node.milestone && entry.node.status === "COMPLETED"
          ? [entry.node.milestone.expectedCompletedAt]
          : [],
      ),
    });

    const targetPlan = await loadPlanForValidationTx(tx, targetPlanVersionId);
    assertRevisionTargetPlanValid(targetPlan);
    assertRevisionStartUnchanged(
      currentPlan.plannedStartAt,
      targetPlan.plannedStartAt,
    );
    const beforePlanAudit = revisionPlanAuditState(targetPlan);
    const revisionEntryIndex = targetPlan.nodes.findIndex(
      (entry) => entry.nodeId === revision.nodeId,
    );
    if (revisionEntryIndex < 0) {
      throw stateConflictError("Revision 候选计划结构不完整");
    }
    const replaceableEntries = targetPlan.nodes.slice(revisionEntryIndex + 1);
    const replaceableNodeIds = replaceableEntries.map((entry) => entry.nodeId);
    if (replaceableNodeIds.length > 0) {
      await tx.planVersionNode.deleteMany({
        where: { planVersionId: targetPlanVersionId, nodeId: { in: replaceableNodeIds } },
      });
      await tx.milestoneNode.deleteMany({
        where: { nodeId: { in: replaceableNodeIds } },
      });
      await tx.terminationNode.deleteMany({
        where: { nodeId: { in: replaceableNodeIds } },
      });
      await tx.taskNode.deleteMany({
        where: { id: { in: replaceableNodeIds } },
      });
    }

    await tx.taskPlanVersion.update({
      where: { id: targetPlanVersionId },
      data: {
        reason: parsed.reason,
        snapshotHash: "",
      },
    });
    await tx.taskNode.update({
      where: { id: revision.nodeId },
      data: { businessDescription: parsed.description },
    });
    await tx.revisionNode.update({
      where: { id: parsed.revisionNodeId },
      data: {
        reason: parsed.reason,
        revisionAt: parsed.revisionAt,
        status: "PENDING_APPROVAL",
        reviewRound: { increment: 1 },
        reviewedAt: null,
        reviewedByAccountId: null,
        reviewComment: "",
        affectedSummary: jsonValue({
          carriedNodeCount: revisionEntryIndex,
          replacementMilestoneCount: parsed.replacementMilestones.length,
          terminationName: parsed.termination.name,
        }),
      },
    });
    await createPlanNodesTx(tx, {
      taskId: task.id,
      planVersionId: targetPlanVersionId,
      actorAccountId: refreshedActor.accountId,
      milestones: parsed.replacementMilestones,
      termination: parsed.termination,
      startingSequence: revisionEntryIndex + 2,
      carryForward: false,
    });
    const updatedTargetPlan = await loadPlanForValidationTx(
      tx,
      targetPlanVersionId,
    );
    assertRevisionTargetPlanValid(updatedTargetPlan);
    const afterPlanAudit = revisionPlanAuditState(updatedTargetPlan);
    await tx.taskPlanVersion.update({
      where: { id: targetPlanVersionId },
      data: { snapshotHash: afterPlanAudit.snapshotHash },
    });
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.revision.resubmit",
      entityType: "RevisionNode",
      entityId: parsed.revisionNodeId,
      taskId: task.id,
      before: jsonValue({
        status: revision.status,
        reviewRound: revision.reviewRound,
        targetPlanVersionId,
        targetPlanUpdatedAt: revision.targetPlanVersion.updatedAt,
        plan: beforePlanAudit,
      }),
      after: jsonValue({
        status: "PENDING_APPROVAL",
        revisionAt: parsed.revisionAt,
        name: parsed.reason,
        description: parsed.description,
        reviewRound: revision.reviewRound + 1,
        targetPlanVersionId,
        replacementMilestoneCount: parsed.replacementMilestones.length,
        terminationName: parsed.termination.name,
        plan: afterPlanAudit,
        changes: summarizeRevisionPlanChanges(targetPlan, updatedTargetPlan),
      }),
      reason: parsed.reason,
    });
    await notifyGlobalAdministratorsTx(tx, {
      actor: refreshedActor,
      task,
      kind: "revision_pending_review",
      category: "REVISION",
      eventKey: `pm:revision:pending_review:${parsed.revisionNodeId}:round:${revision.reviewRound + 1}`,
      title: "计划修订已重新提交审批",
      summary: `任务「${task.title}」的计划修订已修改并重新送审`,
      entityType: "RevisionNode",
      entityId: parsed.revisionNodeId,
      mandatory: true,
      context: {
        round: revision.reviewRound + 1,
        beforeStatus: "REJECTED",
        afterStatus: "PENDING_APPROVAL",
      },
    });
    return {
      taskId: task.id,
      revisionNodeId: parsed.revisionNodeId,
      targetPlanVersionId,
      status: "PENDING_APPROVAL",
      currentPlanVersionId: task.currentPlanVersionId,
      lockVersion: task.lockVersion,
    };
  });
}

export async function approveRevision(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<RevisionMutationResult> {
  const parsed = revisionDecisionInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const { refreshedActor, task, revision } =
      await loadRevisionForMutationTx(tx, actor, parsed.revisionNodeId);
    assertAuthorized({
      actor: refreshedActor,
      action: "revision.review",
      resource: taskAuthorizationResource(task),
    });
    if (revision.status !== "PENDING_APPROVAL") {
      if (revision.status === "EFFECTIVE") {
        return {
          taskId: task.id,
          revisionNodeId: parsed.revisionNodeId,
          targetPlanVersionId: revision.targetPlanVersion?.id ?? null,
          status: "EFFECTIVE",
          currentPlanVersionId: task.currentPlanVersionId,
          lockVersion: task.lockVersion,
        };
      }
      throw stateConflictError("只有待审批 Revision 可以通过");
    }
    return applyRevisionTx(tx, {
      actor: refreshedActor,
      task,
      revisionNodeId: parsed.revisionNodeId,
      reviewComment: parsed.comment,
      allowedRevisionStatuses: ["PENDING_APPROVAL"],
    });
  });
}

export async function rejectRevision(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<RevisionMutationResult> {
  const parsed = rejectRevisionInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const { refreshedActor, task, revision } =
      await loadRevisionForMutationTx(tx, actor, parsed.revisionNodeId);
    assertAuthorized({
      actor: refreshedActor,
      action: "revision.review",
      resource: taskAuthorizationResource(task),
    });
    if (revision.status !== "PENDING_APPROVAL") {
      if (revision.status === "REJECTED") {
        return {
          taskId: task.id,
          revisionNodeId: parsed.revisionNodeId,
          targetPlanVersionId: revision.targetPlanVersion?.id ?? null,
          status: "REJECTED",
          currentPlanVersionId: task.currentPlanVersionId,
          lockVersion: task.lockVersion,
        };
      }
      throw stateConflictError("只有待审批 Revision 可以驳回");
    }
    const rejected = await tx.revisionNode.updateMany({
      where: { id: parsed.revisionNodeId, status: "PENDING_APPROVAL" },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewedByAccountId: refreshedActor.accountId,
        reviewComment: parsed.comment,
      },
    });
    if (rejected.count !== 1) {
      throw stateConflictError("只有待审批 Revision 可以驳回");
    }
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.revision.reject",
      entityType: "RevisionNode",
      entityId: parsed.revisionNodeId,
      taskId: task.id,
      before: jsonValue({
        status: revision.status,
        reviewRound: revision.reviewRound,
      }),
      after: jsonValue({
        status: "REJECTED",
        reviewRound: revision.reviewRound,
      }),
      reason: parsed.comment,
    });
    await notifyRevisionResultTx(tx, {
      actor: refreshedActor,
      task,
      revisionNodeId: parsed.revisionNodeId,
      title: "计划修订已驳回",
      summary: parsed.comment,
      eventKey: `pm:revision:result:${parsed.revisionNodeId}:round:${revision.reviewRound}:rejected`,
      recipients: await revisionCreatorAndOwnersTx(tx, task, revision),
    });

    return {
      taskId: task.id,
      revisionNodeId: parsed.revisionNodeId,
      targetPlanVersionId: revision.targetPlanVersion?.id ?? null,
      status: "REJECTED",
      currentPlanVersionId: task.currentPlanVersionId,
      lockVersion: task.lockVersion,
    };
  });
}

export async function cancelRevision(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<RevisionMutationResult> {
  const parsed = cancelRevisionInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const { refreshedActor, task, revision } =
      await loadRevisionForMutationTx(tx, actor, parsed.revisionNodeId);
    assertCanManageRevision(refreshedActor, task, revision);
    if (
      revision.status !== "PENDING_APPROVAL" &&
      revision.status !== "REJECTED"
    ) {
      if (revision.status === "CANCELLED") {
        return {
          taskId: task.id,
          revisionNodeId: parsed.revisionNodeId,
          targetPlanVersionId: revision.targetPlanVersion?.id ?? null,
          status: "CANCELLED",
          currentPlanVersionId: task.currentPlanVersionId,
          lockVersion: task.lockVersion,
        };
      }
      throw stateConflictError("该 Revision 已生效，不能取消");
    }
    const cancelled = await tx.revisionNode.updateMany({
      where: {
        id: parsed.revisionNodeId,
        status: { in: ["PENDING_APPROVAL", "REJECTED"] },
      },
      data: {
        status: "CANCELLED",
        reviewedAt: new Date(),
        reviewedByAccountId: refreshedActor.accountId,
        reviewComment: parsed.comment,
      },
    });
    if (cancelled.count !== 1) {
      throw stateConflictError("该 Revision 已生效，不能取消");
    }
    if (revision.targetPlanVersion?.id) {
      const abandoned = await tx.taskPlanVersion.updateMany({
        where: { id: revision.targetPlanVersion.id, status: "DRAFT" },
        data: { status: "ABANDONED" },
      });
      if (abandoned.count !== 1) {
        throw stateConflictError("Revision 目标计划已失效，请刷新后重试");
      }
      await tx.taskNode.updateMany({
        where: {
          planVersionEntries: {
            some: {
              planVersionId: revision.targetPlanVersion.id,
              isCarryForward: false,
            },
          },
          status: { in: ["PENDING", "ACTIVE"] },
          type: { in: ["MILESTONE", "REVISION", "TERMINATION"] },
        },
        data: { status: "CANCELLED" },
      });
    }
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.revision.cancel",
      entityType: "RevisionNode",
      entityId: parsed.revisionNodeId,
      taskId: task.id,
      before: jsonValue({
        status: revision.status,
        reviewRound: revision.reviewRound,
      }),
      after: jsonValue({
        status: "CANCELLED",
        targetPlanVersionStatus: "ABANDONED",
        reviewRound: revision.reviewRound,
      }),
      reason: parsed.comment,
    });
    await cancelRevisionApprovalNotificationsTx(
      tx,
      parsed.revisionNodeId,
    );
    const administratorAccountIds =
      await activeGlobalApprovalAdministratorAccountIdsTx(tx);
    const recipients = await recipientsForAccountsOrPeopleTx(tx, {
      accountIds: [
        revision.node.createdByAccountId,
        refreshedActor.accountId,
        ...administratorAccountIds,
      ],
      personIds: task.members
        .filter((member) => member.role === "OWNER" && !member.removedAt)
        .map((member) => member.personId),
    });
    const cancelReason = parsed.comment.trim() || "未填写";
    await createLifecycleNotificationsTx(tx, {
      actor: refreshedActor,
      task,
      kind: "revision_cancelled",
      category: "REVISION",
      eventKey: `pm:revision:cancelled:${parsed.revisionNodeId}:round:${revision.reviewRound}`,
      title: "计划修订已取消",
      summary: `任务「${task.title}」的计划修订「${revision.reason}」已取消；取消说明：${cancelReason}`,
      entityType: "RevisionNode",
      entityId: parsed.revisionNodeId,
      mandatory: true,
      recipients,
      context: {
        revisionName: revision.reason,
        round: revision.reviewRound,
        beforeStatus: revision.status,
        afterStatus: "CANCELLED",
        cancelReason,
      },
    });

    return {
      taskId: task.id,
      revisionNodeId: parsed.revisionNodeId,
      targetPlanVersionId: revision.targetPlanVersion?.id ?? null,
      status: "CANCELLED",
      currentPlanVersionId: task.currentPlanVersionId,
      lockVersion: task.lockVersion,
    };
  });
}

async function cancelRevisionApprovalNotificationsTx(
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

async function applyRevisionTx(
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
  assertCompletedPrefixUnchanged(baseEntries, targetEntries);
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

function assertTaskActiveForPlanChange(task: TaskForAuthorization) {
  if (task.status !== "ACTIVE") {
    throw stateConflictError("只有执行中的 Task 可以修订计划");
  }
}

function assertCanManageRevision(
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

function assertRevisionBaseline(
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

async function nextPlanVersionNoTx(tx: PrismaTx, taskId: string): Promise<number> {
  const latest = await tx.taskPlanVersion.findFirst({
    where: { taskId },
    orderBy: { versionNo: "desc" },
    select: { versionNo: true },
  });
  return (latest?.versionNo ?? 0) + 1;
}

function summarizeRevisionCandidate(
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

function isRevisionCarryForwardEntry(entry: PlanEntry) {
  return (
    (entry.node.type === "MILESTONE" && entry.node.status === "COMPLETED") ||
    (entry.node.type === "REVISION" &&
      entry.node.revision?.status === "EFFECTIVE")
  );
}

async function loadRevisionForMutationTx(
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

async function assertRevisionAtValidTx(
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

function assertRevisionStartUnchanged(
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

function assertCompletedPrefixUnchanged(
  baseEntries: PlanEntry[],
  targetEntries: PlanEntry[],
) {
  const completedPrefix = baseEntries.filter(
    (entry) => entry.node.type === "MILESTONE" && entry.node.status === "COMPLETED",
  );
  const targetMilestones = targetEntries.filter(
    (entry) => entry.node.type === "MILESTONE",
  );
  for (const [index, baseEntry] of completedPrefix.entries()) {
    const targetEntry = targetMilestones[index];
    if (!targetEntry || targetEntry.nodeId !== baseEntry.nodeId) {
      throw planVersionConflictError("Revision 不能改变已完成 Milestone");
    }
  }
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
