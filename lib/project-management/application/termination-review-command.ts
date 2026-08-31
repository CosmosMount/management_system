import type {
  Prisma,
  TaskStatus,
  TerminationOutcome,
  TerminationReviewResult,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertAuthorized } from "@/lib/project-management/authorization";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import {
  notFoundError,
  stateConflictError,
} from "@/lib/project-management/application/errors";
import {
  assertTaskVisible,
  loadTaskForAuthorizationTx,
  lockTaskTx,
} from "@/lib/project-management/application/lifecycle-domain";
import {
  notifyTaskMembersTx,
  notifyTerminationReviewResultTx,
  reviewSubmitterAndOwnersTx,
} from "@/lib/project-management/application/lifecycle-notifications";
import type { LifecyclePlanEntry } from "@/lib/project-management/application/lifecycle-records";
import { jsonValue } from "@/lib/project-management/application/prisma-json";
import { taskAuthorizationResource } from "@/lib/project-management/application/task-authorization-resource";
import {
  assertTerminationRequestStateTx,
  loadTerminationForMutationTx,
  terminationDisplayName,
  type TerminationReviewMutationResult,
} from "@/lib/project-management/application/termination-command-support";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  terminationOutcomeLabel,
  terminationReviewResultLabel,
} from "@/lib/project-management/notifications/user-facing-copy";
import { reviewTerminationDecisionInputSchema } from "@/lib/project-management/validations/lifecycle";

export async function reviewTermination(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<TerminationReviewMutationResult> {
  const parsed = reviewTerminationDecisionInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const reviewTaskId = await loadTerminationReviewTaskIdTx(
      tx,
      parsed.reviewId,
    );
    await lockTaskTx(tx, reviewTaskId);
    const review = await loadTerminationReviewForMutationTx(
      tx,
      parsed.reviewId,
    );
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const task = await loadTaskForAuthorizationTx(tx, reviewTaskId);
    assertTaskVisible(refreshedActor, task);
    assertAuthorized({
      actor: refreshedActor,
      action: "termination.review",
      resource: taskAuthorizationResource(task),
    });

    const newerReview = await tx.terminationReview.findFirst({
      where: {
        terminationNodeId: review.terminationNodeId,
        OR: [
          { createdAt: { gt: review.createdAt } },
          { createdAt: review.createdAt, id: { gt: review.id } },
        ],
      },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    if (newerReview) {
      throw stateConflictError("只能处理最新的 Terminal 结束审批记录");
    }
    if (review.result !== "PENDING") {
      if (review.result === parsed.result) {
        return terminationReviewResult(task, review);
      }
      throw stateConflictError("该结束审批记录已处理");
    }

    const now = new Date();
    const updatedReview = await tx.terminationReview.updateMany({
      where: { id: review.id, result: "PENDING" },
      data: {
        result: parsed.result,
        reviewerAccountId: refreshedActor.accountId,
        reviewedAt: now,
        comment: parsed.comment,
      },
    });
    if (updatedReview.count !== 1) {
      throw stateConflictError("该结束审批记录已处理");
    }

    let taskStatus = task.status;
    let activeMilestoneNodeId = task.activeMilestoneNodeId;
    let lockVersion = task.lockVersion;
    let cancelledNodeCount = 0;
    if (parsed.result === "APPROVED") {
      const currentPlan = await assertTerminationRequestStateTx(
        tx,
        task,
        review.terminationNode,
        review.outcome,
      );
      const applied = await applyApprovedTerminationTx(tx, {
        task,
        termination: review.terminationNode,
        currentPlanNodes: currentPlan.nodes,
        review,
        reviewerAccountId: refreshedActor.accountId,
        now,
      });
      taskStatus = applied.status;
      activeMilestoneNodeId = applied.activeMilestoneNodeId;
      lockVersion = applied.lockVersion;
      cancelledNodeCount = applied.cancelledNodeCount;
    }

    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.termination.review",
      entityType: "TerminationReview",
      entityId: review.id,
      taskId: task.id,
      before: jsonValue({
        result: review.result,
        taskStatus: task.status,
        lockVersion: task.lockVersion,
      }),
      after: jsonValue({
        result: parsed.result,
        outcome: review.outcome,
        taskStatus,
        lockVersion,
        cancelledNodeCount,
      }),
      reason: parsed.comment,
    });

    if (parsed.result === "APPROVED") {
      await notifyTaskMembersTx(tx, {
        actor: refreshedActor,
        task: { ...task, status: taskStatus },
        kind: "task_terminated",
        category: "TASK",
        eventKey: `pm:task:terminated:${review.terminationNode.nodeId}`,
        title: "任务结束申请已通过",
        summary: terminationApprovedSummary({
          taskTitle: task.title,
          terminalName: review.terminationNode.name,
          outcome: review.outcome,
          reason: review.reason,
          summary: review.summary,
          comment: parsed.comment,
        }),
        entityType: "TerminationNode",
        entityId: review.terminationNode.id,
        linkPath: `/progress/tasks/${task.id}?focus=${review.terminationNode.nodeId}`,
        mandatory: true,
        context: {
          terminationReviewId: review.id,
          terminalName: review.terminationNode.name,
          requestedOutcome: review.outcome,
          reason: review.reason,
          summary: review.summary,
          reviewComment: parsed.comment,
        },
      });
    } else {
      await notifyTerminationReviewResultTx(tx, {
        actor: refreshedActor,
        task,
        reviewId: review.id,
        terminationNodeId: review.terminationNode.nodeId,
        result: parsed.result,
        outcome: review.outcome,
        terminalName: review.terminationNode.name,
        reason: review.reason,
        terminationSummary: review.summary,
        reviewComment: parsed.comment,
        summary: terminationDecisionSummary({
          taskTitle: task.title,
          terminalName: review.terminationNode.name,
          outcome: review.outcome,
          reason: review.reason,
          summary: review.summary,
          result: parsed.result,
          comment: parsed.comment,
        }),
        recipients: await reviewSubmitterAndOwnersTx(tx, task, review),
      });
    }

    return {
      taskId: task.id,
      reviewId: review.id,
      terminationNodeId: review.terminationNode.nodeId,
      result: parsed.result,
      outcome: review.outcome,
      taskStatus,
      activeMilestoneNodeId,
      lockVersion,
    };
  });
}

