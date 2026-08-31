import { prisma } from "@/lib/prisma";
import { notFoundError } from "@/lib/project-management/application/errors";
import {
  assertAuthorized,
  authorize,
  taskReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";

export type RevisionComposerRecord = {
  id: string;
  taskNodeId: string;
  taskId: string;
  reason: string;
  description: string;
  revisionAt: string;
  reviewRound: number;
  status: string;
  basePlanVersionId: string;
  baseTaskLockVersion: number;
  targetPlanVersionId: string | null;
  targetVersionNo: number | null;
  targetPlanUpdatedAt: string | null;
  canEdit: boolean;
};

export async function getOpenRevisionCandidate({
  actor,
  taskId,
}: {
  actor: ProjectManagementActor;
  taskId: string;
}) {
  const task = await prisma.task.findFirst({
    where: { AND: [{ id: taskId }, taskReadableWhere(actor)] },
    select: { id: true },
  });
  if (!task) throw notFoundError();
  return prisma.taskPlanVersion.findFirst({
    where: {
      taskId,
      status: "DRAFT",
      revisionNodeId: { not: null },
    },
    select: {
      id: true,
      revisionNodeId: true,
      revisionNode: { select: { status: true } },
    },
  });
}

export async function getRevisionComposerRecord({
  actor,
  taskId,
  revisionNodeId,
}: {
  actor: ProjectManagementActor;
  taskId: string;
  revisionNodeId: string;
}): Promise<RevisionComposerRecord> {
  const task = await prisma.task.findFirst({
    where: { AND: [{ id: taskId }, taskReadableWhere(actor)] },
    select: {
      id: true,
      team: true,
      techGroup: true,
      status: true,
      priority: true,
      members: {
        where: { removedAt: null },
        select: { personId: true, role: true, removedAt: true },
      },
    },
  });
  if (!task) throw notFoundError();
  const revision = await prisma.revisionNode.findFirst({
    where: { id: revisionNodeId, node: { taskId } },
    select: {
      id: true,
      reason: true,
      revisionAt: true,
      reviewRound: true,
      status: true,
      basePlanVersionId: true,
      baseTaskLockVersion: true,
      node: {
        select: { id: true, businessDescription: true, createdByAccountId: true },
      },
      targetPlanVersion: {
        select: { id: true, versionNo: true, updatedAt: true },
      },
    },
  });
  if (!revision) throw notFoundError();
  const resource: AuthorizationTaskResource = { type: "task", ...task };
  assertAuthorized({ actor, action: "task.view", resource });
  const canCreateRevision = authorize({
    actor,
    action: "revision.create",
    resource,
  }).allowed;
  const canManageMembers = authorize({
    actor,
    action: "task.manage_members",
    resource,
  }).allowed;
  return {
    id: revision.id,
    taskNodeId: revision.node.id,
    taskId,
    reason: revision.reason,
    description: revision.node.businessDescription,
    revisionAt: revision.revisionAt.toISOString(),
    reviewRound: revision.reviewRound,
    status: revision.status,
    basePlanVersionId: revision.basePlanVersionId,
    baseTaskLockVersion: revision.baseTaskLockVersion,
    targetPlanVersionId: revision.targetPlanVersion?.id ?? null,
    targetVersionNo: revision.targetPlanVersion?.versionNo ?? null,
    targetPlanUpdatedAt:
      revision.targetPlanVersion?.updatedAt.toISOString() ?? null,
    canEdit:
      revision.status === "REJECTED" &&
      ((revision.node.createdByAccountId === actor.accountId &&
        canCreateRevision) ||
        canManageMembers),
  };
}
