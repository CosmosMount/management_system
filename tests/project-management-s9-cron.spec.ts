import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { withProjectManagementCronLock } from "../lib/project-management/application/cron-service";

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

});
