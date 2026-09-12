import { z } from "zod";
import { Prisma, type AdminGlobalSummaryRun } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import { isSystemAdministrator, ProjectManagementAuthorizationError } from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { activeGlobalApprovalAdministratorAccountIdsTx } from "@/lib/project-management/approval-administrators";
import { adminSummaryNotificationPreview, buildAdminSummaryMarkdown } from "@/lib/project-management/admin-summary-markdown";
import { collectSummaryTasksTx, summarizeTasks } from "./summary-collector";
import { createProjectManagementEventNotificationsTx, recipientsForAccountIdsTx } from "./notification-utils";
import { withProjectManagementCronLock } from "./cron-service";
import { notFoundError, stateConflictError } from "./errors";

export async function ensureAdminGlobalSummarySetting() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pm:admin-summary:initialize'))`;
    if (await tx.domainAuditEvent.findFirst({ where: { action: "pm.admin_global_summary.initialized" } })) return;
    const accountIds = await activeGlobalApprovalAdministratorAccountIdsTx(tx);
    if (!accountIds.length) return;
    await tx.projectManagementReminderSetting.upsert({ where: { kind_timeOfDay: { kind: "ADMIN_GLOBAL_SUMMARY", timeOfDay: "09:00" } },
      create: { kind: "ADMIN_GLOBAL_SUMMARY", timeOfDay: "09:00", createdByAccountId: accountIds[0], updatedByAccountId: accountIds[0] }, update: {},
    });
    await createDomainAuditEventTx(tx, { actorAccountId: null, actorPersonId: null, action: "pm.admin_global_summary.initialized",
      entityType: "ProjectManagementReminderSetting", entityId: "ADMIN_GLOBAL_SUMMARY", before: null, after: { timeOfDay: "09:00" } });
  });
}

export async function assertSummaryAdministrator(actor: ProjectManagementActor) {
  if (actor.isActive === false || !isSystemAdministrator(actor) || !(await prisma.account.count({
    where: { id: actor.accountId, person: { is: { id: actor.personId, status: "ACTIVE" } }, systemRoles: { some: {
      role: { in: ["SUPER_ADMINISTRATOR", "PROJECT_ADMINISTRATOR"] }, team: "", techGroup: "", revokedAt: null,
    } } },
  }))) throw new ProjectManagementAuthorizationError("project.update", "global_administrator_required");
}

export async function listAdminGlobalSummaryRuns(actor: ProjectManagementActor) {
  await assertSummaryAdministrator(actor);
  return readAuthorizedSummaryRuns(actor);
}

export async function getAdminGlobalSummaryRun(actor: ProjectManagementActor, input: unknown) {
  await assertSummaryAdministrator(actor);
  const { id } = z.object({ id: z.string().uuid() }).parse(input);
  const run = (await readAuthorizedSummaryRuns(actor, undefined, id))[0];
  if (!run) throw notFoundError();
  return run;
}

async function readAuthorizedSummaryRuns(actor: ProjectManagementActor, eventKey?: string, id?: string) {
  return prisma.$queryRaw<AdminGlobalSummaryRun[]>(Prisma.sql`
    SELECT summary.* FROM "AdminGlobalSummaryRun" summary
    WHERE EXISTS (
      SELECT 1 FROM "Account" account
      JOIN "Person" person ON person."accountId" = account.id AND person.status = 'ACTIVE'
      JOIN "SystemRoleAssignment" role ON role."accountId" = account.id
      WHERE account.id = ${actor.accountId} AND role.role IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR')
        AND role.team = '' AND role."techGroup" = '' AND role."revokedAt" IS NULL
    ) ${eventKey ? Prisma.sql`AND summary."eventKey" = ${eventKey}` : Prisma.empty}
      ${id ? Prisma.sql`AND summary.id = ${id}` : Prisma.empty}
    ORDER BY summary."startedAt" DESC, summary.id DESC LIMIT 20
  `);
}

export async function runAdminGlobalSummaryNow(actor: ProjectManagementActor, input: unknown) {
  await assertSummaryAdministrator(actor);
  const { requestId } = z.object({ requestId: z.string().uuid() }).parse(input);
  return runAdminGlobalSummary({ slotKey: `manual:${actor.accountId}:${requestId}`, actor });
}

const summaryDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short", hour12: false,
});
const dateLabel = (date: Date | null) => date ? summaryDateFormatter.format(date) : "未设置";

