import type {
  NotificationOutbox,
  NotificationOutboxRecipient,
  Prisma,
} from "@prisma/client";
import { resolveProcurementBotKind } from "@/lib/feishu-bot-routing";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import type { BudgetThresholdPayload, OrderCardPayload } from "@/lib/feishu";
import type {
  FeedbackCreatedNotificationPayload,
  FeedbackReplyNotificationPayload,
  FeedbackStatusNotificationPayload,
} from "@/lib/feishu-feedback";
import type { NotificationContext } from "@/lib/app-origin";
import { getNotificationChannelAdapter } from "@/lib/notification-channels";
import { isNonRetryableNotificationError } from "@/lib/notification-channels/types";
import type { FeedbackOutboxPayload } from "@/lib/notification-channels/feedback";
import type { OrderOutboxPayload } from "@/lib/notification-channels/procurement";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const MAX_ATTEMPTS = 8;
const NOTIFICATION_DELIVERY_DISABLED =
  process.env.NOTIFICATION_DELIVERY_DISABLED === "true";
const RECIPIENT_LOCK_MS = 2 * 60 * 1000;
const FROZEN_NEXT_RUN_AT = new Date("9999-12-31T00:00:00.000Z");

type DrainNotificationOutboxOptions = {
  ignoreDeliveryDisabled?: boolean;
};

export type EnqueueNotificationResult = {
  created: boolean;
};

