import type { UserRoleType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export async function getUserRole(
  openId: string,
): Promise<UserRoleType | null> {
  const record = await prisma.userRole.findUnique({ where: { openId } });
  return record?.role ?? null;
}

export {
  canUploadReimbursement,
  getStatusTransition,
  roleLabels,
  statusLabels,
} from "@/lib/permissions-client";
