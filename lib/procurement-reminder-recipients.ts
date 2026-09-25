import type { OrderStatus } from "@prisma/client";
import { getOpenIdsByRole } from "@/lib/permissions";
import { statusApproverRole } from "@/lib/permissions-client";
import { collectOrderInitiatorOpenIds } from "@/lib/procurement-notification-recipients";

export type ReminderOrderScope = {
  id: string;
  status: OrderStatus;
  team: string;
  techGroup: string;
  teamApproved: boolean;
  techGroupApproved: boolean;
};

export async function collectReminderRecipientOpenIds(
  order: ReminderOrderScope,
): Promise<string[]> {
  if (
    order.status === "PENDING_APPLICANT_DOCS" ||
    order.status === "PENDING_APPLICANT_CONFIRM"
  ) {
    return collectOrderInitiatorOpenIds(order);
  }
  const openIds = new Set<string>();
  if (order.status === "MANAGEMENT_REVIEW") {
    if (!order.teamApproved) {
      for (const id of await getOpenIdsByRole("TEAM_ADMIN", order)) openIds.add(id);
    }
    if (!order.techGroupApproved) {
      for (const id of await getOpenIdsByRole("TECH_GROUP_ADMIN", order)) openIds.add(id);
    }
    return [...openIds];
  }
  const role = statusApproverRole[order.status];
  if (!role) return [];
  return getOpenIdsByRole(role, order);
}
