import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { notFoundError } from "@/lib/project-management/application/errors";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { getNotificationReadableWhere, notificationReadWhere } from "@/lib/project-management/queries/notification-queries";

const idSchema = z.string().trim().uuid("对象 ID 格式不正确");

export const markInAppNotificationReadInputSchema = z.object({
  notificationId: idSchema,
});

export const markAllInAppNotificationsReadInputSchema = z.object({
  category: z
    .enum([
      "TASK",
      "MILESTONE",
      "REVIEW",
      "REVISION",
      "WORK_SEGMENT",
      "ACCOUNT_SECURITY",
    ])
    .optional(),
});

export async function markInAppNotificationRead(
  actor: ProjectManagementActor,
  input: unknown,
) {
  const parsed = markInAppNotificationReadInputSchema.parse(input);
  const result = await prisma.inAppNotification.updateMany({
    where: await notificationReadWhere(actor, parsed.notificationId),
    data: { readAt: new Date() },
  });
  if (result.count === 0) throw notFoundError();
  return { updatedCount: result.count };
}

export async function markAllInAppNotificationsRead(
  actor: ProjectManagementActor,
  input: unknown,
) {
  const parsed = markAllInAppNotificationsReadInputSchema.parse(input ?? {});
  const result = await prisma.inAppNotification.updateMany({
    where: {
      AND: [
        await getNotificationReadableWhere(actor),
        { readAt: null },
        parsed.category ? { category: parsed.category } : {},
      ],
    },
    data: { readAt: new Date() },
  });
  return { updatedCount: result.count };
}
