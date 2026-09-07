// @playwright-project node-db
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import cron from "node-cron";
import { withProjectManagementCronLock } from "../lib/project-management/application/cron-service";
import {
  createNonOverlappingCronRunner,
  NOTIFICATION_OUTBOX_CRON,
} from "../scripts/cron-schedule";

test.describe("project management S9 cron operations", () => {
  test("database advisory lock prevents cross-instance overlap", async () => {
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const lockName = `s9-lock-${randomUUID()}`;
    const first = withProjectManagementCronLock(lockName, async () => {
      markStarted();
      await release;
      return "first";
    });
    await started;
    const second = await withProjectManagementCronLock(lockName, async () => "second");
    expect(second).toEqual({ acquired: false, result: null });
    releaseFirst();
    await expect(first).resolves.toEqual({ acquired: true, result: "first" });
    await expect(
      withProjectManagementCronLock(lockName, async () => "third"),
    ).resolves.toEqual({ acquired: true, result: "third" });
  });

  test("notification delivery retains its valid six-field schedule", () => {
    expect(NOTIFICATION_OUTBOX_CRON).toBe("*/5 * * * * *");
    expect(cron.validate(NOTIFICATION_OUTBOX_CRON)).toBe(true);
  });

  test("retired segment transitions no longer expose a cron schedule", async () => {
    expect(await import("../scripts/cron-schedule")).not.toHaveProperty(
      "PROJECT_MANAGEMENT_SEGMENT_TRANSITIONS_CRON",
    );
  });

  test("in-process cron guard skips overlap and releases after completion", async () => {
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    let runCount = 0;
    let overlapCount = 0;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runner = createNonOverlappingCronRunner(
      async () => {
        runCount += 1;
        if (runCount === 1) {
          markStarted();
          await release;
        }
      },
      () => {
        overlapCount += 1;
      },
    );

    const first = runner();
    await started;
    await expect(runner()).resolves.toBe(false);
    expect(runCount).toBe(1);
    expect(overlapCount).toBe(1);

    releaseFirst();
    await expect(first).resolves.toBe(true);
    await expect(runner()).resolves.toBe(true);
    expect(runCount).toBe(2);
  });
});
