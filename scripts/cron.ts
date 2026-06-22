import "dotenv/config";
import cron from "node-cron";
import { OrderStatus } from "@prisma/client";
import { sendFeishuDailySummary } from "../lib/feishu";
import { prisma } from "../lib/prisma";

async function runDailySummary() {
  const orders = await prisma.purchaseOrder.findMany({
    where: { status: { not: OrderStatus.COMPLETED } },
    select: { status: true },
  });

  const ordersByStatus: Partial<Record<OrderStatus, number>> = {};
  for (const order of orders) {
    ordersByStatus[order.status] = (ordersByStatus[order.status] ?? 0) + 1;
  }

  await sendFeishuDailySummary(ordersByStatus);
  console.log(
    `[cron] 每日汇总已发送，共 ${orders.length} 条未完结单据`,
  );
}

cron.schedule("0 9 * * *", () => {
  runDailySummary().catch((err) => {
    console.error("[cron] 执行失败:", err);
  });
});

console.log("[cron] 采购报销定时任务已启动，每天 09:00 发送汇总");
