import type {
  Prisma,
  TaskStatus,
  TerminationOutcome,
  TerminationReviewResult,
} from "@prisma/client";
import {
  notFoundError,
  stateConflictError,
} from "@/lib/project-management/application/errors";
import {
  assertLegacyCurrentPlanUsableAsRepairBase,
  loadCurrentPlanEntriesTx,
  loadTaskForAuthorizationTx,
} from "@/lib/project-management/application/lifecycle-domain";

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

export async function assertTerminationRequestStateTx(
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

export async function loadTerminationForMutationTx(
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

export function terminationDisplayName(name: string) {
  return name === "Terminal" ? "结束节点" : `结束节点「${name}」`;
}
