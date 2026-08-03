import { prisma } from "@/lib/prisma";
import { scanSegmentTransitions } from "@/lib/project-management/application/segment-service";

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

export async function runLockedProjectManagementDaily<T>(callback: () => Promise<T>) {
  return withProjectManagementCronLock("daily-maintenance", callback);
}
