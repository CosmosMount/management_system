import "dotenv/config";
import cron from "node-cron";
import { OrderStatus } from "@prisma/client";
import { sendFeishuDailySummary } from "../lib/feishu";
import { runProcurementStaleReminders } from "../lib/procurement-reminders";
import { runProcurementBudgetAlerts } from "../lib/procurement-budget-alerts";
import { syncFeishuContactUsers } from "../lib/feishu-user-sync";
import { drainNotificationOutbox } from "../lib/notification-outbox";
import {
  runFullResourceConflictCron,
  runIncrementalResourceConflictCron,
  runLockedProjectManagementDaily,
  runSegmentTransitionCron,
} from "../lib/project-management/application/cron-service";
import {
  runMilestoneDeadlineScan,
  runProjectManagementIntegrityScan,
  runProjectManagementNotificationRetention,
} from "../lib/project-management/application/maintenance-service";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

const CONTACT_SYNC_CRON = process.env.FEISHU_CONTACT_SYNC_CRON ?? "30 8 * * *";
const CRON_TIMEZONE = "Asia/Shanghai";
let contactSyncRunning = false;
let budgetScanRunning = false;
let segmentTransitionScanRunning = false;
let resourceConflictScanRunning = false;
let projectManagementDailyRunning = false;

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

async function runProjectManagementSegmentTransitionScan() {
  if (segmentTransitionScanRunning) {
    logger.warn("cron.project_management_segment_transitions.skipped_running", {
      module: "cron",
      action: "runProjectManagementSegmentTransitionScan",
      result: "skipped",
    });
    return;
  }

  segmentTransitionScanRunning = true;
  try {
    const locked = await runSegmentTransitionCron();
    if (!locked.acquired) {
      logger.warn("cron.project_management_segment_transitions.skipped_database_lock", {
        module: "cron",
        action: "runProjectManagementSegmentTransitionScan",
        result: "skipped",
      });
      return;
    }
    const result = locked.result;
    if (result.pendingConfirmationCount > 0 || result.inProgressCount > 0) {
      logger.info("cron.project_management_segment_transitions.completed", {
        module: "cron",
        action: "runProjectManagementSegmentTransitionScan",
        ...result,
      });
    }
  } finally {
    segmentTransitionScanRunning = false;
  }
}

async function runProjectManagementResourceConflictScan() {
  if (resourceConflictScanRunning) {
    logger.warn("cron.project_management_resource_conflicts.skipped_running", {
      module: "cron",
      action: "runProjectManagementResourceConflictScan",
      result: "skipped",
    });
    return;
  }

  resourceConflictScanRunning = true;
  try {
    const locked = await runIncrementalResourceConflictCron();
    if (!locked.acquired) {
      logger.warn("cron.project_management_resource_conflicts.skipped_database_lock", {
        module: "cron",
        action: "runProjectManagementResourceConflictScan",
        result: "skipped",
      });
      return;
    }
    const result = locked.result;
    if (
      result.createdCount > 0 ||
      result.reopenedCount > 0 ||
      result.resolvedCount > 0
    ) {
      logger.info("cron.project_management_resource_conflicts.completed", {
        module: "cron",
        action: "runProjectManagementResourceConflictScan",
        scannedPersonCount: result.scannedPersonCount,
        detectedCount: result.detectedCount,
        createdCount: result.createdCount,
        reopenedCount: result.reopenedCount,
        resolvedCount: result.resolvedCount,
      });
    }
  } finally {
    resourceConflictScanRunning = false;
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
      const [deadlines, retention, integrity] = await Promise.all([
        runMilestoneDeadlineScan(),
        runProjectManagementNotificationRetention(),
        runProjectManagementIntegrityScan(),
      ]);
      return { deadlines, retention, integrity };
    });
    if (!locked.acquired) {
      logger.warn("cron.project_management_daily.skipped_database_lock", {
        module: "cron",
        action: "runProjectManagementDailyMaintenance",
        result: "skipped",
      });
      return;
    }
    const { deadlines, retention, integrity } = locked.result;
    logger.info("cron.project_management_daily.completed", {
      module: "cron",
      action: "runProjectManagementDailyMaintenance",
      ...deadlines,
      ...retention,
      integrityViolationCount: integrity.violationCount,
    });
  } finally {
    projectManagementDailyRunning = false;
  }
}

