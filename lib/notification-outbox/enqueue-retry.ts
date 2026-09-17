import { Prisma, type NotificationDeliveryMode } from "@prisma/client";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { refreshAggregatedOutboxesTx } from "@/lib/notification-outbox/aggregation-delivery";
import {
  FROZEN_NOTIFICATION_NEXT_RUN_AT,
  MAX_NOTIFICATION_ATTEMPTS,
} from "@/lib/notification-outbox/constants";

export type EnqueueNotificationResult = { created: boolean };
export type NotificationBotKind = "notification" | "approval";

class AggregatedDeliveryBatchStateConflict extends Error {}

type EnqueueInput = {
  eventKey: string;
  channel: string;
  botKind?: NotificationBotKind;
  type: string;
  payload: unknown;
  deliveryMode?: NotificationDeliveryMode;
  nextRunAt?: Date;
};

function enqueueRecord(input: EnqueueInput) {
  return {
    eventKey: input.eventKey,
    channel: input.channel,
    botKind: input.botKind ?? "notification",
    type: input.type,
    payload: JSON.stringify(input.payload),
    deliveryMode: input.deliveryMode ?? "DIRECT",
    status: "PENDING" as const,
    attempts: 0,
    lastError: "",
    nextRunAt: input.nextRunAt ?? new Date(),
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
    deliveryMode: input.deliveryMode ?? "DIRECT",
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
    select: { id: true, deliveryMode: true },
  });
  const outboxIds = outboxes.map((item) => item.id);
  if (outboxIds.length === 0) return 0;
  const directOutboxIds = outboxes
    .filter((item) => item.deliveryMode === "DIRECT")
    .map((item) => item.id);
  const aggregatedOutboxIds = outboxes
    .filter((item) => item.deliveryMode === "AGGREGATED")
    .map((item) => item.id);
  const aggregatedRecipients = aggregatedOutboxIds.length === 0
    ? []
    : await tx.notificationOutboxRecipient.findMany({
        where: {
          outboxId: { in: aggregatedOutboxIds },
          status: { in: ["PENDING", "FAILED", "PROCESSING"] },
        },
        select: { deliveryBatchId: true },
      });
  if (aggregatedRecipients.some((item) => !item.deliveryBatchId)) {
    throw new Error("聚合通知缺少投递批次，无法安全取消");
  }
  const deliveryBatchIds = [
    ...new Set(
      aggregatedRecipients.flatMap((item) =>
        item.deliveryBatchId ? [item.deliveryBatchId] : [],
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const lockedBatches = await lockDeliveryBatchesTx(tx, deliveryBatchIds);
  if (lockedBatches.some((batch) => batch.status === "PROCESSING")) {
    throw new Error("聚合通知正在投递，暂时无法安全取消");
  }
  if (directOutboxIds.length > 0) {
    await tx.notificationOutboxRecipient.updateMany({
      where: {
        outboxId: { in: directOutboxIds },
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
  }
  if (aggregatedOutboxIds.length > 0) {
    await tx.notificationOutboxRecipient.updateMany({
      where: {
        outboxId: { in: aggregatedOutboxIds },
        status: { in: ["PENDING", "FAILED", "PROCESSING"] },
      },
      data: {
        status: "CANCELED",
        attempts: MAX_NOTIFICATION_ATTEMPTS,
        nextRunAt: FROZEN_NOTIFICATION_NEXT_RUN_AT,
        lockedUntil: null,
        lastError: reason,
      },
    });
  }
  for (const deliveryBatchId of deliveryBatchIds) {
    const activeRecipients = await tx.notificationOutboxRecipient.count({
      where: {
        deliveryBatchId,
        status: { in: ["PENDING", "FAILED", "PROCESSING"] },
      },
    });
    if (activeRecipients === 0) {
      await tx.notificationDeliveryBatch.updateMany({
        where: {
          id: deliveryBatchId,
          status: { in: ["PENDING", "FAILED"] },
        },
        data: {
          openKey: null,
          status: "CANCELED",
          attempts: MAX_NOTIFICATION_ATTEMPTS,
          nextRunAt: FROZEN_NOTIFICATION_NEXT_RUN_AT,
          lockedUntil: null,
          lastError: reason,
        },
      });
    }
  }
  const failedDirect = directOutboxIds.length === 0
    ? { count: 0 }
    : await tx.notificationOutbox.updateMany({
        where: {
          id: { in: directOutboxIds },
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
  const canceledAggregated = aggregatedOutboxIds.length === 0
    ? { count: 0 }
    : await tx.notificationOutbox.updateMany({
        where: {
          id: { in: aggregatedOutboxIds },
          status: { in: ["PENDING", "FAILED", "PROCESSING"] },
        },
        data: {
          status: "CANCELED",
          attempts: MAX_NOTIFICATION_ATTEMPTS,
          nextRunAt: FROZEN_NOTIFICATION_NEXT_RUN_AT,
          lockedUntil: null,
          lastError: reason,
        },
      });
  return failedDirect.count + canceledAggregated.count;
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
  try {
    return await prisma.$transaction(async (tx) => {
      const outbox = await tx.notificationOutbox.findFirst({
        where: { id, channel, type, status: "FAILED" },
        select: { deliveryMode: true },
      });
      if (!outbox) return { count: 0 };
      const retryAt = new Date();
      if (outbox.deliveryMode === "DIRECT") {
        const updated = await tx.notificationOutbox.updateMany({
          where: {
            id,
            channel,
            type,
            status: "FAILED",
            deliveryMode: "DIRECT",
          },
          data: {
            status: "PENDING",
            attempts: 0,
            nextRunAt: retryAt,
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
              nextRunAt: retryAt,
              lockedUntil: null,
              lastError: "",
            },
          });
        }
        return updated;
      }

      const targetRecipients = await tx.notificationOutboxRecipient.findMany({
        where: {
          outboxId: id,
          status: { in: ["PENDING", "FAILED", "PROCESSING"] },
        },
        select: { status: true, deliveryBatchId: true },
      });
      if (
        targetRecipients.length === 0 ||
        targetRecipients.some((recipient) => !recipient.deliveryBatchId)
      ) {
        return { count: 0 };
      }
      const deliveryBatchIds = [
        ...new Set(
          targetRecipients.flatMap((recipient) =>
            recipient.status === "FAILED" && recipient.deliveryBatchId
              ? [recipient.deliveryBatchId]
              : [],
          ),
        ),
      ].sort((left, right) => left.localeCompare(right));
      if (deliveryBatchIds.length === 0) return { count: 0 };

      const lockedBatches = await lockDeliveryBatchesTx(tx, deliveryBatchIds);
      if (
        lockedBatches.length !== deliveryBatchIds.length ||
        lockedBatches.some((batch) => batch.status !== "FAILED")
      ) {
        throw new AggregatedDeliveryBatchStateConflict();
      }
      const relatedOutboxIds = [
        ...new Set(
          (
            await tx.notificationOutboxRecipient.findMany({
              where: { deliveryBatchId: { in: deliveryBatchIds } },
              select: { outboxId: true },
            })
          ).map((recipient) => recipient.outboxId),
        ),
      ].sort((left, right) => left.localeCompare(right));
      const lockedOutboxes = await lockNotificationOutboxesTx(
        tx,
        relatedOutboxIds,
      );
      if (lockedOutboxes.length !== relatedOutboxIds.length) {
        throw new AggregatedDeliveryBatchStateConflict();
      }
      const stillFailed = await tx.notificationOutbox.count({
        where: {
          id,
          channel,
          type,
          status: "FAILED",
          deliveryMode: "AGGREGATED",
        },
      });
      if (stillFailed !== 1) {
        throw new AggregatedDeliveryBatchStateConflict();
      }

      const batchRecipients = await tx.notificationOutboxRecipient.findMany({
        where: {
          deliveryBatchId: { in: deliveryBatchIds },
          status: "FAILED",
        },
        select: { id: true },
      });
      const recipientIds = batchRecipients.map((recipient) => recipient.id);
      if (recipientIds.length === 0) {
        throw new AggregatedDeliveryBatchStateConflict();
      }
      const resetBatches = await tx.notificationDeliveryBatch.updateMany({
        where: { id: { in: deliveryBatchIds }, status: "FAILED" },
        data: {
          status: "PENDING",
          attempts: 0,
          nextRunAt: retryAt,
          lockedUntil: null,
          sentAt: null,
          lastError: "",
        },
      });
      if (resetBatches.count !== deliveryBatchIds.length) {
        throw new AggregatedDeliveryBatchStateConflict();
      }
      const resetRecipients = await tx.notificationOutboxRecipient.updateMany({
        where: { id: { in: recipientIds }, status: "FAILED" },
        data: {
          status: "PENDING",
          attempts: 0,
          nextRunAt: retryAt,
          lockedUntil: null,
          sentAt: null,
          lastError: "",
        },
      });
      if (resetRecipients.count !== recipientIds.length) {
        throw new AggregatedDeliveryBatchStateConflict();
      }
      await refreshAggregatedOutboxesTx(tx, recipientIds, retryAt);
      return { count: 1 };
    });
  } catch (error) {
    if (error instanceof AggregatedDeliveryBatchStateConflict) {
      return { count: 0 };
    }
    throw error;
  }
}

async function lockDeliveryBatchesTx(
  tx: Prisma.TransactionClient,
  deliveryBatchIds: string[],
) {
  if (deliveryBatchIds.length === 0) return [];
  const openKeys = (
    await tx.notificationDeliveryBatch.findMany({
      where: { id: { in: deliveryBatchIds } },
      select: { openKey: true },
    })
  )
    .flatMap((batch) => (batch.openKey ? [batch.openKey] : []))
    .sort((left, right) => left.localeCompare(right));
  for (const openKey of openKeys) {
    await tx.$queryRaw`
      SELECT 1 AS "locked"
      FROM (
        SELECT pg_advisory_xact_lock(hashtextextended(${openKey}, 0))
      ) AS "notificationAggregationLock"
    `;
  }
  return tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
    SELECT "id", "status"::text AS "status"
    FROM "NotificationDeliveryBatch"
    WHERE "id" IN (${Prisma.join(deliveryBatchIds)})
    ORDER BY "id"
    FOR UPDATE
  `);
}

async function lockNotificationOutboxesTx(
  tx: Prisma.TransactionClient,
  outboxIds: string[],
) {
  if (outboxIds.length === 0) return [];
  return tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "NotificationOutbox"
    WHERE "id" IN (${Prisma.join(outboxIds)})
    ORDER BY "id"
    FOR UPDATE
  `);
}
