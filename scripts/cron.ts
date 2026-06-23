import "dotenv/config";
import cron from "node-cron";
import { OrderStatus } from "@prisma/client";
import { sendFeishuDailySummary } from "../lib/feishu";
import { runProcurementStaleReminders } from "../lib/procurement-reminders";
import {
  runProgressDailyReminders,
  runProgressOverdueCheck,
  runWeeklyReportReminders,
} from "../lib/feishu-progress";
import { prisma } from "../lib/prisma";

async function runProcurementDaily() {
  const orders = await prisma.purchaseOrder.findMany({
    where: {
      status: { notIn: [OrderStatus.COMPLETED, OrderStatus.REJECTED] },
    },
    select: { status: true },
  });

  const ordersByStatus: Partial<Record<OrderStatus, number>> = {};
  for (const order of orders) {
    ordersByStatus[order.status] = (ordersByStatus[order.status] ?? 0) + 1;
  }

  await sendFeishuDailySummary(ordersByStatus);

  const reminded = await runProcurementStaleReminders();
  console.log(
    `[cron] 采购日报已发送，共 ${orders.length} 条未完结；催办 ${reminded} 单`,
  );
}

async function runProgressDaily() {
  const overdue = await runProgressOverdueCheck();
  const reminders = await runProgressDailyReminders();
  console.log(
    `[cron] 进度日报：${overdue} 条新逾期，${reminders} 条今日提醒`,
  );
}

async function runWeeklyReminders() {
  const count = await runWeeklyReportReminders();
  console.log(`[cron] 周报提醒已发送，共 ${count} 个活跃任务`);
}

cron.schedule("0 9 * * *", () => {
  runProcurementDaily().catch((err) =>
    console.error("[cron] 采购日报失败:", err),
  );
  runProgressDaily().catch((err) =>
    console.error("[cron] 进度日报失败:", err),
  );
});

cron.schedule("0 9 * * 1", () => {
  runWeeklyReminders().catch((err) =>
    console.error("[cron] 周报提醒失败:", err),
  );
});

console.log(
  "[cron] 定时任务已启动：每日 09:00 采购日报+催办+进度，每周一 09:00 周报提醒",
);
