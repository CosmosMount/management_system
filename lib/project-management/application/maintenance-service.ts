import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { routes } from "@/lib/routes";
import { runAdminGlobalSummary, ensureAdminGlobalSummarySetting } from "./admin-global-summary-service";
import { ensurePersonalSummarySetting, runPersonalSummary } from "./personal-summary-service";
import { withProjectManagementCronLock } from "./cron-service";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import {
  createProjectManagementEventNotificationsTx,
  recipientsForPersonIdsTx,
} from "@/lib/project-management/application/notification-utils";

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const DAY_MS = 24 * 60 * 60 * 1_000;

export async function runMilestoneDeadlineScan(
  now = new Date(),
  batchSize = 5_000,
  requestedKind?: "milestone_due" | "milestone_overdue",
  execution?: { key: string; actorName: string },
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
      if (requestedKind && requestedKind !== kind) continue;
      const task = milestone.node.task;
      await prisma.$transaction(async (tx) => {
        const recipients = await recipientsForPersonIdsTx(
          tx,
          task.members.map((member) => member.personId),
        );
        await createProjectManagementEventNotificationsTx(tx, {
          actorName: execution?.actorName ?? "系统",
          task,
          kind,
          category: "MILESTONE",
          eventKey: `pm:milestone:${milestone.id}:${kind}:${execution?.key ?? localDate}`,
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

export async function runConfiguredProjectManagementReminders(now = new Date()) {
  const localTime = new Intl.DateTimeFormat("en-GB", { timeZone: SHANGHAI_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const localDate = shanghaiDate(now);
  const settings = await ensureDefaultReminderSettings();
  const matched = settings.filter((setting) => setting.enabled && setting.timezone === SHANGHAI_TIME_ZONE && setting.timeOfDay <= localTime);
  for (const setting of matched) {
    if (setting.kind === "PERSONAL_SUMMARY") {
      try {
        await runPersonalSummary({ now, slotKey: `${localDate}:${setting.timeOfDay}` });
      } catch (error) {
        logger.error("pm.personal_summary.schedule_retry", { error, module: "project-management" });
      }
      continue;
    }
    if (setting.kind === "ADMIN_GLOBAL_SUMMARY") {
      try {
        await runAdminGlobalSummary({ now, slotKey: `${localDate}:${setting.timeOfDay}` });
      } catch (error) {
        logger.error("pm.admin_global_summary.schedule_retry", { error, module: "project-management" });
      }
      continue;
    }
    const slotKey = `scheduled:${setting.kind}:${localDate}:${setting.id}:${setting.timeOfDay}`;
    try {
      await withProjectManagementCronLock(`reminder:${setting.kind}`, async () => {
        if (await prisma.domainAuditEvent.findFirst({ where: { action: "pm.reminder.executed", entityId: slotKey } })) return;
        if (setting.kind === "MILESTONE_DUE") await runMilestoneDeadlineScan(now, 5_000, "milestone_due", { key: slotKey, actorName: "系统" });
        if (setting.kind === "MILESTONE_OVERDUE") await runMilestoneDeadlineScan(now, 5_000, "milestone_overdue", { key: slotKey, actorName: "系统" });
        if (setting.kind === "TASK_ACTIVATION_OVERDUE") await runTaskActivationOverdueScan(now, slotKey, setting.id);
        if (setting.kind === "TASK_APPROVAL_PENDING") await runTaskApprovalPendingScan(slotKey, setting.id);
        await prisma.$transaction((tx) => createDomainAuditEventTx(tx, {
          actorAccountId: null, actorPersonId: null, action: "pm.reminder.executed",
          entityType: "ProjectManagementReminderSetting", entityId: slotKey,
          before: null, after: { kind: setting.kind, trigger: "SCHEDULED", status: "SUCCEEDED" },
        }));
      });
    } catch (error) {
      logger.error("pm.reminder.schedule_retry", { error, module: "project-management", kind: setting.kind });
    }
  }
  return { localDate, matched: matched.length };
}

async function ensureDefaultReminderSettings() {
  await ensureAdminGlobalSummarySetting();
  await ensurePersonalSummarySetting();
  const defaults = [["MILESTONE_DUE", "08:15"], ["MILESTONE_OVERDUE", "08:15"], ["TASK_ACTIVATION_OVERDUE", "08:30"], ["TASK_APPROVAL_PENDING", "09:00"]] as const;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pm:reminders:initialize'))`;
    if (await tx.domainAuditEvent.findFirst({ where: { action: "pm.reminders.initialized" } })) return;
    const existing = await tx.projectManagementReminderSetting.count({ where: { kind: { in: defaults.map(([kind]) => kind) } } });
    const edited = await tx.domainAuditEvent.findFirst({ where: { action: { in: ["pm.reminder_setting.created", "pm.reminder_setting.updated", "pm.reminder_setting.deleted"] } } });
    if (!existing && !edited) {
      const account = await tx.account.findFirst({ where: { person: { is: { status: "ACTIVE" } }, systemRoles: { some: { role: "SUPER_ADMINISTRATOR", team: "", techGroup: "", revokedAt: null } } }, select: { id: true } });
      if (!account) return;
      await tx.projectManagementReminderSetting.createMany({ skipDuplicates: true, data: defaults.map(([kind, timeOfDay], sortOrder) => ({ kind, timeOfDay, sortOrder, createdByAccountId: account.id, updatedByAccountId: account.id })) });
    }
    await createDomainAuditEventTx(tx, { actorAccountId: null, actorPersonId: null,
      action: "pm.reminders.initialized", entityType: "ProjectManagementReminderSetting", entityId: "defaults",
      before: null, after: { preservedExistingConfiguration: Boolean(existing || edited) },
    });
  });
  return prisma.projectManagementReminderSetting.findMany();
}

export async function runTaskActivationOverdueScan(now: Date, localDate: string, scheduleId: string, actorName = "系统") {
  const tasks = await prisma.task.findMany({ where: { deletedAt: null, status: "DRAFT", currentPlanVersion: { plannedStartAt: { lt: now }, status: "CURRENT" } }, select: { id: true, title: true, status: true, currentPlanVersionId: true, currentPlanVersion: { select: { plannedStartAt: true } }, members: { where: { removedAt: null }, select: { personId: true } } } });
  for (const task of tasks) await prisma.$transaction(async (tx) => {
    const recipients = await recipientsForPersonIdsTx(tx, task.members.map((member) => member.personId));
    await createProjectManagementEventNotificationsTx(tx, { actorName, task, kind: "task_activation_overdue", category: "TASK", eventKey: `pm:task:${task.id}:activation_overdue:${localDate}:${scheduleId}`, title: "任务启动后仍未激活", summary: `任务「${task.title}」已超过计划启动时间，当前仍未激活`, entityType: "Task", entityId: task.id, linkPath: routes.progress.taskDetail(task.id), mandatory: false, recipients, context: { plannedStartAt: task.currentPlanVersion.plannedStartAt?.toISOString() ?? null, timezone: SHANGHAI_TIME_ZONE } });
  });
}

export async function runTaskApprovalPendingScan(localDate: string, scheduleId: string, actorName = "系统") {
  const tasks = await prisma.task.findMany({ where: { deletedAt: null, status: { notIn: ["COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "ARCHIVED"] }, OR: [{ nodes: { some: { deletedAt: null, milestone: { reviews: { some: { result: "PENDING", revokedAt: null } } } } } }, { nodes: { some: { deletedAt: null, revision: { status: "PENDING_APPROVAL" } } } }, { nodes: { some: { deletedAt: null, termination: { reviews: { some: { result: "PENDING" } } } } } }] }, select: { id: true, title: true, status: true, currentPlanVersionId: true, members: { where: { removedAt: null }, select: { personId: true } } } });
  for (const task of tasks) await prisma.$transaction(async (tx) => {
    const recipients = await recipientsForPersonIdsTx(tx, task.members.map((member) => member.personId));
    await createProjectManagementEventNotificationsTx(tx, { actorName, task, kind: "task_approval_pending_daily", category: "REVIEW", eventKey: `pm:task:${task.id}:approval_pending:${localDate}:${scheduleId}`, title: "Task 审批尚未完成", summary: `任务「${task.title}」仍存在未完成的审批事项，请及时处理`, entityType: "Task", entityId: task.id, linkPath: routes.progress.taskDetail(task.id), mandatory: false, recipients, context: { timezone: SHANGHAI_TIME_ZONE } });
  });
}
