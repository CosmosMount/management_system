"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  drainNotificationOutboxSoon,
  enqueueProcurementRejectedNotificationTx,
} from "@/lib/notification-outbox";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import {
  canRejectProcurement,
  getUserRoles,
} from "@/lib/permissions";
import { OrderStatus } from "@prisma/client";
import { routes } from "@/lib/routes";

const inputSchema = z.object({
  orderId: z.string().min(1),
  reason: z.string().trim().min(1, "请填写驳回原因").max(500),
});

/** 管理审核 / 老师审核阶段驳回采购，流程终止 */
export async function rejectProcurementOrder(input: {
  orderId: string;
  reason: string;
}) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  const { orderId, reason } = inputSchema.parse(input);
  const userRoles = await getUserRoles(session.user.openId);
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) {
    throw new Error("订单不存在");
  }
  if (
    order.status !== OrderStatus.MANAGEMENT_REVIEW &&
    order.status !== OrderStatus.TEACHER_REVIEW
  ) {
    throw new Error("当前状态不允许驳回");
  }

  const scope = { team: order.team, techGroup: order.techGroup };
  if (!canRejectProcurement(order.status, userRoles, scope)) {
    throw new Error("无驳回权限");
  }

  const user = await prisma.user.findUnique({
    where: { openId: session.user.openId },
    select: { name: true },
  });
  const rejectedByName = user?.name ?? session.user.name ?? "审批人";

  const context = await getNotificationContext();
  const updated = await prisma.$transaction(async (tx) => {
    const locked = await tx.purchaseOrder.updateMany({
      where: { id: orderId, status: order.status },
      data: {
        status: OrderStatus.REJECTED,
        teamApproved: false,
        techGroupApproved: false,
        rejectionReason: reason,
        rejectedAt: new Date(),
        rejectedByName,
      },
    });
    if (locked.count !== 1) {
      throw new Error("订单状态已更新，请刷新后重试");
    }
    const record = await tx.purchaseOrder.findUniqueOrThrow({
      where: { id: orderId },
    });
    await enqueueProcurementRejectedNotificationTx(
      tx,
      `procurement:rejected:${record.id}:${record.updatedAt.toISOString()}`,
      {
        id: record.id,
        orderNo: record.orderNo,
        initiatorName: record.initiatorName,
        totalPrice: record.totalPrice,
        status: record.status,
        team: record.team,
        techGroup: record.techGroup,
        items: order.items.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
      },
      reason,
      rejectedByName,
      context,
    );
    return record;
  });
  drainNotificationOutboxSoon();

  revalidatePath(routes.procurement.list);
  revalidatePath(`${routes.procurement.detail(orderId)}`);
  revalidatePath(routes.procurement.dashboard);
  return updated;
}
