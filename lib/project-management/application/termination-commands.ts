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
  assertLegacyCurrentPlanUsableAsRepairBase,
  assertTaskVisible,
  loadCurrentPlanEntriesTx,
  loadTaskForAuthorizationTx,
  lockTaskTx,
} from "@/lib/project-management/application/lifecycle-domain";
import {
  notifyGlobalAdministratorsTx,
  notifyTaskMembersTx,
  notifyTerminationReviewResultTx,
  reviewSubmitterAndOwnersTx,
} from "@/lib/project-management/application/lifecycle-notifications";
import type { LifecyclePlanEntry } from "@/lib/project-management/application/lifecycle-records";
import { taskAuthorizationResource } from "@/lib/project-management/application/task-authorization-resource";
import { jsonValue } from "@/lib/project-management/application/prisma-json";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { lockGlobalApprovalAdministratorSetTx } from "@/lib/project-management/approval-administrators";
import {
  terminationOutcomeLabel,
  terminationReviewResultLabel,
} from "@/lib/project-management/notifications/user-facing-copy";
import { assertTaskApprovalAvailableTx } from "@/lib/project-management/task-approval-gate";
import {
  reviewTerminationDecisionInputSchema,
  submitTerminationReviewInputSchema,
} from "@/lib/project-management/validations/lifecycle";

export type TerminationReviewMutationResult = {
  taskId: string;
  reviewId: string;
  terminationNodeId: string;
  result: TerminationReviewResult;
  outcome: TerminationOutcome;
  taskStatus: TaskStatus;
  activeMilestoneNodeId: string | null;
  lockVersion: number;
};

export async function submitTerminationForReview(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<TerminationReviewMutationResult & { created: boolean }> {
  const parsed = submitTerminationReviewInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockGlobalApprovalAdministratorSetTx(tx);
    const terminationTaskId = await loadTerminationTaskIdTx(
      tx,
      parsed.terminationNodeId,
    );
    await lockTaskTx(tx, terminationTaskId);
    const termination = await loadTerminationForMutationTx(
      tx,
      parsed.terminationNodeId,
    );
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const task = await loadTaskForAuthorizationTx(tx, terminationTaskId);
    assertTaskVisible(refreshedActor, task);
    assertAuthorized({
      actor: refreshedActor,
      action: "termination.submit_review",
      resource: taskAuthorizationResource(task),
    });
    const existing = await tx.terminationReview.findUnique({
      where: {
        terminationNodeId_idempotencyKey: {
          terminationNodeId: termination.id,
          idempotencyKey: parsed.idempotencyKey,
        },
      },
      select: { id: true, result: true, outcome: true },
    });
    if (existing) {
      return {
        taskId: task.id,
        reviewId: existing.id,
        terminationNodeId: termination.nodeId,
        result: existing.result,
        outcome: existing.outcome,
        taskStatus: task.status,
        activeMilestoneNodeId: task.activeMilestoneNodeId,
        lockVersion: task.lockVersion,
        created: false,
      };
    }

    await assertTerminationRequestStateTx(
      tx,
      task,
      termination,
      parsed.outcome,
    );
    await assertTaskApprovalAvailableTx(tx, task.id);

    const review = await tx.terminationReview.create({
      data: {
        terminationNodeId: termination.id,
        outcome: parsed.outcome,
        reason: parsed.reason,
        summary: parsed.summary,
        result: "PENDING",
        submittedByAccountId: refreshedActor.accountId,
        idempotencyKey: parsed.idempotencyKey,
      },
      select: { id: true, result: true, outcome: true },
    });
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.termination.review.submit",
      entityType: "TerminationReview",
      entityId: review.id,
      taskId: task.id,
      after: jsonValue({
        terminationNodeId: termination.nodeId,
        terminalName: termination.name,
        outcome: review.outcome,
        result: review.result,
      }),
      reason: parsed.reason || "提交 Terminal 结束审批",
    });
    await notifyGlobalAdministratorsTx(tx, {
      actor: refreshedActor,
      task,
      kind: "termination_review_submitted",
      category: "REVIEW",
      eventKey: `pm:termination:review_submitted:${review.id}`,
      title: "任务结束申请待审批",
      summary: terminationSubmissionSummary({
        taskTitle: task.title,
        terminalName: termination.name,
        outcome: parsed.outcome,
        reason: parsed.reason,
        summary: parsed.summary,
      }),
      entityType: "TerminationReview",
      entityId: review.id,
      linkPath: `/progress/tasks/${task.id}?focus=${termination.nodeId}`,
      mandatory: true,
      context: {
        terminalName: termination.name,
        requestedOutcome: parsed.outcome,
        reason: parsed.reason,
        summary: parsed.summary,
      },
    });
    return {
      taskId: task.id,
      reviewId: review.id,
      terminationNodeId: termination.nodeId,
      result: review.result,
      outcome: review.outcome,
      taskStatus: task.status,
      activeMilestoneNodeId: task.activeMilestoneNodeId,
      lockVersion: task.lockVersion,
      created: true,
    };
  });
}

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

