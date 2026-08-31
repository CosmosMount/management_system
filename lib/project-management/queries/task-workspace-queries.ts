import { prisma } from "@/lib/prisma";
import {
  authorize,
  taskReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import { notFoundError } from "@/lib/project-management/application/errors";
import { inspectRevisionTargetStructure } from "@/lib/project-management/domain/revision-target-structure";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  planVersionInclude,
  serializePlanVersion,
  taskResource,
  toIso,
  type PlanVersionWithNodes,
} from "@/lib/project-management/queries/task-plan-queries";
import type {
  PendingRevisionPlanComparison,
  TaskWorkspace,
} from "@/lib/project-management/queries/task-query-types";
import { loadTaskApprovalGate } from "@/lib/project-management/task-approval-gate";

export async function getTaskWorkspace({
  actor,
  taskId,
}: {
  actor: ProjectManagementActor;
  taskId: string;
}): Promise<TaskWorkspace> {
  const task = await prisma.task.findFirst({
    where: { AND: [{ id: taskId }, taskReadableWhere(actor)] },
    include: {
      project: { select: { id: true, name: true, avatarPath: true } },
      members: {
        where: { removedAt: null },
        include: { person: { select: { displayName: true } } },
        orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      },
      currentPlanVersion: {
        include: planVersionInclude,
      },
    },
  });
  if (!task) throw notFoundError();

  const approvalGate = await loadTaskApprovalGate(prisma, task.id);
  const pendingRevisionPlanComparison =
    !approvalGate.pendingApprovalConflict &&
    approvalGate.pendingApproval?.kind === "REVISION"
      ? await loadPendingRevisionPlanComparison({
          taskId: task.id,
          currentPlanVersionId: task.currentPlanVersionId,
          currentPlan: task.currentPlanVersion,
          lockVersion: task.lockVersion,
          revisionNodeId: approvalGate.pendingApproval.id,
        })
      : null;

  const resource = taskResource({
    team: task.team,
    techGroup: task.techGroup,
    status: task.status,
    priority: task.priority,
    createdByAccountId: task.createdByAccountId,
    members: task.members,
  });

  return {
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      team: task.team,
      techGroup: task.techGroup,
      status: task.status,
      priority: task.priority,
    relatedTaskId: task.relatedTaskId,
    projectId: task.projectId,
    project: task.project,
      currentPlanVersionId: task.currentPlanVersionId,
      activeMilestoneNodeId: task.activeMilestoneNodeId,
      lockVersion: task.lockVersion,
      startedAt: toIso(task.startedAt),
      endedAt: toIso(task.endedAt),
      archivedAt: toIso(task.archivedAt),
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    },
    members: task.members.map((member) => ({
      personId: member.personId,
      role: member.role,
      displayName: member.person.displayName,
    })),
    currentPlan: serializePlanVersion(task.currentPlanVersion),
    pendingApproval: approvalGate.pendingApproval,
    pendingApprovalConflict: approvalGate.pendingApprovalConflict,
    pendingRevisionPlanComparison,
    permissions: {
      canUpdateMetadata: allowed(actor, "task.update_metadata", resource),
      canManageMembers: allowed(actor, "task.manage_members", resource),
      canActivate: allowed(actor, "task.activate", resource),
      canDeleteDraft: allowed(actor, "task.delete", resource),
      canCreateRevision: allowed(actor, "revision.create", resource),
      canSubmitMilestoneReview: allowed(
        actor,
        "milestone.submit_review",
        resource,
      ),
      canReviewMilestone: allowed(actor, "milestone.review", resource),
      canSubmitTerminationReview: allowed(
        actor,
        "termination.submit_review",
        resource,
      ),
      canReviewTermination: allowed(actor, "termination.review", resource),
      canViewHistory: allowed(actor, "plan.view_history", resource),
    },
  };
}

async function loadPendingRevisionPlanComparison({
  taskId,
  currentPlanVersionId,
  currentPlan,
  lockVersion,
  revisionNodeId,
}: {
  taskId: string;
  currentPlanVersionId: string;
  currentPlan: PlanVersionWithNodes;
  lockVersion: number;
  revisionNodeId: string;
}): Promise<PendingRevisionPlanComparison> {
  const unavailable = (message: string): PendingRevisionPlanComparison => ({
    status: "UNAVAILABLE",
    revisionNodeId,
    message,
  });
  const revision = await prisma.revisionNode.findFirst({
    where: {
      id: revisionNodeId,
      status: "PENDING_APPROVAL",
      node: { taskId, deletedAt: null },
    },
    select: {
      id: true,
      nodeId: true,
      reason: true,
      revisionAt: true,
      basePlanVersionId: true,
      baseTaskLockVersion: true,
      targetPlanVersion: { include: planVersionInclude },
    },
  });
  if (!revision) {
    return unavailable("待审批 Revision 已变化，无法安全展示修改后计划。");
  }
  if (
    revision.basePlanVersionId !== currentPlanVersionId ||
    revision.baseTaskLockVersion !== lockVersion
  ) {
    return unavailable("待审批 Revision 的基线已失效，无法安全展示修改后计划。");
  }

  const targetPlan = revision.targetPlanVersion;
  if (!targetPlan) {
    return unavailable("待审批 Revision 缺少修改后的候选计划。");
  }
  if (
    targetPlan.taskId !== taskId ||
    targetPlan.status !== "DRAFT" ||
    targetPlan.baseVersionId !== revision.basePlanVersionId ||
    targetPlan.revisionNodeId !== revision.id ||
    targetPlan.nodes.some(
      (entry) => entry.node.taskId !== taskId || entry.node.deletedAt !== null,
    )
  ) {
    return unavailable("待审批 Revision 的候选计划关联异常，无法安全展示修改后计划。");
  }

  const serializedTargetPlan = serializePlanVersion(targetPlan);
  if (
    serializedTargetPlan.chronologyCompatibilityIssues.length > 0 ||
    inspectRevisionTargetStructure({
      basePlan: currentPlan,
      targetPlan,
      targetPlanVersionId: targetPlan.id,
      revisionId: revision.id,
      revisionTaskNodeId: revision.nodeId,
    }).length > 0
  ) {
    return unavailable("待审批 Revision 的候选计划结构异常，无法安全展示修改后计划。");
  }

  return {
    status: "READY",
    revisionNodeId: revision.id,
    revisionReason: revision.reason,
    revisionAt: revision.revisionAt.toISOString(),
    plan: serializedTargetPlan,
  };
}

function allowed(
  actor: ProjectManagementActor,
  action: Parameters<typeof authorize>[0]["action"],
  resource: AuthorizationTaskResource,
): boolean {
  return authorize({ actor, action, resource }).allowed;
}
