import "dotenv/config";
import cron from "node-cron";
import { OrderStatus } from "@prisma/client";
import {
  createCronJobDefinitions,
  createNonOverlappingCronRunner,
  DEFAULT_CONTACT_SYNC_CRON,
  registerCronJobs,
} from "./cron-schedule";
import { sendFeishuDailySummary } from "../lib/feishu";
import { runProcurementStaleReminders } from "../lib/procurement-reminders";
import { runProcurementBudgetAlerts } from "../lib/procurement-budget-alerts";
import { syncFeishuContactUsers } from "../lib/feishu-user-sync";
import { drainNotificationOutbox } from "../lib/notification-delivery";
import {
  runLockedProjectManagementDaily,
} from "../lib/project-management/application/cron-service";
import {
  runProjectManagementIntegrityScan,
  runProjectManagementNotificationRetention,
  runConfiguredProjectManagementReminders,
} from "../lib/project-management/application/maintenance-service";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import {
  drainUploadCleanupTasks,
  reconcileStaleUploadArtifacts,
} from "../lib/upload-cleanup";

const CONTACT_SYNC_CRON =
  process.env.FEISHU_CONTACT_SYNC_CRON ?? DEFAULT_CONTACT_SYNC_CRON;
let contactSyncRunning = false;
let budgetScanRunning = false;
let projectManagementDailyRunning = false;
let projectManagementRemindersRunning = false;

async function runProcurementDailySummary() {
  const ordersByStatusRows = await prisma.purchaseOrder.groupBy({
    by: ["status"],
    where: {
      status: { notIn: [OrderStatus.COMPLETED, OrderStatus.REJECTED] },
    },
    _count: { _all: true },
  });

  const ordersByStatus: Partial<Record<OrderStatus, number>> = {};
  let openOrderCount = 0;
  for (const row of ordersByStatusRows) {
    ordersByStatus[row.status] = row._count._all;
    openOrderCount += row._count._all;
  }

  await sendFeishuDailySummary(ordersByStatus);

  logger.info("cron.procurement_daily_summary.completed", {
    module: "cron",
    action: "runProcurementDailySummary",
    openOrderCount,
  });
}

async function runProcurementDailyReminders() {
  const remindedCount = await runProcurementStaleReminders();
  logger.info("cron.procurement_daily_reminders.completed", {
    module: "cron",
    action: "runProcurementDailyReminders",
    remindedCount,
  });
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

const runNotificationOutboxDrainWithoutOverlap = createNonOverlappingCronRunner(
  runNotificationOutboxDrain,
  () =>
    logger.warn("cron.notification_outbox_drain.skipped_running", {
      module: "cron",
      action: "runNotificationOutboxDrain",
      result: "skipped",
    }),
);

async function runUploadCleanupDrain() {
  const [tasks, artifacts] = await Promise.all([
    drainUploadCleanupTasks(50),
    reconcileStaleUploadArtifacts({ limit: 100 }),
  ]);
  if (
    tasks.cleaned > 0 ||
    tasks.failed > 0 ||
    artifacts.removed > 0 ||
    artifacts.restored > 0 ||
    artifacts.failed > 0
  ) {
    logger.info("cron.upload_cleanup.completed", {
      module: "cron",
      action: "runUploadCleanupDrain",
      tasks,
      artifacts,
    });
  }
}

async function runProjectManagementDailyMaintenance() {
  if (projectManagementDailyRunning) {
    logger.warn("cron.project_management_daily.skipped_running", {
      module: "cron",
      action: "runProjectManagementDailyMaintenance",
      result: "skipped",
    });
    return;
  }
  projectManagementDailyRunning = true;
  try {
    const locked = await runLockedProjectManagementDaily(async () => {
      const [retention, integrity] = await Promise.all([
        runProjectManagementNotificationRetention(),
        runProjectManagementIntegrityScan(),
      ]);
      return { retention, integrity };
    });
    if (!locked.acquired) {
      logger.warn("cron.project_management_daily.skipped_database_lock", {
        module: "cron",
        action: "runProjectManagementDailyMaintenance",
        result: "skipped",
      });
      return;
    }
    const { retention, integrity } = locked.result;
    logger.info("cron.project_management_daily.completed", {
      module: "cron",
      action: "runProjectManagementDailyMaintenance",
      ...retention,
      integrityViolationCount: integrity.violationCount,
    });
  } finally {
    projectManagementDailyRunning = false;
  }
}

async function runProjectManagementScheduledReminders() {
  if (projectManagementRemindersRunning) {
    logger.warn("cron.project_management_reminders.skipped_running", {
      module: "cron",
      action: "runProjectManagementScheduledReminders",
      result: "skipped",
    });
    return;
  }
  projectManagementRemindersRunning = true;
  try {
    const result = await runConfiguredProjectManagementReminders();
    logger.info("cron.project_management_reminders.completed", {
      module: "cron",
      action: "runProjectManagementScheduledReminders",
      ...result,
    });
  } finally {
    projectManagementRemindersRunning = false;
  }
}

const cronJobs = createCronJobDefinitions(
  {
    runFeishuContactSync,
    runNotificationOutboxDrainWithoutOverlap,
    runUploadCleanupDrain,
    runProcurementBudgetScan,
    runProjectManagementScheduledReminders,
    runProjectManagementDailyMaintenance,
    runProcurementDailySummary,
    runProcurementDailyReminders,
  },
  CONTACT_SYNC_CRON,
);

registerCronJobs(
  cronJobs,
  (expression, callback, options) =>
    cron.schedule(expression, callback, options),
  (definition, error) =>
    logger.error(definition.failureEvent, {
      module: "cron",
      action: definition.failureAction,
      error,
    }),
);

const cronSchedules = Object.fromEntries(
  cronJobs.map((job) => [job.startupField, job.schedule]),
);

logger.info("cron.started", {
  module: "cron",
  action: "startup",
  timezone: cronJobs[0]?.timezone,
  ...cronSchedules,
  notificationDeliveryDisabled:
    process.env.NOTIFICATION_DELIVERY_DISABLED === "true",
});