async function runProjectManagementFullResourceConflictScan() {
  const locked = await runFullResourceConflictCron();
  if (!locked.acquired) {
    logger.warn("cron.project_management_resource_conflicts_full.skipped_database_lock", {
      module: "cron",
      action: "runProjectManagementFullResourceConflictScan",
      result: "skipped",
    });
    return;
  }
  const logContext = {
    module: "cron",
    action: "runProjectManagementFullResourceConflictScan",
    scannedPersonCount: locked.result.scannedPersonCount,
    succeededPersonCount: locked.result.succeededPersonCount,
    failedPersonCount: locked.result.failedPersonCount,
    failureCodes: [...new Set(locked.result.failures.map((failure) => failure.code))],
    detectedCount: locked.result.detectedCount,
    createdCount: locked.result.createdCount,
    reopenedCount: locked.result.reopenedCount,
    resolvedCount: locked.result.resolvedCount,
  };
  if (locked.result.failedPersonCount > 0) {
    logger.error(
      "cron.project_management_resource_conflicts_full.partial_failure",
      logContext,
    );
    return;
  }
  logger.info(
    "cron.project_management_resource_conflicts_full.completed",
    logContext,
  );
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
  "*/10 * * * *",
  () => {
    runProjectManagementSegmentTransitionScan().catch((err) =>
      logger.error("cron.project_management_segment_transitions.failed", {
        module: "cron",
        action: "runProjectManagementSegmentTransitionScan",
        error: err,
      }),
    );
  },
  { timezone: CRON_TIMEZONE },
);

cron.schedule(
  "*/15 * * * *",
  () => {
    runProjectManagementResourceConflictScan().catch((err) =>
      logger.error("cron.project_management_resource_conflicts.failed", {
        module: "cron",
        action: "runProjectManagementResourceConflictScan",
        error: err,
      }),
    );
  },
  { timezone: CRON_TIMEZONE },
);

cron.schedule(
  // Keep the daily full scan off the */15 incremental schedule. Both jobs
  // intentionally share one advisory lock, so a colliding minute could make
  // the full scan lose the lock and be skipped every day.
  "37 2 * * *",
  () => {
    runProjectManagementFullResourceConflictScan().catch((err) =>
      logger.error("cron.project_management_resource_conflicts_full.failed", {
        module: "cron",
        action: "runProjectManagementFullResourceConflictScan",
        error: err,
      }),
    );
  },
  { timezone: CRON_TIMEZONE },
);

cron.schedule(
  "15 8 * * *",
  () => {
    runProjectManagementDailyMaintenance().catch((err) =>
      logger.error("cron.project_management_daily.failed", {
        module: "cron",
        action: "runProjectManagementDailyMaintenance",
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

logger.info("cron.started", {
  module: "cron",
  action: "startup",
  timezone: CRON_TIMEZONE,
  contactSyncCron: CONTACT_SYNC_CRON,
  notificationOutboxCron: "*/2 * * * *",
  procurementBudgetCron: "*/10 * * * *",
  projectManagementSegmentTransitionsCron: "*/10 * * * *",
  projectManagementResourceConflictsCron: "*/15 * * * *",
  projectManagementResourceConflictsFullCron: "37 2 * * *",
  projectManagementDailyCron: "15 8 * * *",
  procurementDailyCron: "0 9 * * *",
  notificationDeliveryDisabled:
    process.env.NOTIFICATION_DELIVERY_DISABLED === "true",
});