async function applyApprovedTerminationTx(
  tx: Prisma.TransactionClient,
  input: {
    task: Awaited<ReturnType<typeof loadTaskForAuthorizationTx>>;
    termination: Awaited<ReturnType<typeof loadTerminationForMutationTx>>;
    currentPlanNodes: LifecyclePlanEntry[];
    review: Awaited<ReturnType<typeof loadTerminationReviewForMutationTx>>;
    reviewerAccountId: string;
    now: Date;
  },
) {
  await tx.terminationNode.update({
    where: { id: input.termination.id },
    data: {
      outcome: input.review.outcome,
      reason: input.review.reason,
      summary: input.review.summary,
      confirmedByAccountId: input.reviewerAccountId,
      confirmedAt: input.now,
    },
  });
  await tx.taskNode.update({
    where: { id: input.termination.nodeId },
    data: { status: "COMPLETED" },
  });
  const unfinishedNodeIds = input.currentPlanNodes
    .filter(
      (entry) =>
        entry.nodeId !== input.termination.nodeId &&
        entry.node.status !== "COMPLETED" &&
        entry.node.status !== "REVISED",
    )
    .map((entry) => entry.nodeId);
  if (unfinishedNodeIds.length > 0) {
    await tx.taskNode.updateMany({
      where: { id: { in: unfinishedNodeIds } },
      data: { status: "CANCELLED" },
    });
  }
  const updated = await tx.task.update({
    where: { id: input.task.id },
    data: {
      status: outcomeToTaskStatus(input.review.outcome),
      activeMilestoneNodeId: null,
      endedAt: input.now,
      lockVersion: { increment: 1 },
    },
    select: {
      status: true,
      activeMilestoneNodeId: true,
      lockVersion: true,
    },
  });
  return { ...updated, cancelledNodeCount: unfinishedNodeIds.length };
}

async function loadTerminationReviewForMutationTx(
  tx: Prisma.TransactionClient,
  reviewId: string,
) {
  const review = await tx.terminationReview.findUnique({
    where: { id: reviewId },
    include: { terminationNode: { include: { node: true } } },
  });
  if (!review || review.terminationNode.node.deletedAt) throw notFoundError();
  return review;
}

async function loadTerminationReviewTaskIdTx(
  tx: Prisma.TransactionClient,
  reviewId: string,
) {
  const review = await tx.terminationReview.findUnique({
    where: { id: reviewId },
    select: {
      terminationNode: {
        select: { node: { select: { taskId: true, deletedAt: true } } },
      },
    },
  });
  if (!review || review.terminationNode.node.deletedAt) throw notFoundError();
  return review.terminationNode.node.taskId;
}

function terminationReviewResult(
  task: Awaited<ReturnType<typeof loadTaskForAuthorizationTx>>,
  review: Awaited<ReturnType<typeof loadTerminationReviewForMutationTx>>,
): TerminationReviewMutationResult {
  return {
    taskId: task.id,
    reviewId: review.id,
    terminationNodeId: review.terminationNode.nodeId,
    result: review.result,
    outcome: review.outcome,
    taskStatus: task.status,
    activeMilestoneNodeId: task.activeMilestoneNodeId,
    lockVersion: task.lockVersion,
  };
}

function outcomeToTaskStatus(outcome: TerminationOutcome): TaskStatus {
  if (outcome === "SUCCESS") return "COMPLETED";
  if (outcome === "FAILED") return "FAILED";
  if (outcome === "CANCELLED") return "CANCELLED";
  return "TIMEOUT";
}

function terminationApprovedSummary(input: {
  taskTitle: string;
  terminalName: string;
  outcome: TerminationOutcome;
  reason: string;
  summary: string;
  comment: string;
}) {
  return [
    `任务「${input.taskTitle}」的${terminationDisplayName(input.terminalName)}结束申请已通过`,
    `结束结果：${terminationOutcomeLabel(input.outcome)}`,
    input.reason ? `原因：${input.reason}` : null,
    input.summary ? `总结：${input.summary}` : null,
    input.comment ? `审批意见：${input.comment}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("；");
}

function terminationDecisionSummary(input: {
  taskTitle: string;
  terminalName: string;
  outcome: TerminationOutcome;
  reason: string;
  summary: string;
  result: Exclude<TerminationReviewResult, "PENDING" | "APPROVED">;
  comment: string;
}) {
  return [
    `任务「${input.taskTitle}」的${terminationDisplayName(input.terminalName)}结束申请${terminationReviewResultLabel(input.result)}`,
    `拟定结果：${terminationOutcomeLabel(input.outcome)}`,
    input.reason ? `原因：${input.reason}` : null,
    input.summary ? `总结：${input.summary}` : null,
    `审批意见：${input.comment}`,
  ]
    .filter((value): value is string => Boolean(value))
    .join("；");
}
