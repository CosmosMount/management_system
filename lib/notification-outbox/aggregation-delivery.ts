import { Prisma } from "@prisma/client";
import {
  isCanceledNotificationError,
  isNonRetryableNotificationError,
  NonRetryableNotificationError,
  type NotificationChannelResolver,
} from "@/lib/notification-channel-adapter";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { withClaimHeartbeat } from "@/lib/notification-outbox/claims";
import {
  FROZEN_NOTIFICATION_NEXT_RUN_AT,
  MAX_NOTIFICATION_ATTEMPTS,
  nextNotificationClaimExpiry,
  nextNotificationRetryAt,
} from "@/lib/notification-outbox/constants";
import type { NotificationDeliveryClaim } from "@/lib/notification-outbox/types";

export async function drainAggregatedNotificationBatches(
  resolveChannel: NotificationChannelResolver,
  limit: number,
) {
  const now = new Date();
  const batches = await prisma.notificationDeliveryBatch.findMany({
    where: {
      OR: [
        {
          status: { in: ["PENDING", "FAILED"] },
          attempts: { lt: MAX_NOTIFICATION_ATTEMPTS },
          nextRunAt: { lte: now },
        },
        { status: "PROCESSING", lockedUntil: { lte: now } },
      ],
    },
    orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
    take: limit,
  });

  let sent = 0;
  for (const batch of batches) {
    const claim = {
      attempts: Math.min(
        batch.attempts + 1,
        MAX_NOTIFICATION_ATTEMPTS,
      ),
      lockedUntil: nextNotificationClaimExpiry(),
    };
    const recipientIds = await claimBatch(batch, claim, now);
    if (recipientIds === null) continue;
    if (recipientIds.length === 0) {
      await cancelEmptyBatch(batch.id, claim);
      continue;
    }

    const recipients = await prisma.notificationOutboxRecipient.findMany({
      where: { id: { in: recipientIds } },
      include: { outbox: true },
      orderBy: [
        { outbox: { createdAt: "asc" } },
        { outboxId: "asc" },
      ],
    });
    try {
      const adapter = resolveChannel(batch.channel);
      if (!adapter.sendAggregatedToRecipient) {
        throw new NonRetryableNotificationError(
          `通知通道不支持聚合投递: ${batch.channel}`,
        );
      }
      const target = await withClaimHeartbeat(
        () => renewBatchClaim(batch.id, claim),
        () =>
          adapter.sendAggregatedToRecipient!(
            recipients.map((recipient) => recipient.outbox),
            batch.recipientOpenId,
            { batchId: batch.id, category: batch.category },
          ),
      );
      if (
        await settleBatchSuccess(
          batch.id,
          claim,
          recipientIds,
          target,
        )
      ) {
        sent += 1;
        logger.info("notification.delivery_batch.sent", {
          module: "notification",
          action: "drainAggregatedNotificationBatches",
          entityType: "NotificationDeliveryBatch",
          entityId: batch.id,
          channel: batch.channel,
          category: batch.category,
          eventCount: recipientIds.length,
          result: "success",
        });
      }
    } catch (error) {
      await settleBatchFailure(
        batch.id,
        claim,
        recipientIds,
        { channel: batch.channel, category: batch.category },
        error,
      );
    }
  }
  return sent;
}

