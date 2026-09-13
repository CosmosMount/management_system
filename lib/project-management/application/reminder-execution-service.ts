import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { assertSummaryAdministrator, runAdminGlobalSummaryNow } from "./admin-global-summary-service";
import { runPersonalSummary } from "./personal-summary-service";
import { withProjectManagementCronLock } from "./cron-service";
import { stateConflictError } from "./errors";
import { runMilestoneDeadlineScan, runTaskActivationOverdueScan, runTaskApprovalPendingScan } from "./maintenance-service";

const executionSchema = z.object({
  kind: z.enum(["MILESTONE_DUE", "MILESTONE_OVERDUE", "TASK_ACTIVATION_OVERDUE", "TASK_APPROVAL_PENDING", "ADMIN_GLOBAL_SUMMARY", "PERSONAL_SUMMARY"]),
  requestId: z.string().uuid(),
});

export async function runReminderNow(actor: ProjectManagementActor, input: unknown) {
  await assertSummaryAdministrator(actor);
  const { kind, requestId } = executionSchema.parse(input);
  if (kind === "ADMIN_GLOBAL_SUMMARY") {
    const run = await runAdminGlobalSummaryNow(actor, { requestId });
    if (run.status !== "SUCCEEDED") throw stateConflictError("总结生成失败，请重试或查看执行记录");
    return { kind, status: "SUCCEEDED" as const };
  }
  const key = `manual:${actor.accountId}:${kind}:${requestId}`;
  const locked = await withProjectManagementCronLock(`reminder:${kind}`, async () => {
    await assertSummaryAdministrator(actor);
    const previous = await prisma.domainAuditEvent.findFirst({ where: { action: "pm.reminder.executed", entityId: key } });
    if (previous) return { kind, status: "SUCCEEDED" as const };
    const actorName = (await prisma.person.findUnique({ where: { id: actor.personId }, select: { displayName: true } }))?.displayName ?? "管理员";
    const now = new Date();
    if (kind === "PERSONAL_SUMMARY") await runPersonalSummary({ now, slotKey: key, actor });
    if (kind === "MILESTONE_DUE") await runMilestoneDeadlineScan(now, 5_000, "milestone_due", { key, actorName });
    if (kind === "MILESTONE_OVERDUE") await runMilestoneDeadlineScan(now, 5_000, "milestone_overdue", { key, actorName });
    if (kind === "TASK_ACTIVATION_OVERDUE") await runTaskActivationOverdueScan(now, key, requestId, actorName);
    if (kind === "TASK_APPROVAL_PENDING") await runTaskApprovalPendingScan(key, requestId, actorName);
    await prisma.$transaction((tx) => createDomainAuditEventTx(tx, {
      actorAccountId: actor.accountId, actorPersonId: actor.personId,
      action: "pm.reminder.executed", entityType: "ProjectManagementReminderSetting", entityId: key,
      before: null, after: { kind, trigger: "MANUAL", status: "SUCCEEDED" },
    }));
    return { kind, status: "SUCCEEDED" as const };
  });
  if (!locked.acquired) throw stateConflictError("该提醒正在执行，请稍后重试");
  return locked.result;
}
