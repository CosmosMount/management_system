import type { UserRoleType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export async function getUserRole(
  openId: string,
): Promise<UserRoleType | null> {
  const record = await prisma.userRole.findUnique({ where: { openId } });
  return record?.role ?? null;
}

export async function getOpenIdsByRole(role: UserRoleType): Promise<string[]> {
  const records = await prisma.userRole.findMany({
    where: { role },
    select: { openId: true },
  });
  const roleOpenIds = records.map((r) => r.openId);
  if (roleOpenIds.length === 0) return [];

  // 仅通知已在当前应用登录过的用户（User.openId 与本应用 OAuth 一致，避免 cross app）
  const users = await prisma.user.findMany({
    where: { openId: { in: roleOpenIds } },
    select: { openId: true },
  });
  const validOpenIds = users.map((u) => u.openId);

  // #region agent log
  fetch("http://127.0.0.1:7797/ingest/c199d5e2-69f6-40ac-aea6-e151b57e40b3", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "de9726",
    },
    body: JSON.stringify({
      sessionId: "de9726",
      hypothesisId: "A",
      location: "permissions.ts:getOpenIdsByRole",
      message: "role open_id filter",
      data: {
        role,
        configuredCount: roleOpenIds.length,
        validCount: validOpenIds.length,
        skippedCount: roleOpenIds.length - validOpenIds.length,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  return validOpenIds;
}

export {
  canUploadReimbursement,
  getStatusTransition,
  roleLabels,
  statusLabels,
} from "@/lib/permissions-client";
