"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  drainNotificationOutboxSoon,
  enqueueApplicantResubmitNotification,
} from "@/lib/notification-outbox";
import { stepTimerResetFields } from "@/lib/order-step-timer";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import {
  canRequestApplicantResubmit,
  getUserRoles,
} from "@/lib/permissions";
import { OrderStatus } from "@prisma/client";
import { routes } from "@/lib/routes";

const inputSchema = z.object({
  orderId: z.string().min(1),
  reason: z.string().trim().min(1, "请填写需补充说明").max(500),
});

/** 报销员要求采购人重新提交凭证与附件 */
export async function requestApplicantResubmit(input: {
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
  if (order.status !== OrderStatus.PENDING_FINANCE_REVIEW) {
    throw new Error("当前状态不允许此操作");
  }

  const scope = { team: order.team, techGroup: order.techGroup };
  if (!canRequestApplicantResubmit(order.status, userRoles, scope)) {
    throw new Error("无操作权限");
  }

  const user = await prisma.user.findUnique({
    where: { openId: session.user.openId },
    select: { name: true },
  });
  const rejectedByName = user?.name ?? session.user.name ?? "报销员";

  const updated = await prisma.$transaction(async (tx) => {
    await tx.purchaseItem.updateMany({
      where: { orderId },
      data: { photoPath: null },
    });
    return tx.purchaseOrder.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.PENDING_APPLICANT_DOCS,
        invoicePaths: "[]",
        invoicePath: null,
        listDocPath: null,
        screenshotPath: null,
        rejectionReason: reason,
        rejectedAt: new Date(),
        rejectedByName,
        ...stepTimerResetFields(),
      },
    });
  });

  await enqueueApplicantResubmitNotification(
    `procurement:resubmit:${updated.id}:${updated.updatedAt.toISOString()}`,
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
    await getNotificationContext(),
  );
  drainNotificationOutboxSoon();

  revalidatePath(routes.procurement.list);
  revalidatePath(`${routes.procurement.detail(orderId)}`);
  return updated;
}
