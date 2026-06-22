"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { sendOrderNotification } from "@/lib/feishu";
import { prisma } from "@/lib/prisma";
import {
  getStatusTransition,
  getUserRole,
} from "@/lib/permissions";

export async function updateOrderStatus(orderId: string) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  const role = await getUserRole(session.user.openId);
  if (!role) {
    throw new Error("无操作权限");
  }

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
  });
  if (!order) {
    throw new Error("订单不存在");
  }

  const transition = getStatusTransition(order.status);
  if (!transition || transition.role !== role) {
    throw new Error("当前状态不允许此操作");
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id: orderId },
    data: { status: transition.next },
  });

  const notifyStatuses: OrderStatus[] = [
    OrderStatus.TEACHER_REVIEW,
    OrderStatus.PENDING_REIMBURSE,
  ];
  if (notifyStatuses.includes(updated.status)) {
    await sendOrderNotification({
      id: updated.id,
      orderNo: updated.orderNo,
      initiatorName: updated.initiatorName,
      totalPrice: updated.totalPrice,
      status: updated.status,
    }).catch((err) => {
      console.error("[updateOrderStatus] 飞书通知失败:", err);
    });
  }

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  return updated;
}
