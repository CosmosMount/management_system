"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { sendOrderNotification, mapOrderItems } from "@/lib/feishu";
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

  const updated = await prisma.purchaseOrder.update({
    where: { id: orderId },
    data: { status: transition.next, ...stepTimerResetFields() },
  });

  const notifyStatuses: OrderStatus[] = [
    OrderStatus.PENDING_APPLICANT_DOCS,
  ];
  if (notifyStatuses.includes(updated.status)) {
    await sendOrderNotification({
      id: updated.id,
      orderNo: updated.orderNo,
      initiatorName: updated.initiatorName,
      totalPrice: updated.totalPrice,
      status: updated.status,
      team: updated.team,
      techGroup: updated.techGroup,
      items: mapOrderItems(order.items),
    }, await getNotificationContext()).catch((err) => {
      console.error("[updateOrderStatus] 飞书通知失败:", err);
    });
  }

  revalidatePath(routes.procurement.list);
  revalidatePath(`${routes.procurement.detail(orderId)}`);
  return updated;
}
