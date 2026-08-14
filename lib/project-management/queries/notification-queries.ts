import type { Prisma, ProjectManagementNotificationCategory } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  notificationReadableWhere,
  taskReadableWhere,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { configurableNotificationCategories } from "@/lib/project-management/application/notification-preference-service";
import { projectManagementNotificationPayloadSchema } from "@/lib/project-management/notifications/contract";
import { normalizeProjectManagementNotificationText } from "@/lib/project-management/notifications/user-facing-copy";

const notificationCategoryValues = [
  "TASK",
  "MILESTONE",
  "REVIEW",
  "REVISION",
  "WORK_SEGMENT",
  "ACCOUNT_SECURITY",
] as const satisfies readonly ProjectManagementNotificationCategory[];

const idSchema = z.string().trim().uuid("对象 ID 格式不正确");

export const listInAppNotificationsInputSchema = z.object({
  unreadOnly: z.boolean().optional().default(false),
  category: z.enum(notificationCategoryValues).optional(),
  cursor: idSchema.optional(),
  limit: z
    .number({ message: "分页大小不正确" })
    .int("分页大小不正确")
    .min(1, "分页大小不正确")
    .max(100, "分页大小不能超过 100")
    .optional()
    .default(30),
});

export type InAppNotificationListItem = {
  id: string;
  eventKey: string | null;
  category: ProjectManagementNotificationCategory;
  title: string;
  summary: string;
  entityType: string;
  entityId: string;
  taskId: string | null;
  taskTitle: string | null;
  linkPath: string;
  entityAvailable: boolean;
  readAt: string | null;
  createdAt: string;
};

export type InAppNotificationListResult = {
  items: InAppNotificationListItem[];
  nextCursor: string | null;
};

export async function listInAppNotifications({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input?: unknown;
}): Promise<InAppNotificationListResult> {
  const parsed = listInAppNotificationsInputSchema.parse(input ?? {});
  const rows = await prisma.inAppNotification.findMany({
    where: {
      AND: [
        notificationReadableWhere(actor),
        parsed.unreadOnly ? { readAt: null } : {},
        parsed.category ? { category: parsed.category } : {},
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: parsed.limit + 1,
    ...(parsed.cursor ? { cursor: { id: parsed.cursor }, skip: 1 } : {}),
  });

  const visibleTaskTitles = await visibleTaskTitleMap(
    actor,
    rows.flatMap((row) => (row.taskId ? [row.taskId] : [])),
  );

  return {
    items: rows.slice(0, parsed.limit).map((row) => {
      const taskTitle = row.taskId ? visibleTaskTitles.get(row.taskId) ?? null : null;
      const entityAvailable = !row.taskId || taskTitle !== null;
      const storedPayload = parseStoredNotificationPayload(row.payload);
      const copyOptions = storedPayload
        ? {
            kind: storedPayload.kind,
            taskTitle: storedPayload.taskTitle,
            projectName: storedPayload.projectName,
            actorName: storedPayload.actorName,
            context: storedPayload.context,
          }
        : {};
      return {
        id: row.id,
        eventKey: row.eventKey,
        category: row.category,
        title: normalizeProjectManagementNotificationText(row.title, {
          field: "title",
          ...copyOptions,
        }),
        summary: normalizeProjectManagementNotificationText(row.summary, {
          field: "summary",
          ...copyOptions,
        }),
        entityType: row.entityType,
        entityId: row.entityId,
        taskId: row.taskId,
        taskTitle,
        linkPath: entityAvailable ? row.linkPath : "",
        entityAvailable,
        readAt: row.readAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      };
    }),
    nextCursor: rows.length > parsed.limit ? rows[parsed.limit]?.id ?? null : null,
  };
}

function parseStoredNotificationPayload(
  payload: Prisma.JsonValue,
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const result = projectManagementNotificationPayloadSchema.safeParse(payload);
  return result.success ? result.data : null;
}

export async function getUnreadInAppNotificationCount(
  actor: ProjectManagementActor,
): Promise<number> {
  return prisma.inAppNotification.count({
    where: {
      AND: [notificationReadableWhere(actor), { readAt: null }],
    },
  });
}

export async function getNotificationPreferences(actor: ProjectManagementActor) {
  const rows = await prisma.notificationPreference.findMany({
    where: {
      accountId: actor.accountId,
      category: { in: [...configurableNotificationCategories] },
    },
    select: { category: true, channel: true, enabled: true, updatedAt: true },
  });
  const byKey = new Map(rows.map((row) => [`${row.category}:${row.channel}`, row]));
  return configurableNotificationCategories.map((category) => ({
    category,
    // 站内通知永远启用；数据库记录只用于修复历史数据，不作为禁发开关。
    inAppEnabled: true,
    feishuEnabled: byKey.get(`${category}:FEISHU`)?.enabled ?? true,
    updatedAt:
      byKey.get(`${category}:FEISHU`)?.updatedAt.toISOString() ?? null,
  }));
}

export type NotificationPreferenceItem = Awaited<
  ReturnType<typeof getNotificationPreferences>
>[number];

async function visibleTaskTitleMap(
  actor: ProjectManagementActor,
  taskIds: string[],
): Promise<Map<string, string>> {
  const uniqueTaskIds = [...new Set(taskIds)];
  if (uniqueTaskIds.length === 0) return new Map();
  const rows = await prisma.task.findMany({
    where: {
      AND: [{ id: { in: uniqueTaskIds } }, taskReadableWhere(actor)],
    },
    select: { id: true, title: true },
  });
  return new Map(rows.map((task) => [task.id, task.title]));
}

export function notificationReadWhere(
  actor: ProjectManagementActor,
  notificationId: string,
): Prisma.InAppNotificationWhereInput {
  return {
    AND: [{ id: notificationId }, notificationReadableWhere(actor)],
  };
}
