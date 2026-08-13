import { prisma } from "@/lib/prisma";
import {
  nextNotificationClaimExpiry,
  notificationRecipientLockMs,
} from "@/lib/notification-outbox/constants";
import type { NotificationDeliveryClaim } from "@/lib/notification-outbox/types";

export async function renewOutboxAndRecipientClaims(
  outboxId: string,
  outboxClaim: NotificationDeliveryClaim,
  recipientId: string,
  recipientClaim: NotificationDeliveryClaim,
): Promise<boolean> {
  if (
    outboxClaim.lockedUntil <= new Date() ||
    recipientClaim.lockedUntil <= new Date()
  ) {
    return false;
  }
  const renewedUntil = nextNotificationClaimExpiry();
  try {
    await prisma.$transaction(async (tx) => {
      const parent = await tx.notificationOutbox.updateMany({
        where: {
          id: outboxId,
          status: "PROCESSING",
          attempts: outboxClaim.attempts,
          lockedUntil: outboxClaim.lockedUntil,
        },
        data: { lockedUntil: renewedUntil },
      });
      const recipient = await tx.notificationOutboxRecipient.updateMany({
        where: {
          id: recipientId,
          status: "PROCESSING",
          attempts: recipientClaim.attempts,
          lockedUntil: recipientClaim.lockedUntil,
        },
        data: { lockedUntil: renewedUntil },
      });
      if (parent.count !== 1 || recipient.count !== 1) {
        throw new Error("notification claim lost");
      }
    });
  } catch {
    return false;
  }
  outboxClaim.lockedUntil = renewedUntil;
  recipientClaim.lockedUntil = renewedUntil;
  return true;
}

export async function withClaimHeartbeat<T>(
  renew: () => Promise<boolean>,
  operation: () => Promise<T>,
): Promise<T> {
  let heartbeat = Promise.resolve(true);
  const timer = setInterval(() => {
    heartbeat = heartbeat.then((active) => (active ? renew() : false));
  }, Math.max(25, Math.floor(notificationRecipientLockMs() / 4)));
  try {
    return await operation();
  } finally {
    clearInterval(timer);
    await heartbeat;
  }
}

export async function renewOutboxClaim(
  outboxId: string,
  claim: NotificationDeliveryClaim,
): Promise<boolean> {
  if (claim.lockedUntil <= new Date()) return false;
  const renewedUntil = nextNotificationClaimExpiry();
  const renewed = await prisma.notificationOutbox.updateMany({
    where: {
      id: outboxId,
      status: "PROCESSING",
      attempts: claim.attempts,
      lockedUntil: claim.lockedUntil,
    },
    data: { lockedUntil: renewedUntil },
  });
  if (renewed.count !== 1) return false;
  claim.lockedUntil = renewedUntil;
  return true;
}
