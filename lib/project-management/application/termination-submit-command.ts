import type { Prisma, TerminationOutcome } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertAuthorized } from "@/lib/project-management/authorization";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import { notFoundError } from "@/lib/project-management/application/errors";
import {
  assertTaskVisible,
  loadTaskForAuthorizationTx,
  lockTaskTx,
} from "@/lib/project-management/application/lifecycle-domain";
import { notifyGlobalAdministratorsTx } from "@/lib/project-management/application/lifecycle-notifications";
import { jsonValue } from "@/lib/project-management/application/prisma-json";
import { taskAuthorizationResource } from "@/lib/project-management/application/task-authorization-resource";
import {
  assertTerminationRequestStateTx,
  loadTerminationForMutationTx,
  terminationDisplayName,
  type TerminationReviewMutationResult,
} from "@/lib/project-management/application/termination-command-support";
import { lockGlobalApprovalAdministratorSetTx } from "@/lib/project-management/approval-administrators";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { terminationOutcomeLabel } from "@/lib/project-management/notifications/user-facing-copy";
import { assertTaskApprovalAvailableTx } from "@/lib/project-management/task-approval-gate";
import { submitTerminationReviewInputSchema } from "@/lib/project-management/validations/lifecycle";

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