async function claimBatch(
  batch: {
    id: string;
    status: "PENDING" | "PROCESSING" | "SENT" | "FAILED" | "CANCELED";
    attempts: number;
    lockedUntil: Date | null;
    openKey: string | null;
  },
  claim: NotificationDeliveryClaim,
  scannedAt: Date,
) {
  return prisma.$transaction(async (tx) => {
    if (batch.openKey) {
      await tx.$queryRaw`
        SELECT 1 AS "locked"
        FROM (
          SELECT pg_advisory_xact_lock(hashtextextended(${batch.openKey}, 0))
        ) AS "notificationAggregationLock"
      `;
    }
    const claimed = await tx.notificationDeliveryBatch.updateMany({
      where: {
        id: batch.id,
        status: batch.status,
        attempts: batch.attempts,
        AND: [
          { lockedUntil: batch.lockedUntil },
          batch.status === "PROCESSING"
            ? { lockedUntil: { lte: scannedAt } }
            : { nextRunAt: { lte: scannedAt } },
        ],
      },
      data: {
        openKey: null,
        status: "PROCESSING",
        attempts: claim.attempts,
        lastError: "",
        lockedUntil: claim.lockedUntil,
      },
    });
    if (claimed.count !== 1) return null;

    const activeRecipients = await tx.notificationOutboxRecipient.findMany({
      where: {
        deliveryBatchId: batch.id,
        OR: [
          {
            status: { in: ["PENDING", "FAILED"] },
            attempts: { lt: MAX_NOTIFICATION_ATTEMPTS },
          },
          {
            status: "PROCESSING",
            OR: [{ lockedUntil: null }, { lockedUntil: { lte: scannedAt } }],
          },
        ],
      },
      select: { id: true },
    });
    const ids = activeRecipients.map((recipient) => recipient.id);
    if (ids.length > 0) {
      await tx.notificationOutboxRecipient.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "PROCESSING",
          attempts: claim.attempts,
          lastError: "",
          lockedUntil: claim.lockedUntil,
        },
      });
      await refreshAggregatedOutboxesTx(tx, ids, scannedAt);
    }
    return ids;
  });
}

async function renewBatchClaim(
  batchId: string,
  claim: NotificationDeliveryClaim,
) {
  if (claim.lockedUntil <= new Date()) return false;
  const renewedUntil = nextNotificationClaimExpiry();
  const renewed = await prisma.$transaction(async (tx) => {
    const batch = await tx.notificationDeliveryBatch.updateMany({
      where: {
        id: batchId,
        status: "PROCESSING",
        attempts: claim.attempts,
        lockedUntil: claim.lockedUntil,
      },
      data: { lockedUntil: renewedUntil },
    });
    if (batch.count !== 1) return false;
    await tx.notificationOutboxRecipient.updateMany({
      where: {
        deliveryBatchId: batchId,
        status: "PROCESSING",
        attempts: claim.attempts,
      },
      data: { lockedUntil: renewedUntil },
    });
    return true;
  });
  if (renewed) claim.lockedUntil = renewedUntil;
  return renewed;
}

async function cancelEmptyBatch(
  batchId: string,
  claim: NotificationDeliveryClaim,
) {
  await prisma.notificationDeliveryBatch.updateMany({
    where: {
      id: batchId,
      status: "PROCESSING",
      attempts: claim.attempts,
      lockedUntil: claim.lockedUntil,
    },
    data: {
      status: "CANCELED",
      lastError: "聚合批次没有可投递事件",
      lockedUntil: null,
    },
  });
}

async function settleBatchSuccess(
  batchId: string,
  claim: NotificationDeliveryClaim,
  recipientIds: string[],
  target: { receiveId: string; receiveIdType: string } | null,
) {
  return prisma.$transaction(async (tx) => {
    const completedAt = new Date();
    const batch = await tx.notificationDeliveryBatch.updateMany({
      where: {
        id: batchId,
        status: "PROCESSING",
        attempts: claim.attempts,
        lockedUntil: claim.lockedUntil,
      },
      data: {
        status: "SENT",
        sentAt: completedAt,
        lastError: "",
        lockedUntil: null,
      },
    });
    if (batch.count !== 1) return false;
    await tx.notificationOutboxRecipient.updateMany({
      where: {
        id: { in: recipientIds },
        status: "PROCESSING",
        attempts: claim.attempts,
      },
      data: {
        status: "SENT",
        receiveId: target?.receiveId ?? "",
        receiveIdType: target?.receiveIdType ?? "",
        sentAt: completedAt,
        lastError: "",
        lockedUntil: null,
      },
    });
    await refreshAggregatedOutboxesTx(tx, recipientIds, completedAt);
    return true;
  });
}

