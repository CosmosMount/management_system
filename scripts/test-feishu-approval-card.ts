import "dotenv/config";
import { mapOrderItems } from "@/lib/feishu";
import { sendManagementReviewNotification } from "@/lib/feishu";
import { prisma } from "@/lib/prisma";

async function main() {
  const orderId = process.argv[2];
  const order = orderId
    ? await prisma.purchaseOrder.findUnique({
        where: { id: orderId },
        include: { items: true },
      })
    : await prisma.purchaseOrder.findFirst({
        where: { status: "MANAGEMENT_REVIEW" },
        include: { items: true },
        orderBy: { updatedAt: "desc" },
      });

  if (!order) {
    throw new Error("未找到 MANAGEMENT_REVIEW 订单，可传入 orderId");
  }

  await sendManagementReviewNotification({
    id: order.id,
    orderNo: order.orderNo,
    initiatorName: order.initiatorName,
    totalPrice: order.totalPrice,
    status: order.status,
    team: order.team,
    techGroup: order.techGroup,
    items: mapOrderItems(order.items),
  });

  console.log(
    `[test-feishu-card] 已重发管理审核通知 orderNo=${order.orderNo} id=${order.id}`,
  );
}

main().catch((error) => {
  console.error("[test-feishu-card] 失败:", error);
  process.exit(1);
});
