import "dotenv/config";
import cron from "node-cron";
import { OrderStatus } from "@prisma/client";
import { sendFeishuDailySummary } from "../lib/feishu";
import { runProcurementStaleReminders } from "../lib/procurement-reminders";
import { runProcurementBudgetAlerts } from "../lib/procurement-budget-alerts";
import { runDueProgressReminderRules } from "../lib/progress-reminders";
import { syncFeishuContactUsers } from "../lib/feishu-user-sync";
import { drainNotificationOutbox } from "../lib/notification-outbox";
import { prisma } from "../lib/prisma";

const CONTACT_SYNC_CRON = process.env.FEISHU_CONTACT_SYNC_CRON ?? "30 8 * * *";
let contactSyncRunning = false;
let progressScanRunning = false;
let budgetScanRunning = false;

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
  if (progressScanRunning) {
    console.warn("[cron] 进度提醒扫描仍在运行，跳过本次扫描");
    return;
  }

  progressScanRunning = true;
  try {
    const result = await runDueProgressReminderRules();
    if (result.skipped) {
      console.warn("[cron] 进度提醒扫描已由其他入口执行，跳过本次扫描");
      return;
    }
    console.log(
      `[cron] 进度提醒扫描：执行 ${result.rulesRun} 条规则，入队 ${result.queued} 条通知`,
    );
  } finally {
    progressScanRunning = false;
  }
}

async function runFeishuContactSync() {
  if (contactSyncRunning) {
    console.warn("[cron] 飞书人员同步仍在运行，跳过本次扫描");
    return;
  }

  contactSyncRunning = true;
  try {
    const result = await syncFeishuContactUsers();
    console.log(
      `[cron] 飞书人员同步完成：总计 ${result.total} 人，新增 ${result.created} 人，更新 ${result.updated} 人`,
    );
  } finally {
    contactSyncRunning = false;
  }
}

async function runProcurementBudgetScan() {
  if (budgetScanRunning) {
    console.warn("[cron] 采购预算预警扫描仍在运行，跳过本次扫描");
    return;
  }

  budgetScanRunning = true;
  try {
    const queued = await runProcurementBudgetAlerts();
    if (queued > 0) {
      console.log(`[cron] 采购预算预警：入队 ${queued} 条通知`);
    }
  } finally {
    budgetScanRunning = false;
  }
}

async function runNotificationOutboxDrain() {
  const sent = await drainNotificationOutbox(50);
  if (sent > 0) {
    console.log(`[cron] 通知 outbox 已发送 ${sent} 条`);
  }
}

cron.schedule(CONTACT_SYNC_CRON, () => {
  runFeishuContactSync().catch((err) =>
    console.error("[cron] 飞书人员同步失败:", err),
  );
});

cron.schedule("*/2 * * * *", () => {
  runNotificationOutboxDrain().catch((err) =>
    console.error("[cron] 通知 outbox 发送失败:", err),
  );
});

cron.schedule("*/10 * * * *", () => {
  runProgressDaily().catch((err) =>
    console.error("[cron] 进度提醒扫描失败:", err),
  );
  runProcurementBudgetScan().catch((err) =>
    console.error("[cron] 采购预算预警扫描失败:", err),
  );
});

cron.schedule("0 9 * * *", () => {
  runProcurementDaily().catch((err) =>
    console.error("[cron] 采购日报失败:", err),
  );
});

console.log(
  `[cron] 定时任务已启动：飞书人员同步(${CONTACT_SYNC_CRON})，每日 09:00 采购日报+催办，每 10 分钟扫描进度提醒与采购预算预警，每 2 分钟发送通知 outbox`,
);
