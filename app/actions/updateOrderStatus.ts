"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { mapOrderItems } from "@/lib/feishu";
import {
  drainNotificationOutboxSoon,
  enqueueOrderNotificationTx,
  orderNotificationEventKey,
} from "@/lib/notification-outbox";
import { refreshProcurementFeishuCards } from "@/lib/feishu-procurement-card-sync";
import { stepTimerResetFields } from "@/lib/order-step-timer";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { routes } from "@/lib/routes";
import {
  canApproveOrder,
  getStatusTransition,
  getUserRoles,
} from "@/lib/permissions";

export async function updateOrderStatus(orderId: string) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  const userRoles = await getUserRoles(session.user.openId);
  if (userRoles.length === 0) {
    throw new Error("无操作权限");
  }

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) {
    throw new Error("订单不存在");
  }

  const scope = { team: order.team, techGroup: order.techGroup };

  if (
    !canApproveOrder(order.status, userRoles, scope, {
      teamApproved: order.teamApproved,
      techGroupApproved: order.techGroupApproved,
    })
  ) {
    throw new Error("当前状态不允许此操作");
  }

  const transition = getStatusTransition(order.status);
  if (!transition) {
    throw new Error("当前状态不允许此操作");
  }

  const context = await getNotificationContext();
  const notifyStatuses: OrderStatus[] = [
    OrderStatus.PENDING_APPLICANT_DOCS,
  ];
  const { updated, shouldDrain } = await prisma.$transaction(async (tx) => {
    const locked = await tx.purchaseOrder.updateMany({
      where: { id: orderId, status: order.status },
      data: { status: transition.next, ...stepTimerResetFields() },
    });
    if (locked.count !== 1) {
      throw new Error("订单状态已更新，请刷新后重试");
    }

    const record = await tx.purchaseOrder.findUniqueOrThrow({
      where: { id: orderId },
    });
    if (notifyStatuses.includes(record.status)) {
      await enqueueOrderNotificationTx(
        tx,
        orderNotificationEventKey(record),
        {
          id: record.id,
          orderNo: record.orderNo,
          initiatorName: record.initiatorName,
          totalPrice: record.totalPrice,
          status: record.status,
          team: record.team,
          techGroup: record.techGroup,
          items: mapOrderItems(order.items),
        },
        context,
      );
      return { updated: record, shouldDrain: true };
    }
    return { updated: record, shouldDrain: false };
  });

  if (shouldDrain) {
    if (order.status === OrderStatus.TEACHER_REVIEW) {
      await refreshProcurementFeishuCards(
        orderId,
        `老师审核已通过，订单 ${updated.orderNo} 待上传凭证`,
      );
    }
    drainNotificationOutboxSoon();
  }

  revalidatePath(routes.procurement.list);
  revalidatePath(`${routes.procurement.detail(orderId)}`);
  return updated;
}