export async function enqueueNotification({
  eventKey,
  channel,
  botKind = "notification",
  type,
  payload,
}: {
  eventKey: string;
  channel: string;
  botKind?: FeishuBotKind;
  type: string;
  payload: unknown;
}): Promise<EnqueueNotificationResult> {
  const payloadText = JSON.stringify(payload);
  const result = await prisma.notificationOutbox.createMany({
    data: [
      {
        eventKey,
        channel,
        botKind,
        type,
        payload: payloadText,
        status: "PENDING",
        attempts: 0,
        lastError: "",
        nextRunAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });
  return { created: result.count > 0 };
}

export async function enqueueNotificationTx(
  tx: Prisma.TransactionClient,
  {
    eventKey,
    channel,
    botKind = "notification",
    type,
    payload,
  }: {
    eventKey: string;
    channel: string;
    botKind?: FeishuBotKind;
    type: string;
    payload: unknown;
  },
): Promise<EnqueueNotificationResult> {
  const payloadText = JSON.stringify(payload);
  const result = await tx.notificationOutbox.createMany({
    data: [
      {
        eventKey,
        channel,
        botKind,
        type,
        payload: payloadText,
        status: "PENDING",
        attempts: 0,
        lastError: "",
        nextRunAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });
  logger.info("notification.outbox.enqueue_tx.prepared", {
    module: "notification",
    action: "enqueueNotificationTx",
    eventKey,
    channel,
    type,
    botKind,
    created: result.count > 0,
    transactional: true,
    result: "prepared",
  });
  return { created: result.count > 0 };
}

export async function cancelRetryableNotificationOutboxesTx(
  tx: Prisma.TransactionClient,
  eventKeys: string[],
  reason: string,
): Promise<number> {
  if (eventKeys.length === 0) return 0;
  const outboxes = await tx.notificationOutbox.findMany({
    where: {
      eventKey: { in: eventKeys },
      status: { in: ["PENDING", "FAILED", "PROCESSING"] },
    },
    select: { id: true },
  });
  const outboxIds = outboxes.map((item) => item.id);
  if (outboxIds.length === 0) return 0;
  await tx.notificationOutboxRecipient.updateMany({
    where: {
      outboxId: { in: outboxIds },
      status: { in: ["PENDING", "FAILED", "PROCESSING"] },
    },
    data: {
      status: "FAILED",
      attempts: MAX_ATTEMPTS,
      nextRunAt: FROZEN_NEXT_RUN_AT,
      lockedUntil: null,
      lastError: reason,
    },
  });
  const canceled = await tx.notificationOutbox.updateMany({
    where: {
      id: { in: outboxIds },
      status: { in: ["PENDING", "FAILED", "PROCESSING"] },
    },
    data: {
      status: "FAILED",
      attempts: MAX_ATTEMPTS,
      nextRunAt: FROZEN_NEXT_RUN_AT,
      lockedUntil: null,
      lastError: reason,
    },
  });
  return canceled.count;
}

export async function resetNotificationOutboxForRetry({
  id,
  channel,
  type,
}: {
  id: string;
  channel: string;
  type: string;
}) {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.notificationOutbox.updateMany({
      where: {
        id,
        channel,
        type,
        status: "FAILED",
      },
      data: {
        status: "PENDING",
        attempts: 0,
        nextRunAt: new Date(),
        lockedUntil: null,
        lastError: "",
      },
    });
    if (updated.count === 1) {
      await tx.notificationOutboxRecipient.updateMany({
        where: {
          outboxId: id,
          status: { not: "SENT" },
        },
        data: {
          status: "PENDING",
          attempts: 0,
          nextRunAt: new Date(),
          lockedUntil: null,
          lastError: "",
        },
      });
    }
    return updated;
  });
}

export async function enqueueOrderNotification(
  eventKey: string,
  order: OrderCardPayload,
  context?: NotificationContext,
) {
  await enqueueNotification({
    eventKey,
    channel: "procurement",
    botKind: resolveProcurementBotKind(order.status),
    type: "order",
    payload: {
      kind: "order",
      order,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export function orderNotificationEventKey(order: {
  id: string;
  status: string;
  statusEnteredAt: Date;
}): string {
  return `procurement:order:${order.id}:${order.status}:${order.statusEnteredAt.toISOString()}`;
}

export async function enqueueOrderNotificationTx(
  tx: Prisma.TransactionClient,
  eventKey: string,
  order: OrderCardPayload,
  context?: NotificationContext,
) {
  return enqueueNotificationTx(tx, {
    eventKey,
    channel: "procurement",
    botKind: resolveProcurementBotKind(order.status),
    type: "order",
    payload: {
      kind: "order",
      order,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueProcurementRejectedNotification(
  eventKey: string,
  order: OrderCardPayload,
  reason: string,
  rejectedByName: string,
  context?: NotificationContext,
) {
  await enqueueNotification({
    eventKey,
    channel: "procurement",
    botKind: "notification",
    type: "procurement_rejected",
    payload: {
      kind: "procurement_rejected",
      order,
      reason,
      rejectedByName,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueProcurementRejectedNotificationTx(
  tx: Prisma.TransactionClient,
  eventKey: string,
  order: OrderCardPayload,
  reason: string,
  rejectedByName: string,
  context?: NotificationContext,
) {
  return enqueueNotificationTx(tx, {
    eventKey,
    channel: "procurement",
    botKind: "notification",
    type: "procurement_rejected",
    payload: {
      kind: "procurement_rejected",
      order,
      reason,
      rejectedByName,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueApplicantResubmitNotification(
  eventKey: string,
  order: OrderCardPayload,
  reason: string,
  financeName: string,
  context?: NotificationContext,
) {
  await enqueueNotification({
    eventKey,
    channel: "procurement",
    botKind: "notification",
    type: "applicant_resubmit",
    payload: {
      kind: "applicant_resubmit",
      order,
      reason,
      financeName,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueProcurementReturnDraftNotification(
  eventKey: string,
  order: OrderCardPayload,
  reason: string,
  returnedByName: string,
  context?: NotificationContext,
) {
  await enqueueNotification({
    eventKey,
    channel: "procurement",
    botKind: "notification",
    type: "procurement_return_draft",
    payload: {
      kind: "procurement_return_draft",
      order,
      reason,
      returnedByName,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueProcurementReturnDraftNotificationTx(
  tx: Prisma.TransactionClient,
  eventKey: string,
  order: OrderCardPayload,
  reason: string,
  returnedByName: string,
  context?: NotificationContext,
) {
  return enqueueNotificationTx(tx, {
    eventKey,
    channel: "procurement",
    botKind: "notification",
    type: "procurement_return_draft",
    payload: {
      kind: "procurement_return_draft",
      order,
      reason,
      returnedByName,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueBudgetThresholdNotification(
  eventKey: string,
  budget: BudgetThresholdPayload,
  context?: NotificationContext,
) {
  return enqueueNotification({
    eventKey,
    channel: "procurement",
    botKind: "notification",
    type: "budget_threshold",
    payload: {
      kind: "budget_threshold",
      budget,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueFeedbackCreatedNotification(
  eventKey: string,
  payload: FeedbackCreatedNotificationPayload,
  context?: NotificationContext,
) {
  await enqueueNotification({
    eventKey,
    channel: "feedback",
    botKind: "notification",
    type: "created",
    payload: {
      kind: "created",
      payload,
      appOrigin: context?.appOrigin ?? null,
    } satisfies FeedbackOutboxPayload,
  });
}

export async function enqueueFeedbackReplyNotification(
  eventKey: string,
  payload: FeedbackReplyNotificationPayload,
  context?: NotificationContext,
) {
  await enqueueNotification({
    eventKey,
    channel: "feedback",
    botKind: "notification",
    type: "reply",
    payload: {
      kind: "reply",
      payload,
      appOrigin: context?.appOrigin ?? null,
    } satisfies FeedbackOutboxPayload,
  });
}

export async function enqueueFeedbackStatusNotification(
  eventKey: string,
  payload: FeedbackStatusNotificationPayload,
  context?: NotificationContext,
) {
  await enqueueNotification({
    eventKey,
    channel: "feedback",
    botKind: "notification",
    type: "status",
    payload: {
      kind: "status",
      payload,
      appOrigin: context?.appOrigin ?? null,
    } satisfies FeedbackOutboxPayload,
  });
}

export function drainNotificationOutboxSoon(limit = 5) {
  if (NOTIFICATION_DELIVERY_DISABLED) return;
  void drainNotificationOutbox(limit).catch((err) => {
    logger.error("notification.outbox.drain.failed", {
      module: "notification",
      action: "drainNotificationOutboxSoon",
      result: "failure",
      error: err,
    });
  });
}

export async function drainNotificationOutbox(
  limit = 20,
  options: DrainNotificationOutboxOptions = {},
): Promise<number> {
  if (NOTIFICATION_DELIVERY_DISABLED && !options.ignoreDeliveryDisabled) return 0;
  const now = new Date();
  const rows = await prisma.notificationOutbox.findMany({
    where: {
      attempts: { lt: MAX_ATTEMPTS },
      OR: [
        { status: { in: ["PENDING", "FAILED"] }, nextRunAt: { lte: now } },
        { status: "PROCESSING", lockedUntil: { lte: now } },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
  });

  let sent = 0;
  for (const row of rows) {
    const lockedUntil = new Date(Date.now() + RECIPIENT_LOCK_MS);
    const claimed = await prisma.notificationOutbox.updateMany({
      where: {
        id: row.id,
        status: row.status,
        attempts: row.attempts,
      },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        lastError: "",
        lockedUntil,
      },
    });
    if (claimed.count !== 1) continue;

    try {
      const recipientResult = await sendOutboxNotificationByRecipient(row);
      if (recipientResult.supported) {
        if (recipientResult.completed) sent++;
      } else {
        await sendOutboxNotification(row);
        const markedSent = await prisma.notificationOutbox.updateMany({
          where: { id: row.id, status: "PROCESSING" },
          data: {
            status: "SENT",
            sentAt: new Date(),
            lastError: "",
            lockedUntil: null,
          },
        });
        if (markedSent.count === 1) sent++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const nonRetryable = isNonRetryableNotificationError(err);
      const attempts = nonRetryable ? MAX_ATTEMPTS : row.attempts + 1;
      await prisma.notificationOutbox.updateMany({
        where: { id: row.id, status: "PROCESSING" },
        data: {
          status: "FAILED",
          attempts,
          lastError: message.slice(0, 1000),
          nextRunAt: nonRetryable ? FROZEN_NEXT_RUN_AT : nextRetryAt(attempts),
          lockedUntil: null,
        },
      });
    }
  }

  return sent;
}

async function sendOutboxNotificationByRecipient(
  row: NotificationOutbox,
): Promise<{ supported: true; completed: boolean } | { supported: false }> {
  const adapter = getNotificationChannelAdapter(row.channel);
  const plan = await adapter.resolveRecipientPlan(row);
  if (!plan.supported) return { supported: false };

  if (
    plan.requiresDirectRecipient &&
    (plan.directOpenIds ?? plan.openIds)
      .map((id) => id.trim())
      .filter(Boolean).length === 0
  ) {
    await failOutboxWithNoRecipients(row);
    return { supported: true, completed: false };
  }

  await ensureOutboxRecipients(row.id, plan.openIds);
  await adapter.beforeRecipientDelivery?.(row);

  const now = new Date();
  const recipients = await prisma.notificationOutboxRecipient.findMany({
    where: {
      outboxId: row.id,
      attempts: { lt: MAX_ATTEMPTS },
      OR: [
        { status: { in: ["PENDING", "FAILED"] }, nextRunAt: { lte: now } },
        { status: "PROCESSING", lockedUntil: { lte: now } },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  for (const recipient of recipients) {
    await sendOutboxRecipient(row, recipient);
  }

  const summary = await updateOutboxStatusFromRecipients(row.id);
  return { supported: true, completed: summary.completed };
}

async function failOutboxWithNoRecipients(row: NotificationOutbox) {
  const attempts = row.attempts + 1;
  const message =
    "审批通知没有可投递的真实私信收件人，已停止本轮发送；请检查审批角色和用户配置。";
  logger.error("notification.outbox.recipient.empty", {
    module: "notification",
    action: "sendOutboxNotificationByRecipient",
    entityType: "NotificationOutbox",
    entityId: row.id,
    eventKey: row.eventKey,
    channel: row.channel,
    type: row.type,
    botKind: row.botKind,
    attempts,
    result: "failure",
    errorMessage: message,
  });
  await prisma.notificationOutbox.updateMany({
    where: { id: row.id, status: "PROCESSING" },
    data: {
      status: "FAILED",
      lastError: message,
      nextRunAt: nextRetryAt(attempts),
      lockedUntil: null,
    },
  });
}

async function sendOutboxRecipient(
  row: NotificationOutbox,
  recipient: NotificationOutboxRecipient,
) {
  const lockedUntil = new Date(Date.now() + RECIPIENT_LOCK_MS);
  const claimed = await prisma.notificationOutboxRecipient.updateMany({
    where: {
      id: recipient.id,
      status: recipient.status,
      attempts: recipient.attempts,
    },
    data: {
      status: "PROCESSING",
      attempts: { increment: 1 },
      lockedUntil,
      lastError: "",
    },
  });
  if (claimed.count !== 1) return;

  const attempts = recipient.attempts + 1;
  try {
    const target = await getNotificationChannelAdapter(
      row.channel,
    ).sendToRecipient(row, recipient.openId);
    await prisma.notificationOutboxRecipient.updateMany({
      where: { id: recipient.id, status: "PROCESSING" },
      data: {
        status: "SENT",
        receiveId: target?.receiveId ?? recipient.receiveId,
        receiveIdType: target?.receiveIdType ?? recipient.receiveIdType,
        sentAt: new Date(),
        lastError: "",
        lockedUntil: null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const nonRetryable = isNonRetryableNotificationError(err);
    logger.error("notification.outbox.recipient.failed", {
      module: "notification",
      action: "sendOutboxRecipient",
      entityType: "NotificationOutbox",
      entityId: row.id,
      eventKey: row.eventKey,
      channel: row.channel,
      type: row.type,
      botKind: row.botKind,
      recipientOpenId: recipient.openId,
      attempts: nonRetryable ? MAX_ATTEMPTS : attempts,
      result: "failure",
      errorMessage: message,
    });
    await prisma.notificationOutboxRecipient.updateMany({
      where: { id: recipient.id, status: "PROCESSING" },
      data: {
        status: "FAILED",
        attempts: nonRetryable ? MAX_ATTEMPTS : attempts,
        lastError: message.slice(0, 1000),
        nextRunAt: nonRetryable ? FROZEN_NEXT_RUN_AT : nextRetryAt(attempts),
        lockedUntil: null,
      },
    });
  }
}

async function ensureOutboxRecipients(outboxId: string, openIds: string[]) {
  const uniqueOpenIds = [...new Set(openIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueOpenIds.length === 0) return;

  await prisma.notificationOutboxRecipient.createMany({
    data: uniqueOpenIds.map((openId) => ({
      outboxId,
      openId,
      status: "PENDING",
      attempts: 0,
      lastError: "",
      nextRunAt: new Date(),
    })),
    skipDuplicates: true,
  });
}

async function updateOutboxStatusFromRecipients(outboxId: string): Promise<{
  completed: boolean;
}> {
  const recipients = await prisma.notificationOutboxRecipient.findMany({
    where: { outboxId },
    select: {
      status: true,
      attempts: true,
      lastError: true,
      nextRunAt: true,
      lockedUntil: true,
    },
  });

  if (recipients.length === 0 || recipients.every((item) => item.status === "SENT")) {
    await prisma.notificationOutbox.updateMany({
      where: { id: outboxId, status: "PROCESSING" },
      data: {
        status: "SENT",
        sentAt: new Date(),
        lastError: "",
        lockedUntil: null,
      },
    });
    return { completed: true };
  }

  const retryableRecipients = recipients.filter(
    (item) => item.status !== "SENT" && item.attempts < MAX_ATTEMPTS,
  );
  const recipientsExhausted = retryableRecipients.length === 0;
  const now = new Date();
  const nextRunAt =
    (recipientsExhausted
      ? FROZEN_NEXT_RUN_AT
      : retryableRecipients
          .map((item) =>
            item.status === "PROCESSING" &&
            item.lockedUntil &&
            item.lockedUntil > now
              ? item.lockedUntil
              : item.nextRunAt,
          )
          .sort((a, b) => a.getTime() - b.getTime())[0]) ??
    nextRetryAt(MAX_ATTEMPTS);
  const failedCount = recipients.filter((item) => item.status === "FAILED").length;
  const processingCount = recipients.filter(
    (item) => item.status === "PROCESSING",
  ).length;
  const firstError =
    recipients.find((item) => item.lastError.trim().length > 0)?.lastError ?? "";

  await prisma.notificationOutbox.updateMany({
    where: { id: outboxId, status: "PROCESSING" },
    data: {
      status: "FAILED",
      attempts: recipientsExhausted ? MAX_ATTEMPTS : undefined,
      lastError: [
        `收件人发送未全部成功：${failedCount} 个失败，${processingCount} 个处理中`,
        firstError,
      ]
        .filter(Boolean)
        .join("；")
        .slice(0, 1000),
      nextRunAt,
      lockedUntil: null,
    },
  });
  return { completed: false };
}

async function sendOutboxNotification(row: NotificationOutbox) {
  await getNotificationChannelAdapter(row.channel).sendComposite(row);
}

function nextRetryAt(attempts: number): Date {
  const delaySeconds = Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + delaySeconds * 1000);
}
