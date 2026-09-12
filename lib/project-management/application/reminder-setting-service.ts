import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import { isSystemAdministrator } from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { ProjectManagementAuthorizationError } from "@/lib/project-management/authorization";

const reminderKindSchema = z.enum([
  "MILESTONE_DUE",
  "MILESTONE_OVERDUE",
  "TASK_ACTIVATION_OVERDUE",
  "TASK_APPROVAL_PENDING",
]);
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "提醒时间格式不正确");
const settingInputSchema = z.object({
  kind: reminderKindSchema,
  timeOfDay: timeSchema,
  enabled: z.boolean().optional().default(true),
  timezone: z.string().min(1).max(64).optional().default("Asia/Shanghai"),
  sortOrder: z.number().int().min(0).max(100000).optional().default(0),
});
const idSchema = z.object({ id: z.string().uuid() });

function assertAdmin(actor: ProjectManagementActor) {
  if (!isSystemAdministrator(actor)) {
    throw new ProjectManagementAuthorizationError("project.update", "global_administrator_required");
  }
}

export async function listReminderSettings(actor: ProjectManagementActor) {
  assertAdmin(actor);
  return prisma.projectManagementReminderSetting.findMany({
    orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { timeOfDay: "asc" }],
  });
}

export async function createReminderSetting(actor: ProjectManagementActor, input: unknown) {
  assertAdmin(actor);
  const parsed = settingInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const setting = await tx.projectManagementReminderSetting.create({
      data: { ...parsed, createdByAccountId: actor.accountId, updatedByAccountId: actor.accountId },
    });
    await createDomainAuditEventTx(tx, {
      actorAccountId: actor.accountId,
      actorPersonId: actor.personId,
      action: "pm.reminder_setting.created",
      entityType: "ProjectManagementReminderSetting",
      entityId: setting.id,
      before: null,
      after: { kind: setting.kind, timeOfDay: setting.timeOfDay, enabled: setting.enabled, timezone: setting.timezone },
    });
    return setting;
  });
}

export async function updateReminderSetting(actor: ProjectManagementActor, input: unknown) {
  assertAdmin(actor);
  const parsed = idSchema.merge(settingInputSchema.partial()).parse(input);
  return prisma.$transaction(async (tx) => {
    const previous = await tx.projectManagementReminderSetting.findUniqueOrThrow({ where: { id: parsed.id } });
    const setting = await tx.projectManagementReminderSetting.update({
      where: { id: parsed.id },
      data: { ...parsed, id: undefined, updatedByAccountId: actor.accountId },
    });
    await createDomainAuditEventTx(tx, {
      actorAccountId: actor.accountId, actorPersonId: actor.personId,
      action: "pm.reminder_setting.updated", entityType: "ProjectManagementReminderSetting", entityId: setting.id,
      before: { kind: previous.kind, timeOfDay: previous.timeOfDay, enabled: previous.enabled, timezone: previous.timezone },
      after: { kind: setting.kind, timeOfDay: setting.timeOfDay, enabled: setting.enabled, timezone: setting.timezone },
    });
    return setting;
  });
}

export async function deleteReminderSetting(actor: ProjectManagementActor, input: unknown) {
  assertAdmin(actor);
  const parsed = idSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const previous = await tx.projectManagementReminderSetting.delete({ where: { id: parsed.id } });
    await createDomainAuditEventTx(tx, {
      actorAccountId: actor.accountId, actorPersonId: actor.personId,
      action: "pm.reminder_setting.deleted", entityType: "ProjectManagementReminderSetting", entityId: previous.id,
      before: { kind: previous.kind, timeOfDay: previous.timeOfDay, enabled: previous.enabled, timezone: previous.timezone }, after: null,
    });
    return { id: previous.id };
  });
}
