import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  scanResourceConflicts,
  scanResourceConflictsForDefaultWindow,
} from "@/lib/project-management/application/conflict-service";
import { scanSegmentTransitions } from "@/lib/project-management/application/segment-service";

const INCREMENTAL_CHECKPOINT_KEY = "resource-conflict-incremental-v1";
const INCREMENTAL_BATCH_SIZE = 2_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

type IncrementalCursor = { updatedAt: string; id: string };

export type CronLockResult<T> =
  | { acquired: true; result: T }
  | { acquired: false; result: null };

export async function withProjectManagementCronLock<T>(
  lockName: string,
  callback: () => Promise<T>,
): Promise<CronLockResult<T>> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(
          hashtext('management_system:project-management:cron'),
          hashtext(${lockName})
        ) AS acquired
      `;
      if (!rows[0]?.acquired) return { acquired: false, result: null };
      return { acquired: true, result: await callback() };
    },
    { maxWait: 5_000, timeout: 15 * 60_000 },
  );
}

export function runSegmentTransitionCron(now = new Date()) {
  return withProjectManagementCronLock("segment-transitions", () =>
    scanSegmentTransitions(now),
  );
}

export async function runIncrementalResourceConflictCron(now = new Date()) {
  return withProjectManagementCronLock("resource-conflicts", async () => {
    const checkpoint = await prisma.projectManagementScanCheckpoint.upsert({
      where: { key: INCREMENTAL_CHECKPOINT_KEY },
      create: {
        key: INCREMENTAL_CHECKPOINT_KEY,
        cursor: emptyCursor(now),
        lastStartedAt: now,
      },
      update: { lastStartedAt: now, lastError: "" },
    });
    const cursor = parseIncrementalCursor(checkpoint.cursor, now);
    try {
      const changed = await prisma.workSegment.findMany({
        where: {
          OR: [
            { updatedAt: { gt: new Date(cursor.updatedAt) } },
            { updatedAt: new Date(cursor.updatedAt), id: { gt: cursor.id } },
          ],
        },
        select: { id: true, personId: true, updatedAt: true },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: INCREMENTAL_BATCH_SIZE,
      });
      const personIds = [...new Set(changed.map((segment) => segment.personId))];
      const scan = personIds.length
        ? await scanResourceConflicts({
            personIds,
            startAt: new Date(now.getTime() - 7 * DAY_MS),
            endAt: new Date(now.getTime() + 90 * DAY_MS),
          })
        : emptyConflictScanResult();
      if (scan.failedPersonCount > 0) {
        throw new Error(
          `增量冲突扫描有 ${scan.failedPersonCount} 个人员失败，checkpoint 未推进`,
        );
      }
      const last = changed.at(-1);
      const nextCursor: IncrementalCursor = last
        ? { updatedAt: last.updatedAt.toISOString(), id: last.id }
        : cursor;
      await prisma.projectManagementScanCheckpoint.update({
        where: { key: INCREMENTAL_CHECKPOINT_KEY },
        data: {
          cursor: nextCursor,
          lastCompletedAt: new Date(),
          lastError: "",
          lockVersion: { increment: 1 },
        },
      });
      return {
        changedSegmentCount: changed.length,
        hasMore: changed.length === INCREMENTAL_BATCH_SIZE,
        checkpoint: nextCursor,
        ...scan,
      };
    } catch (error) {
      await prisma.projectManagementScanCheckpoint.update({
        where: { key: INCREMENTAL_CHECKPOINT_KEY },
        data: {
          lastError: safeErrorMessage(error),
          lockVersion: { increment: 1 },
        },
      });
      throw error;
    }
  });
}

export async function runFullResourceConflictCron(now = new Date()) {
  return withProjectManagementCronLock("resource-conflicts", async () => {
    const result = await scanResourceConflictsForDefaultWindow(now);
    const completedAt = new Date();
    const lastError = result.failedPersonCount > 0
      ? `完整冲突扫描有 ${result.failedPersonCount} 个人员失败：${[
          ...new Set(result.failures.map((failure) => failure.code)),
        ].join(",")}`.slice(0, 1_000)
      : "";
    await prisma.projectManagementScanCheckpoint.upsert({
      where: { key: INCREMENTAL_CHECKPOINT_KEY },
      create: {
        key: INCREMENTAL_CHECKPOINT_KEY,
        cursor: emptyCursor(now),
        lastStartedAt: now,
        lastCompletedAt: completedAt,
        lastFullScanAt: completedAt,
        lastError,
      },
      update: {
        lastFullScanAt: completedAt,
        lastError,
        lockVersion: { increment: 1 },
      },
    });
    return result;
  });
}

export async function runLockedProjectManagementDaily<T>(callback: () => Promise<T>) {
  return withProjectManagementCronLock("daily-maintenance", callback);
}

function parseIncrementalCursor(value: Prisma.JsonValue, now: Date): IncrementalCursor {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const updatedAt = value.updatedAt;
    const id = value.id;
    if (
      typeof updatedAt === "string" &&
      Number.isFinite(Date.parse(updatedAt)) &&
      typeof id === "string"
    ) {
      return { updatedAt, id };
    }
  }
  logger.warn("project_management.cron.checkpoint_invalid", {
    module: "project-management",
    action: "parseIncrementalCursor",
    result: "skipped",
  });
  return emptyCursor(now);
}

function emptyCursor(now: Date): IncrementalCursor {
  return { updatedAt: new Date(now.getTime() - 5 * 60_000).toISOString(), id: "" };
}

function emptyConflictScanResult() {
  return {
    scannedPersonCount: 0,
    succeededPersonCount: 0,
    failedPersonCount: 0,
    detectedCount: 0,
    createdCount: 0,
    reopenedCount: 0,
    resolvedCount: 0,
    unchangedCount: 0,
    results: [],
    failures: [],
  };
}

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_000);
}
