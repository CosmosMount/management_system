import type { UserRoleType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { OrderScope, UserRoleRecord } from "@/lib/permissions-client";

export async function getUserRoles(openId: string): Promise<UserRoleRecord[]> {
  const records = await prisma.userRole.findMany({
    where: { openId },
    select: { role: true, team: true, techGroup: true },
  });
  return records;
}

export async function isSuperAdmin(openId: string): Promise<boolean> {
  const record = await prisma.userRole.findFirst({
    where: { openId, role: "SUPER_ADMIN" },
  });
  return !!record;
}

export async function requireSuperAdmin() {
  const { auth } = await import("@/lib/auth");
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }
  if (!(await isSuperAdmin(session.user.openId))) {
    throw new Error("无管理权限");
  }
  return session;
}

export async function getOpenIdsByRole(
  role: UserRoleType,
  order: OrderScope,
): Promise<string[]> {
  const where: {
    role: UserRoleType;
    team?: string;
    techGroup?: string;
  } = { role };

  if (role === "TEAM_ADMIN") {
    if (!order.team) return [];
    where.team = order.team;
    where.techGroup = "";
  } else if (
    role === "TECH_GROUP_ADMIN" ||
    role === "TEACHER" ||
    role === "FINANCE"
  ) {
    if (!order.techGroup) return [];
    where.techGroup = order.techGroup;
    where.team = "";
  } else if (role === "PROJECT_MANAGER" || role === "SUPER_ADMIN") {
    where.team = "";
    where.techGroup = "";
  } else {
    where.team = "";
    where.techGroup = "";
  }

  const records = await prisma.userRole.findMany({
    where,
    select: { openId: true },
  });
  const roleOpenIds = records.map((r) => r.openId);
  if (roleOpenIds.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { openId: { in: roleOpenIds } },
    select: { openId: true },
  });
  return users.map((u) => u.openId);
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
