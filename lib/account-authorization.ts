import type {
  AccountStatus,
  ProjectManagementSystemRole,
  UserRoleType,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";

const FEISHU_PROVIDER = "FEISHU" as const;
const DEFAULT_TENANT_ID = "default";

export type AccountProjectRoleRecord = {
  id: string;
  role: ProjectManagementSystemRole;
  team: string;
  techGroup: string;
};

export type AccountReimbursementRoleRecord = {
  id: string;
  role: UserRoleType;
  team: string;
  techGroup: string;
};

export type AccountAuthorizationContext = {
  accountId: string;
  isSuperAdministrator: boolean;
  projectAccessStatus: AccountStatus;
  projectRoles: AccountProjectRoleRecord[];
  reimbursementRoles: AccountReimbursementRoleRecord[];
};

export async function getAccountAuthorizationContextForOpenId(
  openId: string,
): Promise<AccountAuthorizationContext | null> {
  const identity = await prisma.accountIdentity.findFirst({
    where: {
      provider: FEISHU_PROVIDER,
      tenantId: DEFAULT_TENANT_ID,
      openId,
    },
    select: {
      account: {
        select: {
          id: true,
          projectAccessStatus: true,
          systemRoles: {
            where: { revokedAt: null },
            select: { id: true, role: true, team: true, techGroup: true },
          },
          reimbursementRoles: {
            where: { revokedAt: null, role: { not: "SUPER_ADMIN" } },
            select: { id: true, role: true, team: true, techGroup: true },
          },
        },
      },
    },
  });
  if (!identity) return null;

  const projectRoles = identity.account.systemRoles;
  return {
    accountId: identity.account.id,
    projectAccessStatus: identity.account.projectAccessStatus,
    isSuperAdministrator: projectRoles.some(
      (assignment) =>
        assignment.role === "SUPER_ADMINISTRATOR" &&
        assignment.team === "" &&
        assignment.techGroup === "",
    ),
    projectRoles,
    reimbursementRoles: identity.account.reimbursementRoles,
  };
}

export async function isGlobalSuperAdministrator(
  openId: string,
): Promise<boolean> {
  const context = await getAccountAuthorizationContextForOpenId(openId);
  return context?.isSuperAdministrator ?? false;
}

export async function requireGlobalSuperAdministrator() {
  const { auth } = await import("@/lib/auth");
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }
  const context = await getAccountAuthorizationContextForOpenId(
    session.user.openId,
  );
  if (!context?.isSuperAdministrator) {
    throw new Error("无管理权限");
  }
  return { session, context };
}

export async function getGlobalSuperAdministratorOpenIds(): Promise<string[]> {
  const assignments = await prisma.systemRoleAssignment.findMany({
    where: {
      role: "SUPER_ADMINISTRATOR",
      team: "",
      techGroup: "",
      revokedAt: null,
    },
    select: {
      account: {
        select: {
          identities: {
            where: {
              provider: FEISHU_PROVIDER,
              tenantId: DEFAULT_TENANT_ID,
              openId: { not: null },
            },
            select: { openId: true },
          },
        },
      },
    },
  });
  return [
    ...new Set(
      assignments.flatMap((assignment) =>
        assignment.account.identities.flatMap((identity) =>
          identity.openId ? [identity.openId] : [],
        ),
      ),
    ),
  ];
}
