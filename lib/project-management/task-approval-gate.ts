import type { Prisma } from "@prisma/client";
import { stateConflictError } from "@/lib/project-management/application/errors";

type ApprovalQueryClient = Pick<
  Prisma.TransactionClient,
  "milestoneReview" | "revisionNode" | "terminationReview"
>;

export type TaskPendingApproval =
  | {
      kind: "MILESTONE_REVIEW";
      id: string;
      title: string;
      submittedAt: string;
    }
  | {
      kind: "REVISION";
      id: string;
      title: string;
      submittedAt: string;
    }
  | {
      kind: "TERMINATION_REVIEW";
      id: string;
      title: string;
      submittedAt: string;
    };

export type TaskApprovalGate = {
  pendingApproval: TaskPendingApproval | null;
  pendingApprovalConflict: boolean;
};

export async function loadTaskApprovalGate(
  client: ApprovalQueryClient,
  taskId: string,
): Promise<TaskApprovalGate> {
  const [milestoneReviews, revisions, terminationReviews] = await Promise.all([
    client.milestoneReview.findMany({
      where: {
        result: "PENDING",
        revokedAt: null,
        milestoneNode: { node: { taskId } },
      },
      select: {
        id: true,
        createdAt: true,
        milestoneNode: { select: { goal: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 2,
    }),
    client.revisionNode.findMany({
      where: { status: "PENDING_APPROVAL", node: { taskId } },
      select: {
        id: true,
        reason: true,
        node: { select: { createdAt: true } },
        targetPlanVersion: { select: { updatedAt: true } },
      },
      orderBy: [{ node: { createdAt: "asc" } }, { id: "asc" }],
      take: 2,
    }),
    client.terminationReview.findMany({
      where: {
        result: "PENDING",
        terminationNode: { node: { taskId } },
      },
      select: {
        id: true,
        createdAt: true,
        terminationNode: { select: { name: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 2,
    }),
  ]);
  const approvals: TaskPendingApproval[] = [
    ...milestoneReviews.map((review) => ({
      kind: "MILESTONE_REVIEW" as const,
      id: review.id,
      title: review.milestoneNode.goal,
      submittedAt: review.createdAt.toISOString(),
    })),
    ...revisions.map((revision) => ({
      kind: "REVISION" as const,
      id: revision.id,
      title: revision.reason,
      submittedAt: (
        revision.targetPlanVersion?.updatedAt ?? revision.node.createdAt
      ).toISOString(),
    })),
    ...terminationReviews.map((review) => ({
      kind: "TERMINATION_REVIEW" as const,
      id: review.id,
      title: review.terminationNode.name,
      submittedAt: review.createdAt.toISOString(),
    })),
  ].sort(
    (left, right) =>
      left.submittedAt.localeCompare(right.submittedAt) ||
      left.id.localeCompare(right.id),
  );
  return {
    pendingApproval: approvals[0] ?? null,
    pendingApprovalConflict: approvals.length > 1,
  };
}

export async function assertTaskApprovalAvailableTx(
  tx: Prisma.TransactionClient,
  taskId: string,
) {
  const gate = await loadTaskApprovalGate(tx, taskId);
  if (gate.pendingApprovalConflict) {
    throw stateConflictError(
      "当前 Task 存在多条待审批记录，请联系管理员处理后再试",
    );
  }
  if (!gate.pendingApproval) return;
  throw stateConflictError(
    gate.pendingApproval.kind === "MILESTONE_REVIEW"
      ? "当前 Task 已有 Milestone 验收待审批，请先处理后再试"
      : gate.pendingApproval.kind === "REVISION"
        ? "当前 Task 已有 Revision 待审批，请先处理后再试"
        : "当前 Task 已有 Terminal 结束申请待审批，请先处理后再试",
  );
}
