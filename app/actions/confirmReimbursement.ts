"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { stepTimerResetFields } from "@/lib/order-step-timer";
import { prisma } from "@/lib/prisma";
import { resolveInvoicePaths } from "@/lib/order-attachments";
import { canConfirmReimbursement } from "@/lib/permissions";

export async function confirmReimbursement(orderId: string) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { initiator: { select: { openId: true } } },
  });
  if (!order) {
    throw new Error("订单不存在");
  }

  if (
    !canConfirmReimbursement(
      order.status,
      session.user.openId,
      order.initiator.openId,
    )
  ) {
    throw new Error("无确认权限");
  }

  const invoices = resolveInvoicePaths(order.invoicePaths, order.invoicePath);
  if (
    invoices.length === 0 ||
    !order.listDocPath ||
    !order.screenshotPath
  ) {
    throw new Error("凭证不完整，无法确认");
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id: orderId },
    data: { status: OrderStatus.COMPLETED, ...stepTimerResetFields() },
  });

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  return updated;
}
