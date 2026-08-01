import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import {
  runFullResourceConflictCron,
  runIncrementalResourceConflictCron,
  withProjectManagementCronLock,
} from "../lib/project-management/application/cron-service";

test.describe("project management S9 cron operations", () => {
  test("daily full conflict scan does not collide with the incremental schedule", () => {
    const source = readFileSync(path.join(process.cwd(), "scripts/cron.ts"), "utf8");
    expect(source).toContain('"*/15 * * * *"');
    expect(source).toContain('"37 2 * * *"');
    expect(source).not.toContain('"30 2 * * *"');
  });

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

  test("incremental checkpoint advances only after a successful scan and full scan is recorded", async () => {
    const account = await prisma.account.create({
      data: {
        projectAccessStatus: "ACTIVE",
        person: { create: { displayName: "S9 checkpoint person", status: "ACTIVE" } },
      },
      include: { person: true },
    });
    if (!account.person) throw new Error("S9 person missing");
    const now = new Date();
    const segment = await prisma.workSegment.create({
      data: {
        personId: account.person.id,
        type: "PLANNED",
        status: "PLANNED",
        startAt: new Date(now.getTime() + 60 * 60_000),
        endAt: new Date(now.getTime() + 2 * 60 * 60_000),
        content: "S9 incremental segment",
        allocation: 50,
        createdByAccountId: account.id,
      },
    });
    const overlapping = await prisma.workSegment.create({
      data: {
        personId: account.person.id,
        type: "PLANNED",
        status: "PLANNED",
        startAt: new Date(now.getTime() + 90 * 60_000),
        endAt: new Date(now.getTime() + 150 * 60_000),
        content: "S9 incremental overlapping segment",
        allocation: 70,
        createdByAccountId: account.id,
      },
    });
    const firstScanAt = new Date(
      Math.max(Date.now(), segment.updatedAt.getTime(), overlapping.updatedAt.getTime()) + 1,
    );
    // Full-suite query-limit fixtures leave more than one 2,000-row batch in
    // this shared runner database. Anchor this scenario directly before its
    // own writes so it tests checkpoint behavior rather than unrelated backlog.
    const firstChangedAt = Math.min(
      segment.updatedAt.getTime(),
      overlapping.updatedAt.getTime(),
    );
    await prisma.projectManagementScanCheckpoint.upsert({
      where: { key: "resource-conflict-incremental-v1" },
      create: {
        key: "resource-conflict-incremental-v1",
        cursor: {
          updatedAt: new Date(firstChangedAt - 1).toISOString(),
          id: "",
        },
      },
      update: {
        cursor: {
          updatedAt: new Date(firstChangedAt - 1).toISOString(),
          id: "",
        },
        lastError: "",
      },
    });
    const first = await runIncrementalResourceConflictCron(firstScanAt);
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error("incremental lock unexpectedly unavailable");
    expect(first.result.changedSegmentCount).toBeGreaterThanOrEqual(1);
    expect(first.result.checkpoint.updatedAt).toBe(
      [segment, overlapping]
        .sort(
          (left, right) =>
            left.updatedAt.getTime() - right.updatedAt.getTime() ||
            left.id.localeCompare(right.id),
        )
        .at(-1)?.updatedAt.toISOString(),
    );
    expect(
      await prisma.resourceConflict.count({
        where: { personId: account.person.id, status: "OPEN" },
      }),
    ).toBeGreaterThan(0);
    const checkpoint = await prisma.projectManagementScanCheckpoint.findUniqueOrThrow({
      where: { key: "resource-conflict-incremental-v1" },
    });
    expect(checkpoint.lastCompletedAt).not.toBeNull();
    expect(checkpoint.lastError).toBe("");

    await prisma.workSegment.update({
      where: { id: overlapping.id },
      data: { deletedAt: new Date() },
    });
    const second = await runIncrementalResourceConflictCron(
      new Date(firstScanAt.getTime() + 1_000),
    );
    expect(second.acquired && second.result.changedSegmentCount).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.resourceConflict.count({
        where: { personId: account.person.id, status: "RESOLVED" },
      }),
    ).toBeGreaterThan(0);
    const third = await runIncrementalResourceConflictCron(
      new Date(firstScanAt.getTime() + 2_000),
    );
    expect(third.acquired && third.result.changedSegmentCount).toBe(0);
    const full = await runFullResourceConflictCron(
      new Date(firstScanAt.getTime() + 3_000),
    );
    expect(full.acquired).toBe(true);
    if (!full.acquired) throw new Error("full scan lock unexpectedly unavailable");
    const afterFull = await prisma.projectManagementScanCheckpoint.findUniqueOrThrow({
      where: { key: "resource-conflict-incremental-v1" },
    });
    expect(afterFull.lastFullScanAt).not.toBeNull();
    expect(afterFull.lockVersion).toBeGreaterThan(checkpoint.lockVersion);
    if (full.result.failedPersonCount > 0) {
      expect(afterFull.lastError).toMatch(/^完整冲突扫描有 \d+ 个人员失败：/);
      expect(full.result.succeededPersonCount).toBeGreaterThan(0);
    } else {
      expect(afterFull.lastError).toBe("");
    }
  });
});
