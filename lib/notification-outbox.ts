import type {
  NotificationOutbox,
  NotificationOutboxRecipient,
  NotificationOutboxStatus,
  Prisma,
} from "@prisma/client";
import {
  isCanceledNotificationError,
  isNonRetryableNotificationError,
  type NotificationChannelResolver,
} from "@/lib/notification-channel-adapter";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const MAX_ATTEMPTS = 8;
const DEFAULT_RECIPIENT_LOCK_MS = 2 * 60 * 1000;
const FROZEN_NEXT_RUN_AT = new Date("9999-12-31T00:00:00.000Z");

type DrainNotificationOutboxOptions = {
  ignoreDeliveryDisabled?: boolean;
};

type DeliveryClaim = {
  attempts: number;
  lockedUntil: Date;
};

type CoordinationTerminalState = {
  status: "CANCELED" | "FAILED";
  lastError: string;
  nextRunAt?: Date;
};

function recipientLockMs(): number {
  if (process.env.NODE_ENV !== "test") return DEFAULT_RECIPIENT_LOCK_MS;
  const override = Number(process.env.NOTIFICATION_OUTBOX_TEST_LOCK_MS);
  return Number.isFinite(override) && override >= 100
    ? override
    : DEFAULT_RECIPIENT_LOCK_MS;
}

function nextClaimExpiry() {
  return new Date(Date.now() + recipientLockMs());
}

