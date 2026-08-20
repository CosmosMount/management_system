import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import type { ProjectManagementActor } from "@/lib/project-management/identity";

export const configurableNotificationCategories = [
  "TASK",
  "MILESTONE",
  "REVIEW",
  "REVISION",
  "WORK_SEGMENT",
] as const;

const updatePreferenceSchema = z.object({
  category: z.enum(configurableNotificationCategories),
  feishuEnabled: z.boolean(),
});

export async function updateNotificationPreference(
  actor: ProjectManagementActor,
  input: unknown,
) {
  const parsed = updatePreferenceSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const previous = await tx.notificationPreference.findUnique({
      where: {
        accountId_category_channel: {
          accountId: refreshedActor.accountId,
          category: parsed.category,
          channel: "FEISHU",
        },
      },
    });
    const preference = await tx.notificationPreference.upsert({
      where: {
        accountId_category_channel: {
          accountId: refreshedActor.accountId,
          category: parsed.category,
          channel: "FEISHU",
        },
      },
      create: {
        accountId: refreshedActor.accountId,
        category: parsed.category,
        channel: "FEISHU",
        enabled: parsed.feishuEnabled,
      },
      update: { enabled: parsed.feishuEnabled },
    });
    // 站内通知是审计与待办兜底，历史异常数据也在修改偏好时恢复为启用。
    await tx.notificationPreference.upsert({
      where: {
        accountId_category_channel: {
          accountId: refreshedActor.accountId,
          category: parsed.category,
          channel: "IN_APP",
        },
      },
      create: {
        accountId: refreshedActor.accountId,
        category: parsed.category,
        channel: "IN_APP",
        enabled: true,
      },
      update: { enabled: true },
    });
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "notification.preference.updated",
      entityType: "NotificationPreference",
      entityId: preference.id,
      before: { category: parsed.category, feishuEnabled: previous?.enabled ?? true },
      after: { category: parsed.category, feishuEnabled: preference.enabled },
    });
    return {
      category: preference.category,
      inAppEnabled: true,
      feishuEnabled: preference.enabled,
      updatedAt: preference.updatedAt.toISOString(),
    };
  });
}