async function settleBatchFailure(
  batchId: string,
  claim: NotificationDeliveryClaim,
  recipientIds: string[],
  context: { channel: string; category: string },
  error: unknown,
) {
  const message = (error instanceof Error ? error.message : String(error)).slice(
    0,
    1000,
  );
  const canceled = isCanceledNotificationError(error);
  const attempts = isNonRetryableNotificationError(error)
    ? MAX_NOTIFICATION_ATTEMPTS
    : claim.attempts;
  const nextRunAt =
    attempts >= MAX_NOTIFICATION_ATTEMPTS
      ? FROZEN_NOTIFICATION_NEXT_RUN_AT
      : nextNotificationRetryAt(attempts);
  await prisma.$transaction(async (tx) => {
    const batch = await tx.notificationDeliveryBatch.updateMany({
      where: {
        id: batchId,
        status: "PROCESSING",
        attempts: claim.attempts,
        lockedUntil: claim.lockedUntil,
      },
      data: {
        status: canceled ? "CANCELED" : "FAILED",
        attempts,
        lastError: message,
        nextRunAt,
        lockedUntil: null,
      },
    });
    if (batch.count !== 1) return;
    await tx.notificationOutboxRecipient.updateMany({
      where: {
        id: { in: recipientIds },
        status: "PROCESSING",
        attempts: claim.attempts,
      },
      data: {
        status: canceled ? "CANCELED" : "FAILED",
        attempts,
        lastError: message,
        nextRunAt,
        lockedUntil: null,
      },
    });
    await refreshAggregatedOutboxesTx(tx, recipientIds, new Date());
  });
  logger.error("notification.delivery_batch.failed", {
    module: "notification",
    action: "drainAggregatedNotificationBatches",
    entityType: "NotificationDeliveryBatch",
    entityId: batchId,
    channel: context.channel,
    category: context.category,
    attempts,
    eventCount: recipientIds.length,
    status: canceled ? "CANCELED" : "FAILED",
    result: canceled ? "skipped" : "failure",
    error,
  });
}

export async function refreshAggregatedOutboxesTx(
  tx: Prisma.TransactionClient,
  recipientIds: string[],
  now: Date,
) {
  const affected = await tx.notificationOutboxRecipient.findMany({
    where: { id: { in: recipientIds } },
    select: { outboxId: true },
  });
  const outboxIds = [
    ...new Set(affected.map((recipient) => recipient.outboxId)),
  ].sort((left, right) => left.localeCompare(right));
  if (outboxIds.length > 0) {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "NotificationOutbox"
      WHERE "id" IN (${Prisma.join(outboxIds)})
      ORDER BY "id"
      FOR UPDATE
    `);
  }
  for (const outboxId of outboxIds) {
    const recipients = await tx.notificationOutboxRecipient.findMany({
      where: { outboxId },
      select: {
        status: true,
        attempts: true,
        lastError: true,
        nextRunAt: true,
        lockedUntil: true,
      },
    });
    if (recipients.length === 0) continue;
    const allCanceled = recipients.every(
      (recipient) => recipient.status === "CANCELED",
    );
    const deliveredCount = recipients.filter(
      (recipient) => recipient.status === "SENT",
    ).length;
    const allTerminal = recipients.every((recipient) =>
      ["SENT", "CANCELED"].includes(recipient.status),
    );
    if (allCanceled || (deliveredCount > 0 && allTerminal)) {
      await tx.notificationOutbox.update({
        where: { id: outboxId },
        data: {
          status: allCanceled ? "CANCELED" : "SENT",
          attempts: Math.max(...recipients.map((recipient) => recipient.attempts)),
          sentAt: allCanceled ? null : now,
          lastError: allCanceled
            ? "全部收件人已不再具备当前事件的投递资格"
            : "",
          lockedUntil: null,
        },
      });
      continue;
    }

    const retryable = recipients.filter(
      (recipient) =>
        ["PENDING", "FAILED", "PROCESSING"].includes(recipient.status) &&
        recipient.attempts < MAX_NOTIFICATION_ATTEMPTS,
    );
    const processing = retryable.some(
      (recipient) => recipient.status === "PROCESSING",
    );
    const failed = recipients.some((recipient) => recipient.status === "FAILED");
    const nextRunAt =
      retryable
        .map((recipient) =>
          recipient.status === "PROCESSING" && recipient.lockedUntil
            ? recipient.lockedUntil
            : recipient.nextRunAt,
        )
        .sort((left, right) => left.getTime() - right.getTime())[0] ??
      FROZEN_NOTIFICATION_NEXT_RUN_AT;
    const firstError = recipients.find((recipient) => recipient.lastError)
      ?.lastError;
    await tx.notificationOutbox.update({
      where: { id: outboxId },
      data: {
        status: processing ? "PROCESSING" : failed ? "FAILED" : "PENDING",
        attempts: Math.max(...recipients.map((recipient) => recipient.attempts)),
        lastError: firstError ?? "",
        nextRunAt,
        lockedUntil: null,
      },
    });
  }
}
