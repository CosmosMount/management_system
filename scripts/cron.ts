import "dotenv/config";
import cron from "node-cron";
import { OrderStatus } from "@prisma/client";
import { sendFeishuDailySummary } from "../lib/feishu";
import { runProcurementStaleReminders } from "../lib/procurement-reminders";
import { runProcurementBudgetAlerts } from "../lib/procurement-budget-alerts";
import { runProgressDailySummariesIfDue } from "../lib/progress-daily-summary";
import { runDueProgressReminderRules } from "../lib/progress-reminders";
import { syncFeishuContactUsers } from "../lib/feishu-user-sync";
import { drainNotificationOutbox } from "../lib/notification-outbox";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

const CONTACT_SYNC_CRON = process.env.FEISHU_CONTACT_SYNC_CRON ?? "30 8 * * *";
const PROGRESS_DAILY_SUMMARY_CHECK_CRON =
  process.env.PROGRESS_DAILY_SUMMARY_CHECK_CRON ?? "*/5 * * * *";
const CRON_TIMEZONE = "Asia/Shanghai";
let contactSyncRunning = false;
let progressScanRunning = false;
let progressSummaryRunning = false;
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
  logger.info("cron.procurement_daily.completed", {
    module: "cron",
    action: "runProcurementDaily",
    openOrderCount: orders.length,
    remindedCount: reminded,
  });
}

async function runProgressDaily() {
  if (progressScanRunning) {
    logger.warn("cron.progress_reminders.skipped_running", {
      module: "cron",
      action: "runProgressDaily",
      result: "skipped",
    });
    return;
  }

  progressScanRunning = true;
  try {
    const result = await runDueProgressReminderRules();
    if (result.skipped) {
      logger.warn("cron.progress_reminders.skipped_lock", {
        module: "cron",
        action: "runProgressDaily",
        result: "skipped",
      });
      return;
    }
    logger.info("cron.progress_reminders.completed", {
      module: "cron",
      action: "runProgressDaily",
      rulesRun: result.rulesRun,
      queued: result.queued,
    });
  } finally {
    progressScanRunning = false;
  }
}

async function runProgressDailySummary() {
  if (progressSummaryRunning) {
    logger.warn("cron.progress_daily_summary.skipped_running", {
      module: "cron",
      action: "runProgressDailySummary",
      result: "skipped",
    });
    return;
  }

  progressSummaryRunning = true;
  try {
    const result = await runProgressDailySummariesIfDue();
    if (!result.ran) {
      logger.info("cron.progress_daily_summary.skipped", {
        module: "cron",
        action: "runProgressDailySummary",
        reason: result.reason,
        summaryDate: result.summaryDate,
        scheduleTime: result.scheduleTime,
        lastRunAt: result.lastRunAt,
        result: "skipped",
      });
      return;
    }
    logger.info("cron.progress_daily_summary.completed", {
      module: "cron",
      action: "runProgressDailySummary",
      summaryDate: result.summaryDate,
      recipients: result.recipients,
      queued: result.queued,
      skipped: result.skipped,
    });
  } finally {
    progressSummaryRunning = false;
  }
}

async function runFeishuContactSync() {
  if (contactSyncRunning) {
    logger.warn("cron.feishu_contact_sync.skipped_running", {
      module: "cron",
      action: "runFeishuContactSync",
      result: "skipped",
    });
    return;
  }

  contactSyncRunning = true;
  try {
    const result = await syncFeishuContactUsers();
    logger.info("cron.feishu_contact_sync.completed", {
      module: "cron",
      action: "runFeishuContactSync",
      total: result.total,
      created: result.created,
      updated: result.updated,
    });
  } finally {
    contactSyncRunning = false;
  }
}

async function runProcurementBudgetScan() {
  if (budgetScanRunning) {
    logger.warn("cron.procurement_budget_scan.skipped_running", {
      module: "cron",
      action: "runProcurementBudgetScan",
      result: "skipped",
    });
    return;
  }

  budgetScanRunning = true;
  try {
    const queued = await runProcurementBudgetAlerts();
    if (queued > 0) {
      logger.info("cron.procurement_budget_scan.completed", {
        module: "cron",
        action: "runProcurementBudgetScan",
        queued,
      });
    }
  } finally {
    budgetScanRunning = false;
  }
}

async function runNotificationOutboxDrain() {
  const sent = await drainNotificationOutbox(50);
  if (sent > 0) {
    logger.info("cron.notification_outbox_drain.completed", {
      module: "cron",
      action: "runNotificationOutboxDrain",
      sent,
    });
  }
}

cron.schedule(
  CONTACT_SYNC_CRON,
  () => {
    runFeishuContactSync().catch((err) =>
      logger.error("cron.feishu_contact_sync.failed", {
        module: "cron",
        action: "runFeishuContactSync",
        error: err,
      }),
    );
  },
  { timezone: CRON_TIMEZONE },
);

cron.schedule(
  "*/2 * * * *",
  () => {
    runNotificationOutboxDrain().catch((err) =>
      logger.error("cron.notification_outbox_drain.failed", {
        module: "cron",
        action: "runNotificationOutboxDrain",
        error: err,
      }),
    );
  },
  { timezone: CRON_TIMEZONE },
);

cron.schedule(
  "*/10 * * * *",
  () => {
    runProgressDaily().catch((err) =>
      logger.error("cron.progress_reminders.failed", {
        module: "cron",
        action: "runProgressDaily",
        error: err,
      }),
    );
    runProcurementBudgetScan().catch((err) =>
      logger.error("cron.procurement_budget_scan.failed", {
        module: "cron",
        action: "runProcurementBudgetScan",
        error: err,
      }),
    );
  },
  { timezone: CRON_TIMEZONE },
);

cron.schedule(
  "0 9 * * *",
  () => {
    runProcurementDaily().catch((err) =>
      logger.error("cron.procurement_daily.failed", {
        module: "cron",
        action: "runProcurementDaily",
        error: err,
      }),
    );
  },
  { timezone: CRON_TIMEZONE },
);

cron.schedule(
  PROGRESS_DAILY_SUMMARY_CHECK_CRON,
  () => {
    runProgressDailySummary().catch((err) =>
      logger.error("cron.progress_daily_summary.failed", {
        module: "cron",
        action: "runProgressDailySummary",
        error: err,
      }),
    );
  },
  { timezone: CRON_TIMEZONE },
);

logger.info("cron.started", {
  module: "cron",
  action: "startup",
  timezone: CRON_TIMEZONE,
  contactSyncCron: CONTACT_SYNC_CRON,
  notificationOutboxCron: "*/2 * * * *",
  progressReminderCron: "*/10 * * * *",
  progressDailySummaryCheckCron: PROGRESS_DAILY_SUMMARY_CHECK_CRON,
  procurementBudgetCron: "*/10 * * * *",
  procurementDailyCron: "0 9 * * *",
  notificationDeliveryDisabled:
    process.env.NOTIFICATION_DELIVERY_DISABLED === "true",
});
