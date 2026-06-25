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
  if (canManageProject(roles, scope, projectOwnerOpenIds, userOpenId)) {
    return true;
  }
  if (isAssignee(userOpenId, stageOwnerOpenIds)) return true;
  if (isAssignee(userOpenId, taskAssigneeOpenIds)) return true;
  return false;
}

export function canViewTask(
  roles: UserRoleRecord[],
  scope: ProgressScope,
  projectOwnerOpenIds: string | string[],
  taskAssigneeOpenIds: string | string[],
  userOpenId?: string,
  stageOwnerOpenId?: string | null,
): boolean {
  if (canManageProject(roles, scope, projectOwnerOpenIds, userOpenId)) {
    return true;
  }
  if (isAssignee(userOpenId, taskAssigneeOpenIds)) return true;
  if (stageOwnerOpenId && userOpenId === stageOwnerOpenId) return true;
  return false;
}

export function progressProjectReadableWhere(
  roles: UserRoleRecord[],
  userOpenId?: string,
): Prisma.ProjectWhereInput {
  if (isProgressSuperAdmin(roles) || isProjectManager(roles)) return {};

  const teamScopes = roles
    .filter((role) => role.role === "TEAM_ADMIN" && role.team)
    .map((role) => role.team);
  const techScopes = roles
    .filter((role) => role.role === "TECH_GROUP_ADMIN" && role.techGroup)
    .map((role) => role.techGroup);
  const OR: Prisma.ProjectWhereInput[] = [];
  if (teamScopes.length > 0) OR.push({ team: { in: teamScopes } });
  if (techScopes.length > 0) OR.push({ techGroup: { in: techScopes } });
  if (userOpenId) {
    OR.push(
      { ownerOpenId: userOpenId },
      { owners: { some: { openId: userOpenId } } },
      { stages: { some: { ownerOpenId: userOpenId } } },
      {
        tasks: {
          some: {
            deletedAt: null,
            assignees: { some: { openId: userOpenId } },
          },
        },
      },
      { tasks: { some: { deletedAt: null, assigneeOpenId: userOpenId } } },
    );
  }

  return OR.length > 0 ? { OR } : { id: "__none__" };
}

export function progressTaskReadableWhere(
  roles: UserRoleRecord[],
  userOpenId?: string,
): Prisma.TaskWhereInput {
  const notDeleted: Prisma.TaskWhereInput = { deletedAt: null };
  if (isProgressSuperAdmin(roles) || isProjectManager(roles)) return notDeleted;

  const teamScopes = roles
    .filter((role) => role.role === "TEAM_ADMIN" && role.team)
    .map((role) => role.team);
  const techScopes = roles
    .filter((role) => role.role === "TECH_GROUP_ADMIN" && role.techGroup)
    .map((role) => role.techGroup);
  const OR: Prisma.TaskWhereInput[] = [];
  if (teamScopes.length > 0) OR.push({ team: { in: teamScopes } });
  if (techScopes.length > 0) OR.push({ techGroup: { in: techScopes } });
  if (userOpenId) {
    OR.push(
      { assigneeOpenId: userOpenId },
      { assignees: { some: { openId: userOpenId } } },
      { project: { ownerOpenId: userOpenId } },
      { project: { owners: { some: { openId: userOpenId } } } },
      { stage: { ownerOpenId: userOpenId } },
    );
  }

  return OR.length > 0 ? { AND: [notDeleted, { OR }] } : { id: "__none__" };
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