async function assertTerminationRequestStateTx(
  tx: Prisma.TransactionClient,
  task: Awaited<ReturnType<typeof loadTaskForAuthorizationTx>>,
  termination: Awaited<ReturnType<typeof loadTerminationForMutationTx>>,
  outcome: TerminationOutcome,
) {
  if (termination.outcome) {
    throw stateConflictError("该 Task 已结束");
  }
  if (task.status !== "ACTIVE") {
    throw stateConflictError("只有执行中的 Task 可以提交结束审批");
  }
  if (
    termination.node.status !== "PENDING" &&
    termination.node.status !== "ACTIVE"
  ) {
    throw stateConflictError("当前 Terminal 状态不能提交结束审批");
  }
  const currentPlan = await loadCurrentPlanEntriesTx(tx, task);
  assertLegacyCurrentPlanUsableAsRepairBase(currentPlan);
  const terminationEntryIndex = currentPlan.nodes.findIndex(
    (entry) => entry.nodeId === termination.nodeId,
  );
  if (terminationEntryIndex !== currentPlan.nodes.length - 1) {
    throw stateConflictError("结束节点必须是当前计划最后一个节点");
  }
  if (outcome === "SUCCESS") {
    const unfinishedMilestone = currentPlan.nodes.find(
      (entry) =>
        entry.node.type === "MILESTONE" && entry.node.status !== "COMPLETED",
    );
    if (unfinishedMilestone) {
      throw stateConflictError("成功结束前必须完成所有前置 Milestone");
    }
  }
  return currentPlan;
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

async function loadTerminationForMutationTx(
  tx: Prisma.TransactionClient,
  nodeId: string,
) {
  const termination = await tx.terminationNode.findUnique({
    where: { nodeId },
    include: { node: true },
  });
  if (!termination || termination.node.deletedAt) throw notFoundError();
  return termination;
}

async function loadTerminationTaskIdTx(
  tx: Prisma.TransactionClient,
  nodeId: string,
) {
  const termination = await tx.terminationNode.findUnique({
    where: { nodeId },
    select: { node: { select: { taskId: true, deletedAt: true } } },
  });
  if (!termination || termination.node.deletedAt) throw notFoundError();
  return termination.node.taskId;
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

function terminationSubmissionSummary(input: {
  taskTitle: string;
  terminalName: string;
  outcome: TerminationOutcome;
  reason: string;
  summary: string;
}) {
  const details = [
    `任务「${input.taskTitle}」的${terminationDisplayName(input.terminalName)}等待结束审批`,
    `拟定结果：${terminationOutcomeLabel(input.outcome)}`,
    input.reason ? `原因：${input.reason}` : null,
    input.summary ? `总结：${input.summary}` : null,
  ].filter((value): value is string => Boolean(value));
  return details.join("；");
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

function terminationDisplayName(name: string) {
  return name === "Terminal" ? "结束节点" : `结束节点「${name}」`;
}
