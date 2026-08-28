import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { routes } from "@/lib/routes";
import {
  createProjectManagementEventNotificationsTx,
  recipientsForPersonIdsTx,
} from "@/lib/project-management/application/notification-utils";

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const DAY_MS = 24 * 60 * 60 * 1_000;

export async function runMilestoneDeadlineScan(
  now = new Date(),
  batchSize = 5_000,
) {
  const localDate = shanghaiDate(now);
  const dayStart = shanghaiDayStart(localDate);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const boundedBatchSize = Math.min(Math.max(Math.trunc(batchSize), 1), 5_000);
  let cursor: string | undefined;
  let scannedCount = 0;
  let dueCount = 0;
  let overdueCount = 0;
  while (true) {
    const milestones = await prisma.milestoneNode.findMany({
      where: {
        completedAt: null,
        node: {
          deletedAt: null,
          status: { in: ["PENDING", "ACTIVE"] },
          task: { status: "ACTIVE", deletedAt: null },
          planVersionEntries: {
            some: { planVersion: { currentForTask: { isNot: null } } },
          },
        },
        expectedCompletedAt: { lt: dayEnd },
      },
      select: {
        id: true,
        nodeId: true,
        goal: true,
        expectedCompletedAt: true,
        node: {
          select: {
            task: {
              select: {
                id: true,
                title: true,
                status: true,
                currentPlanVersionId: true,
                members: {
                  where: { removedAt: null },
                  select: { personId: true },
                },
              },
            },
          },
        },
      },
      orderBy: [{ expectedCompletedAt: "asc" }, { id: "asc" }],
      take: boundedBatchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const milestone of milestones) {
      const overdue = milestone.expectedCompletedAt < dayStart;
      const kind = overdue ? "milestone_overdue" : "milestone_due";
      const task = milestone.node.task;
      await prisma.$transaction(async (tx) => {
        const recipients = await recipientsForPersonIdsTx(
          tx,
          task.members.map((member) => member.personId),
        );
        await createProjectManagementEventNotificationsTx(tx, {
          actorName: "系统",
          task,
          kind,
          category: "MILESTONE",
          eventKey: `pm:milestone:${milestone.id}:${kind}:${localDate}`,
          title: overdue ? "里程碑已逾期" : "里程碑今日到期",
          summary: `${milestone.goal} · 计划完成时间 ${formatShanghaiDateTime(milestone.expectedCompletedAt)}`,
          entityType: "MilestoneNode",
          entityId: milestone.id,
          linkPath: routes.progress.taskDetail(task.id),
          mandatory: overdue,
          recipients,
          context: {
            dueAt: milestone.expectedCompletedAt.toISOString(),
            timezone: SHANGHAI_TIME_ZONE,
          },
        });
      });
      scannedCount += 1;
      if (overdue) overdueCount += 1;
      else dueCount += 1;
    }
    if (milestones.length < boundedBatchSize) break;
    cursor = milestones.at(-1)?.id;
    if (!cursor) break;
  }
  return { localDate, scannedCount, dueCount, overdueCount };
}

export async function runProjectManagementNotificationRetention(
  now = new Date(),
  batchSize = 1_000,
) {
  const boundedBatchSize = Math.min(Math.max(Math.trunc(batchSize), 1), 5_000);
  const readBefore = new Date(now.getTime() - 90 * DAY_MS);
  const terminalOutboxBefore = new Date(now.getTime() - 30 * DAY_MS);
  const staleFailedBefore = new Date(now.getTime() - 180 * DAY_MS);
  const [readRows, outboxRows] = await Promise.all([
    prisma.inAppNotification.findMany({
      where: { readAt: { not: null, lt: readBefore } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: boundedBatchSize,
    }),
    prisma.notificationOutbox.findMany({
      where: {
        channel: "project-management",
        OR: [
          { status: "SENT", sentAt: { lt: terminalOutboxBefore } },
          { status: "FAILED", updatedAt: { lt: staleFailedBefore } },
        ],
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: boundedBatchSize,
    }),
  ]);
  const [inApp, outbox] = await prisma.$transaction([
    prisma.inAppNotification.deleteMany({
      where: { id: { in: readRows.map((row) => row.id) } },
    }),
    prisma.notificationOutbox.deleteMany({
      where: { id: { in: outboxRows.map((row) => row.id) } },
    }),
  ]);
  return { deletedInAppCount: inApp.count, deletedOutboxCount: outbox.count };
}

export async function runProjectManagementIntegrityScan() {
  const [currentPlanMismatch, activeNodeMismatch, currentPlanCardinality] =
    await Promise.all([
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count
        FROM "Task" t
        JOIN "TaskPlanVersion" p ON p.id = t."currentPlanVersionId"
        WHERE t."deletedAt" IS NULL AND p."taskId" <> t.id
      `,
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count
        FROM "Task" t
        JOIN "TaskNode" n ON n.id = t."activeMilestoneNodeId"
        WHERE t."deletedAt" IS NULL AND n."taskId" <> t.id
      `,
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count
        FROM (
          SELECT t.id
          FROM "Task" t
          LEFT JOIN "TaskPlanVersion" p
            ON p."taskId" = t.id AND p.status = 'CURRENT'
          WHERE t."deletedAt" IS NULL
          GROUP BY t.id
          HAVING count(p.id) <> 1
        ) invalid
      `,
    ]);
  const result = {
    currentPlanTaskMismatchCount: Number(currentPlanMismatch[0]?.count ?? 0),
    activeNodeTaskMismatchCount: Number(activeNodeMismatch[0]?.count ?? 0),
    currentPlanCardinalityViolationCount: Number(
      currentPlanCardinality[0]?.count ?? 0,
    ),
  };
  const violationCount = Object.values(result).reduce((sum, count) => sum + count, 0);
  if (violationCount > 0) {
    logger.error("project_management.integrity_scan.violations", {
      module: "project-management",
      action: "runProjectManagementIntegrityScan",
      violationCount,
      ...result,
    });
  }
  return { ...result, violationCount };
}

export function shanghaiDate(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function shanghaiDayStart(localDate: string) {
  return new Date(`${localDate}T00:00:00.000+08:00`);
}

function formatShanghaiDateTime(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
