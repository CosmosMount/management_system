import type { Prisma, UserRoleType } from "@prisma/client";
import type { UserRoleRecord } from "@/lib/permissions-client";

export type ProgressScope = {
  team: string;
  techGroup: string;
};

export function isProgressSuperAdmin(roles: UserRoleRecord[]): boolean {
  return roles.some((r) => r.role === "SUPER_ADMIN");
}

export function isProjectManager(roles: UserRoleRecord[]): boolean {
  return roles.some((r) => r.role === "PROJECT_MANAGER");
}

export function isTeamLead(roles: UserRoleRecord[], team: string): boolean {
  if (!team) return false;
  return roles.some((r) => r.role === "TEAM_ADMIN" && r.team === team);
}

export function isTechGroupLead(
  roles: UserRoleRecord[],
  techGroup: string,
): boolean {
  if (!techGroup) return false;
  return roles.some(
    (r) => r.role === "TECH_GROUP_ADMIN" && r.techGroup === techGroup,
  );
}

export function isAssignee(
  userOpenId: string | undefined,
  assigneeOpenIds: string | string[],
): boolean {
  if (!userOpenId) return false;
  const openIds = Array.isArray(assigneeOpenIds)
    ? assigneeOpenIds
    : [assigneeOpenIds];
  return openIds.includes(userOpenId);
}

export function canManageProject(
  roles: UserRoleRecord[],
  scope: ProgressScope,
  ownerOpenIds: string | string[],
  userOpenId?: string,
): boolean {
  if (isProgressSuperAdmin(roles)) return true;
  if (isProjectManager(roles)) return true;
  if (isAssignee(userOpenId, ownerOpenIds)) return true;
  if (isTeamLead(roles, scope.team)) return true;
  if (isTechGroupLead(roles, scope.techGroup)) return true;
  return false;
}

export function canViewProject(
  roles: UserRoleRecord[],
  scope: ProgressScope,
  projectOwnerOpenIds: string | string[],
  stageOwnerOpenIds: string | string[],
  taskAssigneeOpenIds: string | string[],
  userOpenId?: string,
): boolean {
  void roles;
  void scope;
  void projectOwnerOpenIds;
  void stageOwnerOpenIds;
  void taskAssigneeOpenIds;
  return !!userOpenId;
}

export function canViewTask(
  roles: UserRoleRecord[],
  scope: ProgressScope,
  projectOwnerOpenIds: string | string[],
  taskAssigneeOpenIds: string | string[],
  userOpenId?: string,
  stageOwnerOpenId?: string | null,
): boolean {
  void roles;
  void scope;
  void projectOwnerOpenIds;
  void taskAssigneeOpenIds;
  void stageOwnerOpenId;
  return !!userOpenId;
}

export function progressProjectReadableWhere(
  roles: UserRoleRecord[],
  userOpenId?: string,
): Prisma.ProjectWhereInput {
  void roles;
  return userOpenId ? {} : { id: "__none__" };
}

export function progressTaskReadableWhere(
  roles: UserRoleRecord[],
  userOpenId?: string,
): Prisma.TaskWhereInput {
  void roles;
  return userOpenId ? { deletedAt: null } : { id: "__none__" };
}

export function progressProjectMineWhere(userOpenId?: string): Prisma.ProjectWhereInput {
  if (!userOpenId) return { id: "__none__" };
  return {
    OR: [
      { ownerOpenId: userOpenId },
      { owners: { some: { openId: userOpenId } } },
      { participants: { some: { openId: userOpenId } } },
      { stages: { some: { ownerOpenId: userOpenId } } },
      {
        tasks: {
          some: {
            deletedAt: null,
            OR: [
              { assigneeOpenId: userOpenId },
              { assignees: { some: { openId: userOpenId } } },
              { deletionRequests: { some: { requesterOpenId: userOpenId } } },
            ],
          },
        },
      },
      { taskCreationRequests: { some: { requesterOpenId: userOpenId } } },
    ],
  };
}

export function progressTaskMineWhere(userOpenId?: string): Prisma.TaskWhereInput {
  if (!userOpenId) return { id: "__none__" };
  return {
    deletedAt: null,
    OR: [
      { assigneeOpenId: userOpenId },
      { assignees: { some: { openId: userOpenId } } },
      { stage: { ownerOpenId: userOpenId } },
      { deletionRequests: { some: { requesterOpenId: userOpenId } } },
      { project: { ownerOpenId: userOpenId } },
      { project: { owners: { some: { openId: userOpenId } } } },
      { creationRequests: { some: { requesterOpenId: userOpenId } } },
    ],
  };
}

export function canOperateProject(
  roles: UserRoleRecord[],
  scope: ProgressScope,
  ownerOpenIds: string | string[],
  participantOpenIds: string | string[],
  userOpenId?: string,
): boolean {
  if (canManageProject(roles, scope, ownerOpenIds, userOpenId)) return true;
  return isAssignee(userOpenId, participantOpenIds);
}

