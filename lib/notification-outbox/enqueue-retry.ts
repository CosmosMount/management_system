import type { Prisma } from "@prisma/client";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  FROZEN_NOTIFICATION_NEXT_RUN_AT,
  MAX_NOTIFICATION_ATTEMPTS,
} from "@/lib/notification-outbox/constants";

export type EnqueueNotificationResult = { created: boolean };
export type NotificationBotKind = "notification" | "approval";

type EnqueueInput = {
  eventKey: string;
  channel: string;
  botKind?: NotificationBotKind;
  type: string;
  payload: unknown;
};

function enqueueRecord(input: EnqueueInput) {
  return {
    eventKey: input.eventKey,
    channel: input.channel,
    botKind: input.botKind ?? "notification",
    type: input.type,
    payload: JSON.stringify(input.payload),
    status: "PENDING" as const,
    attempts: 0,
    lastError: "",
    nextRunAt: new Date(),
  };
}

export async function enqueueNotification(
  input: EnqueueInput,
): Promise<EnqueueNotificationResult> {
  const result = await prisma.notificationOutbox.createMany({
    data: [enqueueRecord(input)],
    skipDuplicates: true,
  });
  return { created: result.count > 0 };
}

export async function enqueueNotificationTx(
  tx: Prisma.TransactionClient,
  input: EnqueueInput,
): Promise<EnqueueNotificationResult> {
  const result = await tx.notificationOutbox.createMany({
    data: [enqueueRecord(input)],
    skipDuplicates: true,
  });
  logger.info("notification.outbox.enqueue_tx.prepared", {
    module: "notification",
    action: "enqueueNotificationTx",
    eventKey: input.eventKey,
    channel: input.channel,
    type: input.type,
    botKind: input.botKind ?? "notification",
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
      attempts: MAX_NOTIFICATION_ATTEMPTS,
      nextRunAt: FROZEN_NOTIFICATION_NEXT_RUN_AT,
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
      attempts: MAX_NOTIFICATION_ATTEMPTS,
      nextRunAt: FROZEN_NOTIFICATION_NEXT_RUN_AT,
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
      where: { id, channel, type, status: "FAILED" },
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
          status: { in: ["PENDING", "FAILED", "PROCESSING"] },
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
