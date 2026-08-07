import type {
  ProjectManagementSystemRole,
  UserRoleType,
} from "@prisma/client";

export type AdminAccountRow = {
  id: string;
  lastLoginAt: string | null;
  createdAt: string;
  person: { displayName: string; avatar: string | null } | null;
  identities: Array<{
    id: string;
    openId: string | null;
    unionId: string | null;
  }>;
  reimbursementUser: {
    openId: string;
    name: string;
    email: string | null;
  } | null;
  systemRoles: Array<{
    id: string;
    role: ProjectManagementSystemRole;
    team: string;
    techGroup: string;
    createdAt: string;
    revokedAt: string | null;
  }>;
  reimbursementRoles: Array<{
    id: string;
    role: UserRoleType;
    team: string;
    techGroup: string;
    createdAt: string;
    revokedAt: string | null;
  }>;
  securityAuditEvents: Array<{
    id: string;
    action: string;
    source: string;
    operatorName: string;
    createdAt: string;
  }>;
};

export type AdminAccountOption = {
  id: string;
  displayName: string;
  avatar: string | null;
  openId: string | null;
  email: string | null;
  reimbursementReady: boolean;
};

export type AdminResponsibilityAssignment = {
  id: string;
  role: Exclude<UserRoleType, "SUPER_ADMIN">;
  team: string;
  techGroup: string;
  account: {
    id: string;
    displayName: string;
    avatar: string | null;
    email: string | null;
  };
};
