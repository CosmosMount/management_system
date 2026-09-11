import type { ProjectManagementNotificationCategory } from "@prisma/client";
import { prisma } from "../../lib/prisma";

export async function expectedProjectManagementRecipients(
  originalRecipients: Array<{ account: { id: string }; openId: string | null }>,
  category: ProjectManagementNotificationCategory,
  mandatory = false,
) {
  const administrators = await prisma.account.findMany({
    where: {
      person: { is: { status: "ACTIVE" } },
      systemRoles: { some: { role: "SUPER_ADMINISTRATOR", team: "", techGroup: "", revokedAt: null } },
    },
    select: {
      id: true,
      identities: {
        where: { provider: "FEISHU", tenantId: "default" },
        select: { openId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
  const recipients = new Map<string, string | null>();
  for (const administrator of administrators) {
    recipients.set(administrator.id, administrator.identities.find((identity) => identity.openId?.trim())?.openId?.trim() ?? null);
  }
  for (const recipient of originalRecipients) recipients.set(recipient.account.id, recipient.openId);
  const disabled = mandatory ? [] : await prisma.notificationPreference.findMany({
    where: { accountId: { in: [...recipients.keys()] }, category, channel: "FEISHU", enabled: false },
    select: { accountId: true },
  });
  const disabledIds = new Set(disabled.map((preference) => preference.accountId));
  return {
    accountIds: [...recipients.keys()].sort(),
    openIds: [...new Set([...recipients].flatMap(([accountId, openId]) => openId && !disabledIds.has(accountId) ? [openId] : []))].sort(),
  };
}
