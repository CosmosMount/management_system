import type { MilestoneReviewResult, Prisma, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertAuthorized } from "@/lib/project-management/authorization";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import {
  notFoundError,
  stateConflictError,
} from "@/lib/project-management/application/errors";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import {
  advanceCurrentPlanAfterNodeTx,
  assertNodeInCurrentPlanTx,
  assertTaskVisible,
  loadTaskForAuthorizationTx,
  lockTaskTx,
} from "@/lib/project-management/application/lifecycle-domain";
import {
  notifyGlobalAdministratorsTx,
  notifyMilestoneReviewResultTx,
  reviewSubmitterAndOwnersTx,
} from "@/lib/project-management/application/lifecycle-notifications";
import { taskAuthorizationResource } from "@/lib/project-management/application/task-authorization-resource";
import { jsonValue } from "@/lib/project-management/application/prisma-json";
import { milestoneReviewResultLabel } from "@/lib/project-management/notifications/user-facing-copy";
import { assertTaskApprovalAvailableTx } from "@/lib/project-management/task-approval-gate";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { lockGlobalApprovalAdministratorSetTx } from "@/lib/project-management/approval-administrators";
import {
  reviewMilestoneDecisionInputSchema,
  submitMilestoneReviewInputSchema,
} from "@/lib/project-management/validations/lifecycle";

export type MilestoneReviewMutationResult = {
  taskId: string;
  reviewId: string;
  milestoneNodeId: string;
  result: MilestoneReviewResult;
  taskStatus: TaskStatus;
  activeMilestoneNodeId: string | null;
  lockVersion: number;
};

export async function submitMilestoneForReview(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<MilestoneReviewMutationResult & { created: boolean }> {
  const parsed = submitMilestoneReviewInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockGlobalApprovalAdministratorSetTx(tx);
    const milestoneTaskId = await loadMilestoneTaskIdTx(
      tx,
      parsed.milestoneNodeId,
    );
    await lockTaskTx(tx, milestoneTaskId);
    const milestone = await loadMilestoneWithTaskTx(tx, parsed.milestoneNodeId);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const task = await loadTaskForAuthorizationTx(tx, milestoneTaskId);
    assertTaskVisible(refreshedActor, task);
    assertAuthorized({
      actor: refreshedActor,
      action: "milestone.submit_review",
      resource: taskAuthorizationResource(task),
    });
    const existing = await tx.milestoneReview.findUnique({
      where: {
        milestoneNodeId_idempotencyKey: {
          milestoneNodeId: milestone.id,
          idempotencyKey: parsed.idempotencyKey,
        },
      },
      select: { id: true, result: true, revokedAt: true },
    });
    if (existing) {
      if (existing.revokedAt) {
        throw stateConflictError("该验收提交已撤出，请使用新的请求键重新提交");
      }
      return {
        taskId: task.id,
        reviewId: existing.id,
        milestoneNodeId: milestone.nodeId,
        result: existing.result,
        taskStatus: task.status,
        activeMilestoneNodeId: task.activeMilestoneNodeId,
        lockVersion: task.lockVersion,
        created: false,
      };
    }
    if (
      task.status !== "ACTIVE" ||
      milestone.node.status !== "ACTIVE" ||
      task.activeMilestoneNodeId !== milestone.nodeId
    ) {
      throw stateConflictError("只有当前 Active Milestone 可以提交验收");
    }
    await assertNodeInCurrentPlanTx(tx, task, milestone.nodeId, "MILESTONE");
    await assertTaskApprovalAvailableTx(tx, task.id);

    const review = await tx.milestoneReview.create({
      data: {
        milestoneNodeId: milestone.id,
        result: "PENDING",
        submittedByAccountId: refreshedActor.accountId,
        idempotencyKey: parsed.idempotencyKey,
        evidences: {
          create: parsed.evidences.map((evidence, index) => ({
            kind: evidence.kind,
            sortOrder: evidence.sortOrder ?? index,
            externalUrl:
              evidence.kind === "LINK" ? evidence.externalUrl : null,
            note: evidence.note ?? "",
          })),
        },
      },
      select: { id: true, result: true },
    });
    await tx.milestoneNode.update({
      where: { id: milestone.id },
      data: { submittedForReviewAt: new Date() },
    });
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.milestone.review.submit",
      entityType: "MilestoneReview",
      entityId: review.id,
      taskId: task.id,
      after: jsonValue({
        milestoneNodeId: milestone.nodeId,
        result: review.result,
        evidenceCount: parsed.evidences.length,
      }),
      reason: "提交 Milestone 验收",
    });
    await notifyGlobalAdministratorsTx(tx, {
      actor: refreshedActor,
      task,
      kind: "milestone_review_submitted",
      category: "REVIEW",
      eventKey: `pm:milestone:review_submitted:${review.id}`,
      title: "里程碑待验收",
      summary: `任务「${task.title}」有里程碑等待验收`,
      entityType: "MilestoneReview",
      entityId: review.id,
      mandatory: true,
    });
    return {
      taskId: task.id,
      reviewId: review.id,
      milestoneNodeId: milestone.nodeId,
      result: review.result,
      taskStatus: task.status,
      activeMilestoneNodeId: task.activeMilestoneNodeId,
      lockVersion: task.lockVersion,
      created: true,
    };
  });
}

