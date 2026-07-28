import type { OrderStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type ProfileOrderRow = {
  id: string;
  orderNo: string;
  team: string;
  techGroup: string;
  totalPrice: number;
  status: OrderStatus;
  updatedAt: string;
  isActive: boolean;
};

export type UserProfileRecords = {
  orders: ProfileOrderRow[];
};

const ACTIVE_ORDER_STATUSES = new Set<OrderStatus>([
  "DRAFT",
  "MANAGEMENT_REVIEW",
  "TEACHER_REVIEW",
  "PENDING_APPLICANT_DOCS",
  "PENDING_FINANCE_REVIEW",
  "PENDING_APPLICANT_CONFIRM",
]);

function sortActiveFirst<T extends { isActive: boolean; updatedAt: string }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    if (a.isActive !== b.isActive) {
      return a.isActive ? -1 : 1;
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export async function getUserProfileRecords(
  openId: string,
): Promise<UserProfileRecords> {
  const orders = await prisma.purchaseOrder.findMany({
    where: { initiator: { openId } },
    select: {
      id: true,
      orderNo: true,
      team: true,
      techGroup: true,
      totalPrice: true,
      status: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  return {
    orders: sortActiveFirst(
      orders.map((order) => ({
        ...order,
        updatedAt: order.updatedAt.toISOString(),
        isActive: ACTIVE_ORDER_STATUSES.has(order.status),
      })),
    ),
  };
}
