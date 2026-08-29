import assert from "node:assert/strict";
import test from "node:test";
import {
  createCronJobDefinitions,
  registerCronJobs,
  type CronJobHandlers,
} from "../scripts/cron-schedule";

const expectedJobs = [
  [
    "runFeishuContactSync",
    "45 7 * * *",
    "contactSyncCron",
    "cron.feishu_contact_sync.failed",
    "runFeishuContactSync",
  ],
  [
    "runNotificationOutboxDrainWithoutOverlap",
    "*/5 * * * * *",
    "notificationOutboxCron",
    "cron.notification_outbox_drain.failed",
    "runNotificationOutboxDrain",
  ],
  [
    "runUploadCleanupDrain",
    "*/10 * * * *",
    "uploadCleanupCron",
    "cron.upload_cleanup.failed",
    "runUploadCleanupDrain",
  ],
  [
    "runProcurementBudgetScan",
    "*/10 * * * *",
    "procurementBudgetCron",
    "cron.procurement_budget_scan.failed",
    "runProcurementBudgetScan",
  ],
  [
    "runProjectManagementSegmentTransitionScan",
    "*/5 * * * * *",
    "projectManagementSegmentTransitionsCron",
    "cron.project_management_segment_transitions.failed",
    "runProjectManagementSegmentTransitionScan",
  ],
  [
    "runProjectManagementDailyMaintenance",
    "15 8 * * *",
    "projectManagementDailyCron",
    "cron.project_management_daily.failed",
    "runProjectManagementDailyMaintenance",
  ],
  [
    "runProcurementDaily",
    "0 9 * * *",
    "procurementDailyCron",
    "cron.procurement_daily.failed",
    "runProcurementDaily",
  ],
] as const;

test("seven cron schedules register the matching handler in Asia/Shanghai", async () => {
  const calls: string[] = [];
  const handlers = Object.fromEntries(
    expectedJobs.map(([name]) => [name, async () => void calls.push(name)]),
  ) as unknown as CronJobHandlers;
  assert.equal(
    createCronJobDefinitions(handlers)[0]?.schedule,
    "30 8 * * *",
  );
  const definitions = createCronJobDefinitions(handlers, "45 7 * * *");
  const scheduled: Array<{
    expression: string;
    callback: () => void;
    timezone: string;
  }> = [];
  registerCronJobs(
    definitions,
    (expression, callback, options) => {
      scheduled.push({ expression, callback, timezone: options.timezone });
    },
    () => assert.fail("successful handler must not report an error"),
  );

  assert.deepEqual(
    definitions.map((job) => [
      job.name,
      job.schedule,
      job.startupField,
      job.failureEvent,
      job.failureAction,
    ]),
    expectedJobs,
  );
  assert.equal(scheduled.length, 7);
  assert.ok(definitions.every((job) => job.timezone === "Asia/Shanghai"));
  assert.ok(scheduled.every((job) => job.timezone === "Asia/Shanghai"));
  for (const job of scheduled) job.callback();
  await flushPromises();
  assert.deepEqual(calls, expectedJobs.map(([name]) => name));
});

test("cron callbacks report every exact failure event and action", async () => {
  const calls: string[] = [];
  const handlers = Object.fromEntries(
    expectedJobs.map(([name]) => [
      name,
      async () => {
        calls.push(name);
        throw new Error(`${name} failed`);
      },
    ]),
  ) as unknown as CronJobHandlers;
  const definitions = createCronJobDefinitions(handlers);
  const callbacks: Array<() => void> = [];
  const failures: Array<{ event: string; action: string; message: string }> = [];
  registerCronJobs(
    definitions,
    (_expression, callback) => callbacks.push(callback),
    (definition, error) =>
      failures.push({
        event: definition.failureEvent,
        action: definition.failureAction,
        message: error instanceof Error ? error.message : String(error),
      }),
  );

  for (const callback of callbacks) callback();
  await flushPromises();
  assert.deepEqual(calls, expectedJobs.map(([name]) => name));
  assert.deepEqual(
    failures,
    expectedJobs.map(([name, , , event, action]) => ({
      event,
      action,
      message: `${name} failed`,
    })),
  );
});

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