export async function reviewMilestone(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<MilestoneReviewMutationResult> {
  const parsed = reviewMilestoneDecisionInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const reviewTaskId = await loadMilestoneReviewTaskIdTx(tx, parsed.reviewId);
    await lockTaskTx(tx, reviewTaskId);
    const review = await loadMilestoneReviewForMutationTx(tx, parsed.reviewId);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const task = await loadTaskForAuthorizationTx(tx, reviewTaskId);
    assertTaskVisible(refreshedActor, task);
    assertAuthorized({
      actor: refreshedActor,
      action: "milestone.review",
      resource: taskAuthorizationResource(task),
    });
    const newerReview = await tx.milestoneReview.findFirst({
      where: {
        milestoneNodeId: review.milestoneNodeId,
        revokedAt: null,
        createdAt: { gt: review.createdAt },
      },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    if (newerReview) {
      throw stateConflictError("只能处理最新的 Milestone 验收记录");
    }
    if (review.result !== "PENDING" || review.revokedAt) {
      if (review.result === parsed.result) {
        return {
          taskId: task.id,
          reviewId: review.id,
          milestoneNodeId: review.milestoneNode.nodeId,
          result: review.result,
          taskStatus: task.status,
          activeMilestoneNodeId: task.activeMilestoneNodeId,
          lockVersion: task.lockVersion,
        };
      }
      throw stateConflictError("该验收记录已处理");
    }
    if (
      task.status !== "ACTIVE" ||
      review.milestoneNode.node.status !== "ACTIVE" ||
      task.activeMilestoneNodeId !== review.milestoneNode.nodeId
    ) {
      throw stateConflictError("只有当前 Active Milestone 的验收记录可以处理");
    }
    await assertNodeInCurrentPlanTx(
      tx,
      task,
      review.milestoneNode.nodeId,
      "MILESTONE",
    );

    let nextActiveMilestoneNodeId: string | null = task.activeMilestoneNodeId;
    let taskStatus: TaskStatus = task.status;
    let lockVersion = task.lockVersion;
    const now = new Date();
    const updatedReview = await tx.milestoneReview.updateMany({
      where: { id: review.id, result: "PENDING", revokedAt: null },
      data: {
        result: parsed.result,
        reviewerAccountId: refreshedActor.accountId,
        reviewedAt: now,
        comment: parsed.comment,
      },
    });
    if (updatedReview.count !== 1) {
      throw stateConflictError("该验收记录已处理");
    }
    if (parsed.result === "APPROVED") {
      await tx.milestoneNode.update({
        where: { id: review.milestoneNode.id },
        data: { completedAt: now },
      });
      await tx.taskNode.update({
        where: { id: review.milestoneNode.nodeId },
        data: { status: "COMPLETED" },
      });
      const advanced = await advanceCurrentPlanAfterNodeTx(
        tx,
        task,
        review.milestoneNode.nodeId,
      );
      nextActiveMilestoneNodeId = advanced.activeMilestoneNodeId;
      const updatedTask = await tx.task.update({
        where: { id: task.id },
        data: {
          activeMilestoneNodeId: nextActiveMilestoneNodeId,
          lockVersion: { increment: 1 },
        },
        select: {
          status: true,
          activeMilestoneNodeId: true,
          lockVersion: true,
        },
      });
      taskStatus = updatedTask.status;
      lockVersion = updatedTask.lockVersion;
    }
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.milestone.review",
      entityType: "MilestoneReview",
      entityId: review.id,
      taskId: task.id,
      before: jsonValue({
        result: review.result,
        activeMilestoneNodeId: task.activeMilestoneNodeId,
        lockVersion: task.lockVersion,
      }),
      after: jsonValue({
        result: parsed.result,
        activeMilestoneNodeId: nextActiveMilestoneNodeId,
        lockVersion,
      }),
      reason: parsed.comment,
    });
    await notifyMilestoneReviewResultTx(tx, {
      actor: refreshedActor,
      task,
      reviewId: review.id,
      result: parsed.result,
      summary:
        parsed.comment || `验收结果：${milestoneReviewResultLabel(parsed.result)}`,
      systemGeneratedSummary: !parsed.comment,
      recipients: await reviewSubmitterAndOwnersTx(tx, task, review),
    });
    return {
      taskId: task.id,
      reviewId: review.id,
      milestoneNodeId: review.milestoneNode.nodeId,
      result: parsed.result,
      taskStatus,
      activeMilestoneNodeId: nextActiveMilestoneNodeId,
      lockVersion,
    };
  });
}

async function loadMilestoneWithTaskTx(
  tx: Prisma.TransactionClient,
  nodeId: string,
) {
  const milestone = await tx.milestoneNode.findUnique({
    where: { nodeId },
    include: { node: true },
  });
  if (!milestone || milestone.node.deletedAt) throw notFoundError();
  return milestone;
}

async function loadMilestoneTaskIdTx(
  tx: Prisma.TransactionClient,
  nodeId: string,
): Promise<string> {
  const milestone = await tx.milestoneNode.findUnique({
    where: { nodeId },
    select: { node: { select: { taskId: true, deletedAt: true } } },
  });
  if (!milestone || milestone.node.deletedAt) throw notFoundError();
  return milestone.node.taskId;
}

async function loadMilestoneReviewForMutationTx(
  tx: Prisma.TransactionClient,
  reviewId: string,
) {
  const review = await tx.milestoneReview.findUnique({
    where: { id: reviewId },
    include: { milestoneNode: { include: { node: true } } },
  });
  if (!review || review.milestoneNode.node.deletedAt) throw notFoundError();
  return review;
}

async function loadMilestoneReviewTaskIdTx(
  tx: Prisma.TransactionClient,
  reviewId: string,
): Promise<string> {
  const review = await tx.milestoneReview.findUnique({
    where: { id: reviewId },
    select: {
      milestoneNode: {
        select: {
          node: { select: { taskId: true, deletedAt: true } },
        },
      },
    },
  });
  if (!review || review.milestoneNode.node.deletedAt) throw notFoundError();
  return review.milestoneNode.node.taskId;
}
