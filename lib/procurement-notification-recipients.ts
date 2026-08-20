import type { UserRoleType } from "@prisma/client";
import { getOpenIdsByRole } from "@/lib/permissions";
import { statusApproverRole } from "@/lib/permissions-client";
import { prisma } from "@/lib/prisma";
import type { OrderCardPayload } from "@/lib/procurement-notification-contract";

function isInitiatorOnlyOrderNotification(status: OrderCardPayload["status"]) {
  return (
    status === "PENDING_APPLICANT_DOCS" ||
    status === "PENDING_APPLICANT_CONFIRM"
  );
}

export async function collectOrderNotificationRecipientOpenIds(
  order: OrderCardPayload,
): Promise<string[]> {
  if (isInitiatorOnlyOrderNotification(order.status)) {
    return collectOrderInitiatorOpenIds(order);
  }
  if (order.status === "MANAGEMENT_REVIEW") {
    const roles: UserRoleType[] = ["TEAM_ADMIN", "TECH_GROUP_ADMIN"];
    const openIdSet = new Set<string>();
    for (const role of roles) {
      const openIds = await getOpenIdsByRole(role, {
        team: order.team,
        techGroup: order.techGroup,
      });
      openIds.forEach((id) => openIdSet.add(id));
    }
    return [...openIdSet];
  }
  const approverRole = statusApproverRole[order.status];
  if (!approverRole) return [];
  return getOpenIdsByRole(approverRole, {
    team: order.team,
    techGroup: order.techGroup,
  });
}

export async function collectOrderInitiatorOpenIds(
  order: Pick<OrderCardPayload, "id">,
): Promise<string[]> {
  const record = await prisma.purchaseOrder.findUnique({
    where: { id: order.id },
    include: {
      initiator: {
        select: {
          openId: true,
          account: {
            select: { person: { select: { status: true } } },
          },
        },
      },
    },
  });
  return record?.initiator.openId &&
    record.initiator.account?.person?.status === "ACTIVE"
    ? [record.initiator.openId]
    : [];
}
