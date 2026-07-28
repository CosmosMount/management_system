import type { NotificationOutbox } from "@prisma/client";
import {
  PROJECT_MANAGEMENT_NOTIFICATION_OUTBOX_CHANNEL,
  projectManagementNotificationPayloadSchema,
  type ProjectManagementNotificationPayload,
} from "@/lib/project-management/notifications/contract";
import type {
  NotificationChannelAdapter,
  NotificationDeliveryTarget,
} from "@/lib/notification-channels/types";
import { NonRetryableNotificationError } from "@/lib/notification-channels/types";

function parseProjectManagementNotification(row: NotificationOutbox) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.payload);
  } catch {
    throw new NonRetryableNotificationError(
      "项目管理通知 payload 不是有效 JSON",
    );
  }
  const result = projectManagementNotificationPayloadSchema.safeParse(decoded);
  if (!result.success) {
    throw new NonRetryableNotificationError(
      "项目管理通知 payload 不符合持久化契约",
    );
  }
  const payload = result.data;
  if (row.type !== payload.kind) {
    throw new NonRetryableNotificationError(
      `项目管理通知元数据不一致：type=${row.type}，payload.kind=${payload.kind}`,
    );
  }
  const expectedBotKind =
    payload.purpose === "approval_request" ? "approval" : "notification";
  if (row.botKind !== expectedBotKind) {
    throw new NonRetryableNotificationError(
      `项目管理通知机器人类型无效：${payload.kind} 应使用 ${expectedBotKind}`,
    );
  }
  return payload;
}

export const projectManagementNotificationChannel: NotificationChannelAdapter = {
  channel: PROJECT_MANAGEMENT_NOTIFICATION_OUTBOX_CHANNEL,
  async resolveRecipientPlan(row) {
    const payload = parseProjectManagementNotification(row);
    return {
      supported: true,
      openIds: uniqueOpenIds(payload),
      directOpenIds: uniqueOpenIds(payload),
      requiresDirectRecipient: payload.purpose === "approval_request",
    };
  },
  async sendToRecipient(
    row,
    recipientOpenId,
  ): Promise<NotificationDeliveryTarget> {
    void recipientOpenId;
    parseProjectManagementNotification(row);
    throw new NonRetryableNotificationError("项目管理飞书通知投递将在 P6 启用");
  },
  async sendComposite(row) {
    parseProjectManagementNotification(row);
    throw new NonRetryableNotificationError("项目管理飞书通知投递将在 P6 启用");
  },
};

function uniqueOpenIds(payload: ProjectManagementNotificationPayload): string[] {
  return [
    ...new Set(
      payload.recipientOpenIds.map((openId) => openId.trim()).filter(Boolean),
    ),
  ];
}
