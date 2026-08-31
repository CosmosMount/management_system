import { randomUUID } from "node:crypto";
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
import { jsonValue } from "@/lib/project-management/application/prisma-json";
import {
  cancelRevisionInputSchema,
  createRevisionInputSchema,
  rejectRevisionInputSchema,
  revisionDecisionInputSchema,
  reviseRejectedRevisionInputSchema,
} from "@/lib/project-management/validations/lifecycle";
import {
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
  hashLifecyclePlan,
  hashLifecycleRequest,
  revisionPlanAuditState,
  summarizeRevisionPlanChanges,
} from "@/lib/project-management/application/lifecycle-plan-audit";
import {
  assertLegacyCurrentPlanUsableAsRepairBase,
  assertRevisionTargetPlanValid,
  assertTaskVisible,
  createPlanNodesTx,
  loadCurrentPlanEntriesTx,
  loadPlanForValidationTx,
  loadTaskForAuthorizationTx,
  lockIdempotencyKeyTx,
  lockTaskTx,
} from "@/lib/project-management/application/lifecycle-domain";
import { isRevisionCarryForwardEntry } from "@/lib/project-management/domain/revision-target-structure";
import {
  applyRevisionTx,
  assertCanManageRevision,
  assertRevisionAtValidTx,
  assertRevisionBaseline,
  assertRevisionStartUnchanged,
  assertTaskActiveForPlanChange,
  cancelRevisionApprovalNotificationsTx,
  loadRevisionForMutationTx,
  nextPlanVersionNoTx,
  summarizeRevisionCandidate,
  type RevisionMutationResult,
} from "@/lib/project-management/application/revision-command-support";

export type { RevisionMutationResult } from "@/lib/project-management/application/revision-command-support";

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
