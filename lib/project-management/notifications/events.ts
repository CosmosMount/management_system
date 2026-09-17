import type {
  ProjectManagementNotificationCategory,
  ProjectManagementNotificationChannel,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import { prisma } from "@/lib/prisma";
import { enqueueNotificationTx } from "@/lib/notification-outbox";
import { attachAggregatedNotificationRecipientsTx } from "@/lib/notification-outbox/aggregation-enqueue";
import {
  isProjectManagementNotificationAggregationEligible,
  projectManagementNotificationAggregationWindowSeconds,
} from "@/lib/project-management/notifications/aggregation";
import {
  botKindForPayload,
  PROJECT_MANAGEMENT_NOTIFICATION_OUTBOX_CHANNEL,
  PROJECT_MANAGEMENT_NOTIFICATION_PAYLOAD_VERSION,
  RETIRED_SEGMENT_NOTIFICATION_KIND,
  RETIRED_SEGMENT_NOTIFICATION_REASON,
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
  projectId?: string | null;
  linkPath?: string;
  payloadVersion?: number;
  payload?: Prisma.InputJsonValue;
};

export async function createInAppNotificationTx(
  tx: Prisma.TransactionClient,
  input: CreateInAppNotificationInput,
): Promise<{ created: boolean }> {
  if (input.category === "WORK_SEGMENT") {
    throw new Error(RETIRED_SEGMENT_NOTIFICATION_REASON);
  }
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
        projectId: input.projectId ?? null,
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
  return enqueuePreparedProjectManagementNotificationTx(tx, {
    eventKey,
    type,
    payload: normalizedPayload,
    botKind: botKind ?? botKindForPayload(normalizedPayload),
  });
}

async function enqueuePreparedProjectManagementNotificationTx(
  tx: Prisma.TransactionClient,
  input: {
    eventKey: string;
    type: ProjectManagementNotificationPayload["kind"];
    payload: ProjectManagementNotificationPayload;
    botKind: FeishuBotKind;
  },
) {
  const recipientOpenIds = [
    ...new Set(
      input.payload.recipientOpenIds
        .map((openId) => openId.trim())
        .filter(Boolean),
    ),
  ];
  const aggregationEligible =
    recipientOpenIds.length > 0 &&
    isProjectManagementNotificationAggregationEligible(input.payload);
  const windowSeconds = aggregationEligible
    ? projectManagementNotificationAggregationWindowSeconds()
    : 0;
  const aggregate = aggregationEligible && windowSeconds > 0;
  const createdAt = new Date();
  const nextRunAt = aggregate
    ? new Date(createdAt.getTime() + windowSeconds * 1000)
    : createdAt;
  const result = await enqueueNotificationTx(tx, {
    eventKey: input.eventKey,
    channel: PROJECT_MANAGEMENT_NOTIFICATION_OUTBOX_CHANNEL,
    botKind: input.botKind,
    type: input.type,
    payload: input.payload,
    deliveryMode: aggregate ? "AGGREGATED" : "DIRECT",
    nextRunAt,
  });
  if (!result.created || !aggregate) return result;

  const outbox = await tx.notificationOutbox.findUniqueOrThrow({
    where: { eventKey: input.eventKey },
    select: { id: true },
  });
  await attachAggregatedNotificationRecipientsTx(tx, {
    outboxId: outbox.id,
    channel: PROJECT_MANAGEMENT_NOTIFICATION_OUTBOX_CHANNEL,
    botKind: input.botKind,
    category: input.payload.category,
    recipientOpenIds,
    windowSeconds,
    createdAt,
  });
  return result;
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
  return prisma.$transaction((tx) =>
    enqueuePreparedProjectManagementNotificationTx(tx, {
      eventKey,
      type,
      payload: normalizedPayload,
      botKind: botKind ?? botKindForPayload(normalizedPayload),
    }),
  );
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
  if (
    normalizedPayload.kind === RETIRED_SEGMENT_NOTIFICATION_KIND ||
    normalizedPayload.category === "WORK_SEGMENT"
  ) {
    throw new Error(RETIRED_SEGMENT_NOTIFICATION_REASON);
  }
  if (type !== normalizedPayload.kind) {
    throw new Error("项目管理通知 type 与 payload.kind 不一致");
  }
  const expectedBotKind = botKindForPayload(normalizedPayload);
  if (botKind && botKind !== expectedBotKind) {
    throw new Error("项目管理通知机器人类型与用途不一致");
  }
  return normalizedPayload;
}
