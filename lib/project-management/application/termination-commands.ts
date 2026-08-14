import type { Prisma, TaskStatus, TerminationOutcome } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertAuthorized } from "@/lib/project-management/authorization";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import {
  notFoundError,
  staleTaskError,
  stateConflictError,
  validationError,
} from "@/lib/project-management/application/errors";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import {
  assertLegacyCurrentPlanUsableAsRepairBase,
  assertTaskVisible,
  loadCurrentPlanEntriesTx,
  loadTaskForAuthorizationTx,
  lockTaskTx,
} from "@/lib/project-management/application/lifecycle-domain";
import { notifyTaskMembersTx } from "@/lib/project-management/application/lifecycle-notifications";
import { taskAuthorizationResource } from "@/lib/project-management/application/task-authorization-resource";
import { terminationOutcomeLabel } from "@/lib/project-management/notifications/user-facing-copy";
import { assertTaskApprovalAvailableTx } from "@/lib/project-management/task-approval-gate";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { confirmTerminationInputSchema } from "@/lib/project-management/validations/lifecycle";

type LifecycleTaskResult = {
  taskId: string;
  currentPlanVersionId: string;
  status: TaskStatus;
  lockVersion: number;
  activeMilestoneNodeId: string | null;
};

export async function confirmTermination(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<LifecycleTaskResult & { outcome: TerminationOutcome }> {
  const parsed = confirmTerminationInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockTaskTx(tx, parsed.taskId);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const task = await loadTaskForAuthorizationTx(tx, parsed.taskId);
    assertTaskVisible(refreshedActor, task);
    assertAuthorized({
      actor: refreshedActor,
      action: "task.terminate",
      resource: taskAuthorizationResource(task),
    });
    const termination = await loadTerminationWithNodeTx(
      tx,
      parsed.terminationNodeId,
    );
    if (termination.node.taskId !== task.id) {
      throw validationError("结束节点不属于该 Task");
    }
    if (termination.outcome) {
      if (termination.outcome === parsed.outcome) {
        return {
          taskId: task.id,
          currentPlanVersionId: task.currentPlanVersionId,
          status: outcomeToTaskStatus(termination.outcome),
          lockVersion: task.lockVersion,
          activeMilestoneNodeId: task.activeMilestoneNodeId,
          outcome: termination.outcome,
        };
      }
      throw stateConflictError("该 Task 已使用其他结果结束");
    }
    if (task.status !== "ACTIVE") {
      throw stateConflictError("只有执行中的 Task 可以确认结束");
    }
    if (task.lockVersion !== parsed.expectedLockVersion) {
      throw staleTaskError(task);
    }
    await assertTaskApprovalAvailableTx(tx, task.id);
    const currentPlan = await loadCurrentPlanEntriesTx(tx, task);
    assertLegacyCurrentPlanUsableAsRepairBase(currentPlan);
    const terminationEntryIndex = currentPlan.nodes.findIndex(
      (entry) => entry.nodeId === termination.nodeId,
    );
    if (terminationEntryIndex !== currentPlan.nodes.length - 1) {
      throw stateConflictError("结束节点必须是当前计划最后一个节点");
    }
    if (parsed.outcome === "SUCCESS") {
      const unfinishedMilestone = currentPlan.nodes.find(
        (entry) =>
          entry.node.type === "MILESTONE" &&
          entry.node.status !== "COMPLETED",
      );
      if (unfinishedMilestone) {
        throw stateConflictError("成功结束前必须完成所有前置 Milestone");
      }
    }

    const now = new Date();
    await tx.terminationNode.update({
      where: { id: termination.id },
      data: {
        outcome: parsed.outcome,
        reason: parsed.reason,
        summary: parsed.summary,
        confirmedByAccountId: refreshedActor.accountId,
        confirmedAt: now,
      },
    });
    await tx.taskNode.update({
      where: { id: termination.nodeId },
      data: { status: "COMPLETED" },
    });
    const unfinishedNodeIds = currentPlan.nodes
      .filter(
        (entry) =>
          entry.nodeId !== termination.nodeId &&
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
      where: { id: task.id },
      data: {
        status: outcomeToTaskStatus(parsed.outcome),
        activeMilestoneNodeId: null,
        endedAt: now,
        lockVersion: { increment: 1 },
      },
      select: {
        status: true,
        currentPlanVersionId: true,
        activeMilestoneNodeId: true,
        lockVersion: true,
      },
    });
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.termination.confirm",
      entityType: "TerminationNode",
      entityId: termination.id,
      taskId: task.id,
      before: jsonValue({
        taskStatus: task.status,
        lockVersion: task.lockVersion,
        outcome: termination.outcome,
        name: termination.name,
      }),
      after: jsonValue({
        taskStatus: updated.status,
        lockVersion: updated.lockVersion,
        outcome: parsed.outcome,
        name: termination.name,
        cancelledNodeCount: unfinishedNodeIds.length,
      }),
      reason: parsed.reason,
    });
    await notifyTaskMembersTx(tx, {
      actor: refreshedActor,
      task,
      kind: "task_terminated",
      category: "TASK",
      eventKey: `pm:task:terminated:${termination.nodeId}`,
      title: "任务已结束",
      summary: `任务「${task.title}」已结束（${termination.name === "Terminal" ? "结束节点" : termination.name}）：${terminationOutcomeLabel(parsed.outcome)}`,
      entityType: "TerminationNode",
      entityId: termination.id,
      mandatory: true,
    });
    return {
      taskId: task.id,
      currentPlanVersionId: updated.currentPlanVersionId,
      status: updated.status,
      lockVersion: updated.lockVersion,
      activeMilestoneNodeId: updated.activeMilestoneNodeId,
      outcome: parsed.outcome,
    };
  });
}

async function loadTerminationWithNodeTx(
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

function outcomeToTaskStatus(outcome: TerminationOutcome): TaskStatus {
  if (outcome === "SUCCESS") return "COMPLETED";
  if (outcome === "FAILED") return "FAILED";
  if (outcome === "CANCELLED") return "CANCELLED";
  return "TIMEOUT";
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
