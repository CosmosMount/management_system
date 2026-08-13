import type { NotificationOutboxStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  notificationRecipientLockMs,
} from "@/lib/notification-outbox/constants";
import type {
  NotificationCoordinationTerminalState,
  NotificationDeliveryClaim,
} from "@/lib/notification-outbox/types";

export async function reconcileOutboxRecipients(
  outboxId: string,
  openIds: string[],
) {
  await prisma.$transaction(async (tx) => {
    await reconcileOutboxRecipientsTx(tx, outboxId, openIds, new Date());
  });
}

export async function coordinateOutboxRecipientsForClaim(
  outboxId: string,
  openIds: string[],
  claim: NotificationDeliveryClaim,
  terminal?: NotificationCoordinationTerminalState,
): Promise<boolean> {
  let renewedUntil: Date | null = null;
  const coordinated = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{
        attempts: number;
        lockedUntil: Date | null;
        status: NotificationOutboxStatus;
      }>
    >`
      SELECT "status", "attempts", "lockedUntil"
      FROM "NotificationOutbox"
      WHERE "id" = ${outboxId}
      FOR UPDATE
    `;
    const current = rows[0];
    const now = new Date();
    if (
      !current ||
      current.status !== "PROCESSING" ||
      current.attempts !== claim.attempts ||
      current.lockedUntil?.getTime() !== claim.lockedUntil.getTime() ||
      claim.lockedUntil <= now
    ) {
      return false;
    }
    renewedUntil = new Date(now.getTime() + notificationRecipientLockMs());
    const updated = await tx.notificationOutbox.updateMany({
      where: {
        id: outboxId,
        status: "PROCESSING",
        attempts: claim.attempts,
        lockedUntil: claim.lockedUntil,
      },
      data: terminal
        ? {
            status: terminal.status,
            lastError: terminal.lastError,
            nextRunAt: terminal.nextRunAt,
            lockedUntil: null,
          }
        : { lockedUntil: renewedUntil },
    });
    if (updated.count !== 1) return false;
    await reconcileOutboxRecipientsTx(tx, outboxId, openIds, now);
    return true;
  });
  if (coordinated && !terminal && renewedUntil) claim.lockedUntil = renewedUntil;
  return coordinated;
}

async function reconcileOutboxRecipientsTx(
  tx: Prisma.TransactionClient,
  outboxId: string,
  openIds: string[],
  now: Date,
) {
  const uniqueOpenIds = [
    ...new Set(openIds.map((id) => id.trim()).filter(Boolean)),
  ];
  await tx.notificationOutboxRecipient.updateMany({
    where: {
      outboxId,
      ...(uniqueOpenIds.length > 0
        ? { openId: { notIn: uniqueOpenIds } }
        : {}),
      OR: [
        { status: { in: ["PENDING", "FAILED"] } },
        {
          status: "PROCESSING",
          OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
        },
      ],
    },
    data: {
      status: "CANCELED",
      lastError: "收件人已不再具备当前事件的投递资格",
      lockedUntil: null,
    },
  });
  if (uniqueOpenIds.length === 0) return;
  await tx.notificationOutboxRecipient.updateMany({
    where: { outboxId, openId: { in: uniqueOpenIds }, status: "CANCELED" },
    data: {
      status: "PENDING",
      attempts: 0,
      lastError: "",
      nextRunAt: new Date(),
      lockedUntil: null,
    },
  });
  await tx.notificationOutboxRecipient.createMany({
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
