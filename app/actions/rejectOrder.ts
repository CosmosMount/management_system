"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { sendProcurementRejectedNotification } from "@/lib/feishu";
import { prisma } from "@/lib/prisma";
import {
  canRejectProcurement,
  getUserRoles,
} from "@/lib/permissions";
import { OrderStatus } from "@prisma/client";

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

  const updated = await prisma.purchaseOrder.update({
    where: { id: orderId },
    data: {
      status: OrderStatus.REJECTED,
      teamApproved: false,
      techGroupApproved: false,
      rejectionReason: reason,
      rejectedAt: new Date(),
      rejectedByName,
    },
  });

  await sendProcurementRejectedNotification(
    {
      id: updated.id,
      orderNo: updated.orderNo,
      initiatorName: updated.initiatorName,
      totalPrice: updated.totalPrice,
      status: updated.status,
      team: updated.team,
      techGroup: updated.techGroup,
      items: order.items.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
    },
    reason,
    rejectedByName,
  ).catch((err) => {
    console.error("[rejectProcurementOrder] 飞书通知失败:", err);
  });

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/dashboard");
  return updated;
}
