"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { canNotifyProcurementApprover } from "@/lib/permissions-client";
import { sendManualProcurementApproverReminder } from "@/lib/procurement-reminders";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { revalidateProcurement } from "@/lib/revalidate";

const notifySchema = z.object({
  orderId: z.string().min(1),
  message: z
    .string()
    .trim()
    .max(500, "补充说明不能超过 500 个字符")
    .optional(),
});

export async function notifyProcurementApprover(input: unknown) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  const parsed = notifySchema.parse(input);
  const message = parsed.message?.trim() || undefined;

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: parsed.orderId },
    include: { initiator: { select: { openId: true } } },
  });
  if (!order) {
    throw new Error("订单不存在");
  }

  if (
    !canNotifyProcurementApprover(
      order.status,
      session.user.openId,
      order.initiator.openId,
    )
  ) {
    throw new Error("当前状态不可通知审批人");
  }

  await sendManualProcurementApproverReminder({
    orderId: order.id,
    actorName: session.user.name ?? order.initiatorName,
    message,
    context: await getNotificationContext(),
  });

  revalidateProcurement(order.id);
}