export function canRequestTaskCreation({
  roles,
  scope,
  ownerOpenIds,
  participantOpenIds,
  stageOwnerOpenIds,
  taskAssigneeOpenIds,
  userOpenId,
}: {
  roles: UserRoleRecord[];
  scope: ProgressScope;
  ownerOpenIds: string | string[];
  participantOpenIds: string | string[];
  stageOwnerOpenIds: string | string[];
  taskAssigneeOpenIds: string | string[];
  userOpenId?: string;
}): boolean {
  if (!userOpenId) return false;
  if (canManageProject(roles, scope, ownerOpenIds, userOpenId)) return true;
  if (isAssignee(userOpenId, participantOpenIds)) return true;
  if (isAssignee(userOpenId, stageOwnerOpenIds)) return true;
  if (isAssignee(userOpenId, taskAssigneeOpenIds)) return true;
  return false;
}

export function canRequestTaskDeletion({
  roles,
  scope,
  ownerOpenIds,
  participantOpenIds,
  stageOwnerOpenId,
  taskAssigneeOpenIds,
  userOpenId,
}: {
  roles: UserRoleRecord[];
  scope: ProgressScope;
  ownerOpenIds: string | string[];
  participantOpenIds: string | string[];
  stageOwnerOpenId?: string | null;
  taskAssigneeOpenIds: string | string[];
  userOpenId?: string;
}): boolean {
  if (!userOpenId) return false;
  if (canManageProject(roles, scope, ownerOpenIds, userOpenId)) return true;
  if (isAssignee(userOpenId, participantOpenIds)) return true;
  if (stageOwnerOpenId && userOpenId === stageOwnerOpenId) return true;
  if (isAssignee(userOpenId, taskAssigneeOpenIds)) return true;
  return false;
}

export function canUpdateProjectLifecycle(
  roles: UserRoleRecord[],
  scope: ProgressScope,
  ownerOpenIds: string | string[],
  userOpenId?: string,
): boolean {
  return canManageProject(roles, scope, ownerOpenIds, userOpenId);
}

export function canCreateProject(roles: UserRoleRecord[]): boolean {
  return (
    isProgressSuperAdmin(roles) ||
    isProjectManager(roles) ||
    roles.some(
      (r) => r.role === "TEAM_ADMIN" || r.role === "TECH_GROUP_ADMIN",
    )
  );
}

export function canCreateProjectInScope(
  roles: UserRoleRecord[],
  scope: ProgressScope,
): boolean {
  if (!canCreateProject(roles)) return false;
  if (isProgressSuperAdmin(roles) || isProjectManager(roles)) return true;
  if (scope.team && !isTeamLead(roles, scope.team)) return false;
  if (scope.techGroup && !isTechGroupLead(roles, scope.techGroup)) return false;
  return !!scope.team || !!scope.techGroup;
}

export function canChangeProjectScope(
  roles: UserRoleRecord[],
  nextScope: ProgressScope,
): boolean {
  return canCreateProjectInScope(roles, nextScope);
}

export function canApproveTask(
  roles: UserRoleRecord[],
  scope: ProgressScope,
): boolean {
  if (isProgressSuperAdmin(roles)) return true;
  if (isProjectManager(roles)) return true;
  if (isTeamLead(roles, scope.team)) return true;
  if (isTechGroupLead(roles, scope.techGroup)) return true;
  return false;
}

export function canSubmitStage(
  roles: UserRoleRecord[],
  stageOwnerOpenId: string,
  userOpenId?: string,
): boolean {
  if (isProgressSuperAdmin(roles)) return true;
  return !!userOpenId && userOpenId === stageOwnerOpenId;
}

export function canApproveStage(
  roles: UserRoleRecord[],
  scope: ProgressScope,
  projectOwnerOpenIds: string | string[],
  submitterOpenId: string,
  allowOwnerSelfApproval: boolean,
  userOpenId?: string,
): boolean {
  if (!userOpenId) return false;
  if (userOpenId === submitterOpenId) {
    return (
      allowOwnerSelfApproval &&
      isAssignee(userOpenId, projectOwnerOpenIds) &&
      isAssignee(submitterOpenId, projectOwnerOpenIds)
    );
  }
  if (isAssignee(userOpenId, projectOwnerOpenIds)) return true;
  if (isProgressSuperAdmin(roles)) return true;
  if (isProjectManager(roles)) return true;
  if (isTeamLead(roles, scope.team)) return true;
  if (isTechGroupLead(roles, scope.techGroup)) return true;
  return false;
}

export function getApproverRole(
  roles: UserRoleRecord[],
  scope: ProgressScope,
): UserRoleType | null {
  if (isProgressSuperAdmin(roles)) return "SUPER_ADMIN";
  if (isProjectManager(roles)) return "PROJECT_MANAGER";
  if (isTeamLead(roles, scope.team)) return "TEAM_ADMIN";
  if (isTechGroupLead(roles, scope.techGroup)) return "TECH_GROUP_ADMIN";
  return null;
}

export function canSubmitDelivery(
  userOpenId: string | undefined,
  assigneeOpenIds: string | string[],
): boolean {
  return isAssignee(userOpenId, assigneeOpenIds);
}

export function canSubmitWeeklyReport(
  userOpenId: string | undefined,
  assigneeOpenIds: string | string[],
): boolean {
  return isAssignee(userOpenId, assigneeOpenIds);
}
