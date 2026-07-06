"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { canNotifyProcurementApprover, getUserRoles } from "@/lib/permissions";
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

export type NotifyProcurementApproverResult = {
  ok: boolean;
  message: string;
};

export async function notifyProcurementApprover(
  input: unknown,
): Promise<NotifyProcurementApproverResult> {
  const session = await auth();
  if (!session?.user?.openId) {
    return { ok: false, message: "未登录" };
  }

  const parsed = notifySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "请求参数无效" };
  }
  const message = parsed.data.message?.trim() || undefined;

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: parsed.data.orderId },
    include: { initiator: { select: { openId: true } } },
  });
  if (!order) {
    return { ok: false, message: "订单不存在" };
  }

  const userRoles = await getUserRoles(session.user.openId);

  if (
    !canNotifyProcurementApprover(
      order.status,
      session.user.openId,
      order.initiator.openId,
      userRoles,
    )
  ) {
    return { ok: false, message: "当前状态不可催促审批人" };
  }

  const result = await sendManualProcurementApproverReminder({
    orderId: order.id,
    actorName: session.user.name ?? order.initiatorName,
    message,
    context: await getNotificationContext(),
  });

  if (result.ok) {
    revalidateProcurement(order.id);
  }

  return result;
}