async function renewOutboxAndRecipientClaims(
  outboxId: string,
  outboxClaim: DeliveryClaim,
  recipientId: string,
  recipientClaim: DeliveryClaim,
): Promise<boolean> {
  if (
    outboxClaim.lockedUntil <= new Date() ||
    recipientClaim.lockedUntil <= new Date()
  ) {
    return false;
  }
  const renewedUntil = nextClaimExpiry();
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

async function withClaimHeartbeat<T>(
  renew: () => Promise<boolean>,
  operation: () => Promise<T>,
): Promise<T> {
  let heartbeat = Promise.resolve(true);
  const timer = setInterval(() => {
    heartbeat = heartbeat.then((active) => (active ? renew() : false));
  }, Math.max(25, Math.floor(recipientLockMs() / 4)));
  try {
    return await operation();
  } finally {
    clearInterval(timer);
    await heartbeat;
  }
}

async function renewOutboxClaim(
  outboxId: string,
  claim: DeliveryClaim,
): Promise<boolean> {
  if (claim.lockedUntil <= new Date()) return false;
  const renewedUntil = nextClaimExpiry();
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

export type EnqueueNotificationResult = {
  created: boolean;
};

export type NotificationBotKind = "notification" | "approval";

export async function enqueueNotification({
  eventKey,
  channel,
  botKind = "notification",
  type,
  payload,
}: {
  eventKey: string;
  channel: string;
  botKind?: NotificationBotKind;
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
    botKind?: NotificationBotKind;
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

async function sendOutboxNotificationByRecipient(
  row: NotificationOutbox,
  claim: DeliveryClaim,
  resolveChannel: NotificationChannelResolver,
): Promise<{ supported: true; completed: boolean } | { supported: false }> {
  const adapter = resolveChannel(row.channel);
  const plan = await adapter.resolveRecipientPlan(row);
  if (!plan.supported) return { supported: false };
  if (!(await renewOutboxClaim(row.id, claim))) {
    return { supported: true, completed: false };
  }

  if (plan.cancelReason) {
    await coordinateOutboxRecipientsForClaim(row.id, [], claim, {
      status: "CANCELED",
      lastError: plan.cancelReason,
    });
    return { supported: true, completed: false };
  }

  const directOpenIds = (plan.directOpenIds ?? plan.openIds)
    .map((id) => id.trim())
    .filter(Boolean);
  if (plan.requiresDirectRecipient && directOpenIds.length === 0) {
    // Cancel any recipients from an earlier resolution without creating
    // transport-only pseudo recipients such as the procurement Webhook.
    await failOutboxWithNoRecipients(row, claim, plan.emptyRecipientReason);
    return { supported: true, completed: false };
  }
  if (!(await coordinateOutboxRecipientsForClaim(row.id, plan.openIds, claim))) {
    return { supported: true, completed: false };
  }
  await adapter.beforeRecipientDelivery?.(row);
  if (!(await renewOutboxClaim(row.id, claim))) {
    return { supported: true, completed: false };
  }

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
    await sendOutboxRecipient(row, recipient, claim, resolveChannel);
  }

  const summary = await updateOutboxStatusFromRecipients(row.id, claim);
  return { supported: true, completed: summary.completed };
}

async function failOutboxWithNoRecipients(
  row: NotificationOutbox,
  claim: DeliveryClaim,
  emptyRecipientReason?: string,
) {
  const attempts = row.attempts + 1;
  const message =
    emptyRecipientReason ??
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
  await coordinateOutboxRecipientsForClaim(row.id, [], claim, {
    status: "FAILED",
    lastError: message,
    nextRunAt: nextRetryAt(attempts),
  });
}

async function sendOutboxRecipient(
  row: NotificationOutbox,
  recipient: NotificationOutboxRecipient,
  outboxClaim: DeliveryClaim,
  resolveChannel: NotificationChannelResolver,
) {
  if (!(await renewOutboxClaim(row.id, outboxClaim))) return;
  const lockedUntil = nextClaimExpiry();
  const claimed = await prisma.notificationOutboxRecipient.updateMany({
    where: {
      id: recipient.id,
      status: recipient.status,
      attempts: recipient.attempts,
      AND: [
        { lockedUntil: recipient.lockedUntil },
        recipient.status === "PROCESSING"
          ? { lockedUntil: { lte: new Date() } }
          : { nextRunAt: { lte: new Date() } },
      ],
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
  const claim = { attempts, lockedUntil };
  try {
    const target = await withClaimHeartbeat(
      () =>
        renewOutboxAndRecipientClaims(
          row.id,
          outboxClaim,
          recipient.id,
          claim,
        ),
      () =>
        resolveChannel(row.channel).sendToRecipient(
          row,
          recipient.openId,
        ),
    );
    await prisma.notificationOutboxRecipient.updateMany({
      where: {
        id: recipient.id,
        status: "PROCESSING",
        attempts: claim.attempts,
        lockedUntil: claim.lockedUntil,
      },
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
    if (isCanceledNotificationError(err)) {
      await prisma.notificationOutboxRecipient.updateMany({
        where: {
          id: recipient.id,
          status: "PROCESSING",
          attempts: claim.attempts,
          lockedUntil: claim.lockedUntil,
        },
        data: {
          status: "CANCELED",
          lastError: message.slice(0, 1000),
          lockedUntil: null,
        },
      });
      return;
    }
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
      where: {
        id: recipient.id,
        status: "PROCESSING",
        attempts: claim.attempts,
        lockedUntil: claim.lockedUntil,
      },
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

export async function reconcileOutboxRecipients(
  outboxId: string,
  openIds: string[],
) {
  await prisma.$transaction(async (tx) => {
    await reconcileOutboxRecipientsTx(tx, outboxId, openIds, new Date());
  });
}

async function coordinateOutboxRecipientsForClaim(
  outboxId: string,
  openIds: string[],
  claim: DeliveryClaim,
  terminal?: CoordinationTerminalState,
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
    renewedUntil = new Date(now.getTime() + recipientLockMs());

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
  if (coordinated && !terminal && renewedUntil) {
    claim.lockedUntil = renewedUntil;
  }
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
    where: {
      outboxId,
      openId: { in: uniqueOpenIds },
      status: "CANCELED",
    },
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

async function updateOutboxStatusFromRecipients(
  outboxId: string,
  claim: DeliveryClaim,
): Promise<{
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

  const deliveredCount = recipients.filter((item) => item.status === "SENT").length;
  if (
    recipients.length > 0 &&
    recipients.every((item) => item.status === "CANCELED")
  ) {
    await prisma.notificationOutbox.updateMany({
      where: {
        id: outboxId,
        status: "PROCESSING",
        attempts: claim.attempts,
        lockedUntil: claim.lockedUntil,
      },
      data: {
        status: "CANCELED",
        lastError: "全部收件人已不再具备当前事件的投递资格",
        lockedUntil: null,
      },
    });
    return { completed: false };
  }
  if (
    recipients.length > 0 &&
    deliveredCount > 0 &&
    recipients.every((item) =>
      item.status === "SENT" || item.status === "CANCELED"
    )
  ) {
    const markedSent = await prisma.notificationOutbox.updateMany({
      where: {
        id: outboxId,
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
    return { completed: markedSent.count === 1 };
  }

  const retryableRecipients = recipients.filter(
    (item) =>
      ["PENDING", "FAILED", "PROCESSING"].includes(item.status) &&
      item.attempts < MAX_ATTEMPTS,
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
    where: {
      id: outboxId,
      status: "PROCESSING",
      attempts: claim.attempts,
      lockedUntil: claim.lockedUntil,
    },
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

async function sendOutboxNotification(
  row: NotificationOutbox,
  resolveChannel: NotificationChannelResolver,
) {
  await resolveChannel(row.channel).sendComposite(row);
}

function nextRetryAt(attempts: number): Date {
  const delaySeconds = Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + delaySeconds * 1000);
}
