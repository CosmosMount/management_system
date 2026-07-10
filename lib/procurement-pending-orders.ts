import type { OrderStatus } from "@prisma/client";
import {
  canApproveOrder,
  canConfirmReimbursement,
  canUploadApplicantDocs,
  canUploadFinanceScreenshot,
  type UserRoleRecord,
} from "@/lib/permissions-client";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";

const ACTIVE_STATUSES: OrderStatus[] = [
  "MANAGEMENT_REVIEW",
  "TEACHER_REVIEW",
  "PENDING_APPLICANT_DOCS",
  "PENDING_FINANCE_REVIEW",
  "PENDING_APPLICANT_CONFIRM",
];

export type ProcurementPendingOrder = {
  id: string;
  orderNo: string;
  initiatorName: string;
  team: string;
  techGroup: string;
  totalPrice: number;
  status: OrderStatus;
  statusEnteredAt: Date;
};

type PendingOrderInput = {
  status: OrderStatus;
  team: string;
  techGroup: string;
  teamApproved: boolean;
  techGroupApproved: boolean;
  initiatorOpenId: string;
};

export function canHandleProcurementOrder(
  order: PendingOrderInput,
  userOpenId: string | undefined,
  userRoles: UserRoleRecord[],
): boolean {
  if (!userOpenId) return false;

  const scope = { team: order.team, techGroup: order.techGroup };
  const managementState = {
    teamApproved: order.teamApproved,
    techGroupApproved: order.techGroupApproved,
  };

  return (
    canApproveOrder(order.status, userRoles, scope, managementState) ||
    canUploadApplicantDocs(order.status, userOpenId, order.initiatorOpenId) ||
    canUploadFinanceScreenshot(order.status, userRoles, scope) ||
    canConfirmReimbursement(order.status, userOpenId, order.initiatorOpenId)
  );
}

export function procurementPendingOrderHref(
  orderId: string,
  status: OrderStatus,
): string {
  const base = routes.procurement.detail(orderId);
  if (status === "MANAGEMENT_REVIEW" || status === "TEACHER_REVIEW") {
    return `${base}?focus=approval#approval`;
  }
  if (
    status === "PENDING_APPLICANT_DOCS" ||
    status === "PENDING_FINANCE_REVIEW"
  ) {
    return `${base}?focus=upload#upload`;
  }
  if (status === "PENDING_APPLICANT_CONFIRM") {
    return `${base}?focus=confirm#confirm`;
  }
  return base;
}

export async function getProcurementPendingOrders({
  userOpenId,
  roles,
}: {
  userOpenId?: string;
  roles: UserRoleRecord[];
}): Promise<ProcurementPendingOrder[]> {
  if (!userOpenId) return [];

  const orders = await prisma.purchaseOrder.findMany({
    where: {
      status: { in: ACTIVE_STATUSES },
    },
    include: {
      initiator: { select: { openId: true } },
    },
    orderBy: { statusEnteredAt: "asc" },
  });

  return orders
    .filter((order) =>
      canHandleProcurementOrder(
        {
          status: order.status,
          team: order.team,
          techGroup: order.techGroup,
          teamApproved: order.teamApproved,
          techGroupApproved: order.techGroupApproved,
          initiatorOpenId: order.initiator.openId,
        },
        userOpenId,
        roles,
      ),
    )
    .map((order) => ({
      id: order.id,
      orderNo: order.orderNo,
      initiatorName: order.initiatorName,
      team: order.team,
      techGroup: order.techGroup,
      totalPrice: order.totalPrice,
      status: order.status,
      statusEnteredAt: order.statusEnteredAt,
    }));
}
