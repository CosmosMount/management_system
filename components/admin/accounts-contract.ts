import type {
  AdminAccountOption,
  AdminAccountRow,
  AdminResponsibilityAssignment,
} from "@/components/admin/account-types";

export const activeProjectRoles = new Set([
  "SUPER_ADMINISTRATOR",
  "PROJECT_ADMINISTRATOR",
]);

export const projectRoleLabels: Record<string, string> = {
  SUPER_ADMINISTRATOR: "超级管理员",
  PROJECT_ADMINISTRATOR: "项目管理员",
  SYSTEM_ADMINISTRATOR: "旧系统管理员",
  TEAM_ADMINISTRATOR: "旧范围管理员",
  RESOURCE_MANAGER: "旧资源管理员",
  AUDITOR: "旧审计员",
  GROUP_LEADER: "旧组长",
};

export const reimbursementRoleLabels: Record<string, string> = {
  TEAM_ADMIN: "报销车组组长",
  TECH_GROUP_ADMIN: "报销技术组组长",
  TEACHER: "指导老师",
  FINANCE: "报销员",
  SUPER_ADMIN: "旧超级管理员",
};

export type ProjectRole =
  | "SUPER_ADMINISTRATOR"
  | "PROJECT_ADMINISTRATOR";
export type ReimbursementRole =
  | "TEAM_ADMIN"
  | "TECH_GROUP_ADMIN"
  | "TEACHER"
  | "FINANCE";
export type AssignableRole = ProjectRole | ReimbursementRole;

export type AccountFiltersValue = {
  query: string;
  role: string;
  team: string;
  techGroup: string;
};

export type MutationResult = {
  changed?: boolean;
  assignmentId?: string;
};

export type RunOptions = {
  success: string;
  unchanged?: string;
  afterSuccess?: (result: MutationResult) => void;
};

export type RunAccountMutation = (
  action: () => Promise<MutationResult | void>,
  options: RunOptions,
) => void;

export function isProjectRole(role: AssignableRole): role is ProjectRole {
  return role === "SUPER_ADMINISTRATOR" || role === "PROJECT_ADMINISTRATOR";
}

export function roleLabel(role: string) {
  return projectRoleLabels[role] ?? reimbursementRoleLabels[role] ?? "";
}

export function accountDisplayName(account: AdminAccountRow) {
  return account.person?.displayName || account.reimbursementUser?.name || "未知用户";
}

export function systemRoleLabel(assignment: {
  role: string;
  team: string;
  techGroup: string;
}) {
  const scope = assignment.team || assignment.techGroup;
  return `${projectRoleLabels[assignment.role] ?? assignment.role}${scope ? ` · ${scope}` : ""}`;
}

export function reimbursementRoleLabel(assignment: {
  role: string;
  team: string;
  techGroup: string;
}) {
  const scope = assignment.team || assignment.techGroup;
  return `${reimbursementRoleLabels[assignment.role] ?? assignment.role}${scope ? ` · ${scope}` : ""}`;
}

export function responsibilityFromOption({
  assignmentId,
  role,
  scope,
  scopeKind,
  account,
}: {
  assignmentId: string;
  role: ReimbursementRole;
  scope: string;
  scopeKind: "team" | "techGroup";
  account: AdminAccountOption;
}): AdminResponsibilityAssignment {
  return {
    id: assignmentId,
    role,
    team: scopeKind === "team" ? scope : "",
    techGroup: scopeKind === "techGroup" ? scope : "",
    account: {
      id: account.id,
      displayName: account.displayName,
      avatar: account.avatar,
      email: account.email,
    },
  };
}

export function pageHref(filters: AccountFiltersValue, page: number) {
  const params = new URLSearchParams();
  if (filters.query) params.set("q", filters.query);
  if (filters.role) params.set("role", filters.role);
  if (filters.team) params.set("team", filters.team);
  if (filters.techGroup) params.set("techGroup", filters.techGroup);
  params.set("page", String(page));
  return `/admin/accounts?${params.toString()}`;
}
