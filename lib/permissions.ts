import type { UserRoleType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  getAccountAuthorizationContextForOpenId,
  getGlobalSuperAdministratorOpenIds,
  isGlobalSuperAdministrator,
  requireGlobalSuperAdministrator,
} from "@/lib/account-authorization";
import type { OrderScope, UserRoleRecord } from "@/lib/permissions-client";

export async function getUserRoles(openId: string): Promise<UserRoleRecord[]> {
  const authorization = await getAccountAuthorizationContextForOpenId(openId);
  if (!authorization) return [];
  const records = authorization.reimbursementRoles.map(
    ({ role, team, techGroup }) => ({ role, team, techGroup }),
  );
  if (authorization.isSuperAdministrator) {
    records.push({ role: "SUPER_ADMIN", team: "", techGroup: "" });
  }
  return records;
}

export async function isSuperAdmin(openId: string): Promise<boolean> {
  return isGlobalSuperAdministrator(openId);
}

export async function requireSuperAdmin() {
  const { session } = await requireGlobalSuperAdministrator();
  return session;
}

export async function getOpenIdsByRole(
  role: UserRoleType,
  order: OrderScope,
): Promise<string[]> {
  if (role === "SUPER_ADMIN") {
    return getGlobalSuperAdministratorOpenIds();
  }
  const where: {
    role: UserRoleType;
    team?: string;
    techGroup?: string;
  } = { role };

  if (role === "TEAM_ADMIN" || role === "FINANCE") {
    if (!order.team) return [];
    where.team = order.team;
    where.techGroup = "";
  } else if (role === "TECH_GROUP_ADMIN" || role === "TEACHER") {
    if (!order.techGroup) return [];
    where.techGroup = order.techGroup;
    where.team = "";
  } else {
    where.team = "";
    where.techGroup = "";
  }

  const records = await prisma.userRole.findMany({
    where: { ...where, revokedAt: null },
    select: {
      account: {
        select: {
          identities: {
            where: {
              provider: "FEISHU",
              tenantId: "default",
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
      records.flatMap((record) =>
        record.account?.identities.flatMap((identity) =>
          identity.openId ? [identity.openId] : [],
        ) ?? [],
      ),
    ),
  ];
}

export {
  canApproveOrder,
  canApproveTeamManagement,
  canApproveTechGroupManagement,
  canConfirmReimbursement,
  canEditDraftOrder,
  canEditProcurementOrder,
  canNotifyProcurementApprover,
  canWithdrawProcurementOrder,
  canRejectProcurement,
  canRejectProcurementOrder,
  canRequestApplicantResubmit,
  canSupplementApplicantDocs,
  canUploadApplicantDocs,
  canUploadFinanceScreenshot,
  canViewReimbursementAttachments,
  formatRoleLabel,
  getStatusTransition,
  isOrderInitiator,
  isSuperAdmin as isSuperAdminClient,
  roleLabels,
  statusLabels,
} from "@/lib/permissions-client";
export type { OrderScope, UserRoleRecord } from "@/lib/permissions-client";
