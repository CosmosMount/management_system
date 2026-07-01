import type { OrderCardPayload } from "@/lib/feishu";
import { mapOrderItems } from "@/lib/feishu";
import { prisma } from "@/lib/prisma";

/** 发送卡片前从数据库补全附件字段（兼容旧 outbox 或未重建的 Web 服务）。 */
export async function enrichOrderCardPayloadFromDb(
  order: OrderCardPayload,
): Promise<OrderCardPayload> {
  if (
    order.status !== "PENDING_APPLICANT_CONFIRM" &&
    order.status !== "PENDING_FINANCE_REVIEW"
  ) {
    return order;
  }

  const record = await prisma.purchaseOrder.findUnique({
    where: { id: order.id },
    select: {
      screenshotPath: true,
      invoicePaths: true,
      invoicePath: true,
      listDocPath: true,
      items: { select: { name: true, quantity: true, unitPrice: true } },
    },
  });
  if (!record) return order;

  return {
    ...order,
    screenshotPath: record.screenshotPath ?? order.screenshotPath,
    invoicePaths: record.invoicePaths,
    invoicePath: record.invoicePath,
    listDocPath: record.listDocPath,
    items: order.items ?? mapOrderItems(record.items),
  };
}
