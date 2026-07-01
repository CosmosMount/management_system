import { OrderStatus } from "@prisma/client";
import { stepTimerResetFields } from "@/lib/order-step-timer";
import { resolveInvoicePaths } from "@/lib/order-attachments";
import { prisma } from "@/lib/prisma";
import { canConfirmReimbursement } from "@/lib/permissions";

export async function confirmProcurementByOpenId(
  openId: string,
  orderId: string,
): Promise<{ message: string }> {
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
      openId,
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

  await prisma.$transaction(async (tx) => {
    const locked = await tx.purchaseOrder.updateMany({
      where: { id: orderId, status: order.status },
      data: { status: OrderStatus.COMPLETED, ...stepTimerResetFields() },
    });
    if (locked.count !== 1) {
      throw new Error("订单状态已更新，请刷新后重试");
    }
  });

  return { message: "报销已确认完成" };
}
