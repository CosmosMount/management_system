import "dotenv/config";
import { mapOrderItems } from "@/lib/feishu";
import { sendManagementReviewNotification } from "@/lib/feishu";
import { prisma } from "@/lib/prisma";

function canSendFeishu(): boolean {
  return (
    process.env.CONFIRM_SEND_FEISHU === "true" &&
    process.env.NOTIFICATION_DELIVERY_DISABLED !== "true"
  );
}

async function main() {
  const orderId = process.argv[2];
  if (!orderId) {
    throw new Error(
      "用法: tsx scripts/test-feishu-approval-card.ts <orderId>。为避免误发，不再默认选择最新订单。",
    );
  }

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  });

  if (!order) {
    throw new Error("未找到订单");
  }

  const payload = {
    id: order.id,
    orderNo: order.orderNo,
    initiatorName: order.initiatorName,
    totalPrice: order.totalPrice,
    status: order.status,
    team: order.team,
    techGroup: order.techGroup,
    items: mapOrderItems(order.items),
  };

  if (!canSendFeishu()) {
    console.log(
      "[test-feishu-card] dry-run：不会发送飞书消息。若确需发送，设置 CONFIRM_SEND_FEISHU=true 且不要设置 NOTIFICATION_DELIVERY_DISABLED=true。",
    );
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  await sendManagementReviewNotification(payload);

  console.log(
    `[test-feishu-card] 已重发管理审核通知 orderNo=${order.orderNo} id=${order.id}`,
  );
}

main().catch((error) => {
  console.error("[test-feishu-card] 失败:", error);
  process.exit(1);
});
