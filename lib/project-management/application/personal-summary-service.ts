import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import { ProjectManagementAuthorizationError } from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { activeGlobalApprovalAdministratorAccountIdsTx } from "@/lib/project-management/approval-administrators";
import { adminSummaryNotificationPreview, buildAdminSummaryMarkdown } from "@/lib/project-management/admin-summary-markdown";
import { assertSummaryAdministrator } from "./admin-global-summary-service";
import { collectSummaryTasksTx, summarizeTasks, summaryDateLabel } from "./summary-collector";
import { createProjectManagementEventNotificationsTx, recipientsForAccountIdsTx } from "./notification-utils";
import { withProjectManagementCronLock } from "./cron-service";
import { notFoundError, stateConflictError } from "./errors";

export async function ensurePersonalSummarySetting() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pm:personal-summary:initialize'))`;
    if (await tx.domainAuditEvent.findFirst({ where: { action: "pm.personal_summary.initialized" } })) return;
    const accountIds = await activeGlobalApprovalAdministratorAccountIdsTx(tx);
    if (!accountIds.length) return;
    await tx.projectManagementReminderSetting.upsert({
      where: { kind_timeOfDay: { kind: "PERSONAL_SUMMARY", timeOfDay: "09:00" } },
      create: { kind: "PERSONAL_SUMMARY", timeOfDay: "09:00", createdByAccountId: accountIds[0], updatedByAccountId: accountIds[0] }, update: {},
    });
    await createDomainAuditEventTx(tx, {
      actorAccountId: null, actorPersonId: null, action: "pm.personal_summary.initialized",
      entityType: "ProjectManagementReminderSetting", entityId: "PERSONAL_SUMMARY", before: null, after: { timeOfDay: "09:00" },
    });
  });
}

export async function getPersonalSummary(actor: ProjectManagementActor, input: unknown) {
  const { id } = z.object({ id: z.string().uuid() }).parse(input);
  if (actor.isActive === false) throw notFoundError();
  const summary = await prisma.personalSummary.findFirst({
    where: { id, accountId: actor.accountId, account: { person: { is: { id: actor.personId, status: "ACTIVE" } } },
      OR: [{ requiresApprovalAdministrator: false }, { account: { systemRoles: { some: {
        role: { in: ["SUPER_ADMINISTRATOR", "PROJECT_ADMINISTRATOR"] }, team: "", techGroup: "", revokedAt: null,
      } } } }],
    },
    select: { id: true, markdown: true, run: { select: { startedAt: true, status: true } } },
  });
  if (!summary) throw notFoundError();
  return summary;
}

export async function listPersonalSummaryRuns(actor: ProjectManagementActor) {
  await assertSummaryAdministrator(actor);
  return prisma.personalSummaryRun.findMany({ orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 20 });
}

export async function runPersonalSummary(input: { now?: Date; slotKey: string; actor?: ProjectManagementActor }) {
  if (input.actor) await assertSummaryAdministrator(input.actor);
  const slotKey = z.string().trim().min(1).max(200).parse(input.slotKey);
  const now = z.date().parse(input.now ?? new Date());
  const startedAt = new Date();
  const eventKey = `pm:personal-summary:${slotKey}`;
  const locked = await withProjectManagementCronLock("personal-summary", async () => {
    const previous = await prisma.personalSummaryRun.findUnique({ where: { eventKey } });
    if (previous?.status === "SUCCEEDED") return previous;
    try {
      return await prisma.$transaction(async (tx) => {
        const administratorIds = await activeGlobalApprovalAdministratorAccountIdsTx(tx);
        if (input.actor && !administratorIds.includes(input.actor.accountId)) throw new ProjectManagementAuthorizationError("project.update", "global_administrator_required");
        const people = await tx.person.findMany({
          where: { status: "ACTIVE", accountId: { not: null } },
          select: { id: true, accountId: true, displayName: true }, orderBy: { id: "asc" },
        });
        const actorName = input.actor ? people.find((person) => person.accountId === input.actor?.accountId)?.displayName ?? "系统" : "系统";
        const tasks = await collectSummaryTasksTx(tx);
        const run = await tx.personalSummaryRun.upsert({
          where: { eventKey },
          create: { eventKey, trigger: input.actor ? "MANUAL" : "SCHEDULED", actorAccountId: input.actor?.accountId, status: "SUCCEEDED", startedAt },
          update: { status: "SUCCEEDED", startedAt, errorMessage: null },
        });
        let recipientCount = 0;
        for (const person of people) {
          if (!person.accountId) continue;
          const { rows, approvalCount } = summarizeTasks(tasks, now, {
            accountId: person.accountId, personId: person.id, canApprove: administratorIds.includes(person.accountId),
          });
          const markdown = buildAdminSummaryMarkdown(rows, summaryDateLabel(now), approvalCount, actorName, "个人进度总结");
          const summary = await tx.personalSummary.create({ data: {
            runId: run.id, accountId: person.accountId, markdown, requiresApprovalAdministrator: approvalCount > 0,
          } });
          const result = await createProjectManagementEventNotificationsTx(tx, {
            actorName, kind: "project_management_personal_summary_daily", category: "PROJECT",
            eventKey: `${eventKey}:account:${person.accountId}`, title: "个人进度总结",
            summary: adminSummaryNotificationPreview(markdown), entityType: "PersonalSummary", entityId: summary.id,
            linkPath: `/progress/notifications/personal-summaries/${summary.id}`, mandatory: false,
            recipients: await recipientsForAccountIdsTx(tx, [person.accountId]),
            context: { timezone: "Asia/Shanghai", generatedAt: now.toISOString() },
          });
          recipientCount += result.recipientCount;
        }
        await createDomainAuditEventTx(tx, {
          actorAccountId: input.actor?.accountId ?? null, actorPersonId: input.actor?.personId ?? null,
          action: "pm.personal_summary.executed", entityType: "PersonalSummaryRun", entityId: run.id,
          before: null, after: { trigger: run.trigger, recipientCount },
        });
        return tx.personalSummaryRun.update({ where: { id: run.id }, data: { recipientCount, finishedAt: new Date() } });
      }, { timeout: 60_000, isolationLevel: "RepeatableRead" });
    } catch (error) {
      if (error instanceof ProjectManagementAuthorizationError) throw error;
      if (input.actor) await assertSummaryAdministrator(input.actor);
      logger.error("pm.personal_summary.failed", { error, module: "project-management" });
      const succeeded = await prisma.personalSummaryRun.findFirst({ where: { eventKey, status: "SUCCEEDED" } });
      if (succeeded) return succeeded;
      await prisma.personalSummaryRun.upsert({
        where: { eventKey },
        create: { eventKey, trigger: input.actor ? "MANUAL" : "SCHEDULED", actorAccountId: input.actor?.accountId,
          status: "FAILED", startedAt, finishedAt: new Date(), errorMessage: "总结生成失败，请重试或联系管理员查看运行日志" },
        update: { status: "FAILED", finishedAt: new Date(), errorMessage: "总结生成失败，请重试或联系管理员查看运行日志" },
      });
      throw stateConflictError("总结生成失败，请重试或联系管理员查看运行日志");
    }
  });
  if (!locked.acquired) throw stateConflictError("总结正在执行，请稍后查看执行记录");
  return locked.result;
}
