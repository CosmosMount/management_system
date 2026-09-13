export const NOTIFICATION_OUTBOX_CRON = "*/5 * * * * *";
export const DEFAULT_CONTACT_SYNC_CRON = "30 8 * * *";
export const UPLOAD_CLEANUP_CRON = "*/10 * * * *";
export const PROCUREMENT_BUDGET_CRON = "*/10 * * * *";
export const PROJECT_MANAGEMENT_DAILY_CRON = "* * * * *";
export const PROCUREMENT_DAILY_CRON = "0 9 * * *";
export const CRON_TIMEZONE = "Asia/Shanghai";

export type CronJobHandlers = {
  runFeishuContactSync: () => Promise<unknown>;
  runNotificationOutboxDrainWithoutOverlap: () => Promise<unknown>;
  runUploadCleanupDrain: () => Promise<unknown>;
  runProcurementBudgetScan: () => Promise<unknown>;
  runProjectManagementDailyMaintenance: () => Promise<unknown>;
  runProcurementDaily: () => Promise<unknown>;
};

export type CronJobDefinition = {
  name: keyof CronJobHandlers;
  schedule: string;
  timezone: typeof CRON_TIMEZONE;
  failureEvent: string;
  failureAction: string;
  startupField: string;
  run: () => Promise<unknown>;
};

export function createCronJobDefinitions(
  handlers: CronJobHandlers,
  contactSyncCron = DEFAULT_CONTACT_SYNC_CRON,
): CronJobDefinition[] {
  const definition = (
    name: keyof CronJobHandlers,
    schedule: string,
    failureEvent: string,
    startupField: string,
    failureAction: string = name,
  ): CronJobDefinition => ({
    name,
    schedule,
    timezone: CRON_TIMEZONE,
    failureEvent,
    failureAction,
    startupField,
    run: handlers[name],
  });
  return [
    definition(
      "runFeishuContactSync",
      contactSyncCron,
      "cron.feishu_contact_sync.failed",
      "contactSyncCron",
    ),
    definition(
      "runNotificationOutboxDrainWithoutOverlap",
      NOTIFICATION_OUTBOX_CRON,
      "cron.notification_outbox_drain.failed",
      "notificationOutboxCron",
      "runNotificationOutboxDrain",
    ),
    definition(
      "runUploadCleanupDrain",
      UPLOAD_CLEANUP_CRON,
      "cron.upload_cleanup.failed",
      "uploadCleanupCron",
    ),
    definition(
      "runProcurementBudgetScan",
      PROCUREMENT_BUDGET_CRON,
      "cron.procurement_budget_scan.failed",
      "procurementBudgetCron",
    ),
    definition(
      "runProjectManagementDailyMaintenance",
      PROJECT_MANAGEMENT_DAILY_CRON,
      "cron.project_management_daily.failed",
      "projectManagementDailyCron",
    ),
    definition(
      "runProcurementDaily",
      PROCUREMENT_DAILY_CRON,
      "cron.procurement_daily.failed",
      "procurementDailyCron",
    ),
  ];
}

export function registerCronJobs(
  definitions: CronJobDefinition[],
  schedule: (
    expression: string,
    callback: () => void,
    options: { timezone: string },
  ) => unknown,
  onError: (definition: CronJobDefinition, error: unknown) => void,
) {
  return definitions.map((definition) =>
    schedule(
      definition.schedule,
      () => {
        void Promise.resolve()
          .then(definition.run)
          .catch((error: unknown) => onError(definition, error));
      },
      { timezone: definition.timezone },
    ),
  );
}

export function createNonOverlappingCronRunner(
  run: () => Promise<void>,
  onOverlap: () => void,
) {
  let running = false;

  return async (): Promise<boolean> => {
    if (running) {
      onOverlap();
      return false;
    }

    running = true;
    try {
      await run();
      return true;
    } finally {
      running = false;
    }
  };
}
