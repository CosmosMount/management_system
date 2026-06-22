import type { UserRoleType } from "@prisma/client";
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
  return roles.some((r) => r.role === "TEAM_ADMIN" && r.team === team);
}

export function isTechGroupLead(
  roles: UserRoleRecord[],
  techGroup: string,
): boolean {
  return roles.some(
    (r) => r.role === "TECH_GROUP_ADMIN" && r.techGroup === techGroup,
  );
}

export function isAssignee(
  userOpenId: string | undefined,
  assigneeOpenId: string,
): boolean {
  return !!userOpenId && userOpenId === assigneeOpenId;
}

export function canManageProject(
  roles: UserRoleRecord[],
  scope: ProgressScope,
  ownerOpenId: string,
  userOpenId?: string,
): boolean {
  if (isProgressSuperAdmin(roles)) return true;
  if (isProjectManager(roles)) return true;
  if (userOpenId && userOpenId === ownerOpenId) return true;
  if (isTeamLead(roles, scope.team)) return true;
  if (isTechGroupLead(roles, scope.techGroup)) return true;
  return false;
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
  assigneeOpenId: string,
): boolean {
  return isAssignee(userOpenId, assigneeOpenId);
}

export function canSubmitWeeklyReport(
  userOpenId: string | undefined,
  assigneeOpenId: string,
): boolean {
  return isAssignee(userOpenId, assigneeOpenId);
}