export async function runAdminGlobalSummary(input: { now?: Date; slotKey: string; actor?: ProjectManagementActor }) {
  if (input.actor) await assertSummaryAdministrator(input.actor);
  const startedAt = new Date();
  const now = input.now ?? new Date();
  const eventKey = `pm:admin-global-summary:${input.slotKey}`;
  const locked = await withProjectManagementCronLock("admin-global-summary", async () => {
    const previous = input.actor ? (await readAuthorizedSummaryRuns(input.actor, eventKey))[0]
      : await prisma.adminGlobalSummaryRun.findUnique({ where: { eventKey } });
    if (previous?.status === "SUCCEEDED") return previous;
    try {
      return await prisma.$transaction(async (tx) => {
        const administratorIds = await activeGlobalApprovalAdministratorAccountIdsTx(tx);
        if (!administratorIds.length) throw stateConflictError("没有可接收总结的有效系统管理员");
        if (input.actor && !administratorIds.includes(input.actor.accountId)) throw new ProjectManagementAuthorizationError("project.update", "global_administrator_required");
        const operator = input.actor ? await tx.person.findUnique({ where: { id: input.actor.personId }, select: { displayName: true } }) : null;
        const actorName = operator?.displayName ?? "系统";
        const { rows, approvalCount } = summarizeTasks(await collectSummaryTasksTx(tx), now);
        const markdown = buildAdminSummaryMarkdown(rows, dateLabel(now), approvalCount, actorName);
        const run = await tx.adminGlobalSummaryRun.upsert({ where: { eventKey },
          create: { eventKey, trigger: input.actor ? "MANUAL" : "SCHEDULED", actorAccountId: input.actor?.accountId, status: "SUCCEEDED", startedAt, finishedAt: new Date(), markdown },
          update: { status: "SUCCEEDED", startedAt, finishedAt: new Date(), markdown, errorMessage: null },
        });
        const recipients = await recipientsForAccountIdsTx(tx, administratorIds);
        const result = await createProjectManagementEventNotificationsTx(tx, {
          actorName, kind: "project_management_global_summary_daily", category: "PROJECT", eventKey: `${eventKey}:part:1`,
          title: "管理员全局进度总结", summary: adminSummaryNotificationPreview(markdown), entityType: "AdminGlobalSummaryRun", entityId: run.id,
          linkPath: `/progress/notifications/summaries/${run.id}`, mandatory: false, recipients,
          context: { timezone: "Asia/Shanghai", generatedAt: now.toISOString() },
        });
        const recipientCount = result.recipientCount;
        await createDomainAuditEventTx(tx, { actorAccountId: input.actor?.accountId ?? null, actorPersonId: input.actor?.personId ?? null,
          action: "pm.admin_global_summary.executed", entityType: "AdminGlobalSummaryRun", entityId: run.id,
          before: null, after: { trigger: run.trigger, recipientCount },
        });
        return tx.adminGlobalSummaryRun.update({ where: { id: run.id }, data: { recipientCount } });
      }, { timeout: 60_000, isolationLevel: "RepeatableRead" });
    } catch (error) {
      if (error instanceof ProjectManagementAuthorizationError) throw error;
      if (input.actor) await assertSummaryAdministrator(input.actor);
      logger.error("pm.admin_global_summary.failed", { error, module: "project-management" });
      const succeeded = await prisma.adminGlobalSummaryRun.findFirst({ where: { eventKey, status: "SUCCEEDED" } });
      if (succeeded) {
        if (!input.actor) return succeeded;
        const authorized = (await readAuthorizedSummaryRuns(input.actor, eventKey))[0];
        if (!authorized) throw new ProjectManagementAuthorizationError("project.update", "global_administrator_required");
        return authorized;
      }
      return prisma.adminGlobalSummaryRun.upsert({ where: { eventKey },
        create: { eventKey, trigger: input.actor ? "MANUAL" : "SCHEDULED", actorAccountId: input.actor?.accountId, status: "FAILED", startedAt, finishedAt: new Date(), errorMessage: "总结生成失败，请重试或联系管理员查看运行日志" },
        update: { status: "FAILED", finishedAt: new Date(), errorMessage: "总结生成失败，请重试或联系管理员查看运行日志" },
      });
    }
  });
  if (!locked.acquired) throw stateConflictError("总结正在执行，请稍后查看执行记录");
  return locked.result;
}
