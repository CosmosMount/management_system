import type {
  ProjectManagementNotificationCategory,
  ProjectManagementNotificationChannel,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import {
  enqueueNotification,
  enqueueNotificationTx,
} from "@/lib/notification-outbox";
import {
  botKindForPayload,
  PROJECT_MANAGEMENT_NOTIFICATION_OUTBOX_CHANNEL,
  PROJECT_MANAGEMENT_NOTIFICATION_PAYLOAD_VERSION,
  projectManagementNotificationPayloadSchema,
  type ProjectManagementNotificationPayload,
} from "@/lib/project-management/notifications/contract";

export {
  botKindForPayload,
  PROJECT_MANAGEMENT_NOTIFICATION_OUTBOX_CHANNEL,
  PROJECT_MANAGEMENT_NOTIFICATION_PAYLOAD_VERSION,
  projectManagementNotificationPayloadSchema,
  type ProjectManagementNotificationPayload,
} from "@/lib/project-management/notifications/contract";

export type CreateInAppNotificationInput = {
  eventKey?: string | null;
  recipientAccountId: string;
  category: ProjectManagementNotificationCategory;
  title: string;
  summary?: string;
  entityType: string;
  entityId: string;
  taskId?: string | null;
  linkPath?: string;
  payloadVersion?: number;
  payload?: Prisma.InputJsonValue;
};

export async function createInAppNotificationTx(
  tx: Prisma.TransactionClient,
  input: CreateInAppNotificationInput,
): Promise<{ created: boolean }> {
  const result = await tx.inAppNotification.createMany({
    data: [
      {
        eventKey: input.eventKey ?? null,
        recipientAccountId: input.recipientAccountId,
        category: input.category,
        title: input.title,
        summary: input.summary ?? "",
        entityType: input.entityType,
        entityId: input.entityId,
        taskId: input.taskId ?? null,
        linkPath: input.linkPath ?? "",
        payloadVersion:
          input.payloadVersion ??
          PROJECT_MANAGEMENT_NOTIFICATION_PAYLOAD_VERSION,
        payload: input.payload ?? {},
      },
    ],
    skipDuplicates: true,
  });
  return { created: result.count > 0 };
}

export async function enqueueProjectManagementNotificationTx(
  tx: Prisma.TransactionClient,
  {
    eventKey,
    type,
    payload,
    botKind,
  }: {
    eventKey: string;
    type: ProjectManagementNotificationPayload["kind"];
    payload: ProjectManagementNotificationPayload;
  botKind?: FeishuBotKind;
  },
) {
  const normalizedPayload = parseProjectManagementNotificationInput({
    type,
    payload,
    botKind,
  });
  return enqueueNotificationTx(tx, {
    eventKey,
    channel: PROJECT_MANAGEMENT_NOTIFICATION_OUTBOX_CHANNEL,
    botKind: botKind ?? botKindForPayload(normalizedPayload),
    type,
    payload: normalizedPayload,
  });
}

export async function enqueueProjectManagementNotification({
  eventKey,
  type,
  payload,
  botKind,
}: {
  eventKey: string;
  type: ProjectManagementNotificationPayload["kind"];
  payload: ProjectManagementNotificationPayload;
  botKind?: FeishuBotKind;
}) {
  const normalizedPayload = parseProjectManagementNotificationInput({
    type,
    payload,
    botKind,
  });
  return enqueueNotification({
    eventKey,
    channel: PROJECT_MANAGEMENT_NOTIFICATION_OUTBOX_CHANNEL,
    botKind: botKind ?? botKindForPayload(normalizedPayload),
    type,
    payload: normalizedPayload,
  });
}

export function notificationChannelEnabledByDefault(
  channel: ProjectManagementNotificationChannel,
): boolean {
  return channel === "IN_APP" || channel === "FEISHU";
}

function parseProjectManagementNotificationInput({
  type,
  payload,
  botKind,
}: {
  type: ProjectManagementNotificationPayload["kind"];
  payload: ProjectManagementNotificationPayload;
  botKind?: FeishuBotKind;
}): ProjectManagementNotificationPayload {
  const normalizedPayload = projectManagementNotificationPayloadSchema.parse(payload);
  if (type !== normalizedPayload.kind) {
    throw new Error("项目管理通知 type 与 payload.kind 不一致");
  }
  const expectedBotKind = botKindForPayload(normalizedPayload);
  if (botKind && botKind !== expectedBotKind) {
    throw new Error("项目管理通知机器人类型与用途不一致");
  }
  return normalizedPayload;
}
