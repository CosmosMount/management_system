import type { NotificationOutbox } from "@prisma/client";
import {
  isNonRetryableNotificationError,
  type NotificationChannelResolver,
} from "@/lib/notification-channel-adapter";
import { prisma } from "@/lib/prisma";

import { renewOutboxClaim, withClaimHeartbeat } from "@/lib/notification-outbox/claims";
import {
  FROZEN_NOTIFICATION_NEXT_RUN_AT as FROZEN_NEXT_RUN_AT,
  MAX_NOTIFICATION_ATTEMPTS as MAX_ATTEMPTS,
  nextNotificationClaimExpiry as nextClaimExpiry,
  nextNotificationRetryAt as nextRetryAt,
} from "@/lib/notification-outbox/constants";
import type { DrainNotificationOutboxOptions } from "@/lib/notification-outbox/types";
import { sendOutboxNotificationByRecipient } from "@/lib/notification-outbox/recipient-delivery";

export {
  cancelRetryableNotificationOutboxesTx,
  enqueueNotification,
  enqueueNotificationTx,
  resetNotificationOutboxForRetry,
} from "@/lib/notification-outbox/enqueue-retry";
export type {
  EnqueueNotificationResult,
  NotificationBotKind,
} from "@/lib/notification-outbox/enqueue-retry";
export { reconcileOutboxRecipients } from "@/lib/notification-outbox/recipient-coordination";

export async function drainNotificationOutboxWithResolver(
  resolveChannel: NotificationChannelResolver,
  limit = 20,
  options: DrainNotificationOutboxOptions = {},
): Promise<number> {
  if (
    process.env.NOTIFICATION_DELIVERY_DISABLED === "true" &&
    !options.ignoreDeliveryDisabled
  ) {
    return 0;
  }
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
    const lockedUntil = nextClaimExpiry();
    const claim = { attempts: row.attempts + 1, lockedUntil };
    const claimed = await prisma.notificationOutbox.updateMany({
      where: {
        id: row.id,
        status: row.status,
        attempts: row.attempts,
        AND: [
          { lockedUntil: row.lockedUntil },
          row.status === "PROCESSING"
            ? { lockedUntil: { lte: now } }
            : { nextRunAt: { lte: now } },
        ],
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
      const recipientResult = await sendOutboxNotificationByRecipient(
        row,
        claim,
        resolveChannel,
      );
      if (recipientResult.supported) {
        if (recipientResult.completed) sent++;
      } else {
        await withClaimHeartbeat(
          () => renewOutboxClaim(row.id, claim),
          () => sendOutboxNotification(row, resolveChannel),
        );
        const markedSent = await prisma.notificationOutbox.updateMany({
          where: {
            id: row.id,
            status: "PROCESSING",
            attempts: claim.attempts,
            lockedUntil: claim.lockedUntil,
          },
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
        where: {
          id: row.id,
          status: "PROCESSING",
          attempts: claim.attempts,
          lockedUntil: claim.lockedUntil,
        },
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

async function sendOutboxNotification(
  row: NotificationOutbox,
  resolveChannel: NotificationChannelResolver,
) {
  await resolveChannel(row.channel).sendComposite(row);
}
