import type { NotificationOutbox, NotificationOutboxRecipient } from "@prisma/client";
import {
  isCanceledNotificationError,
  isNonRetryableNotificationError,
  type NotificationChannelResolver,
} from "@/lib/notification-channel-adapter";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  renewOutboxAndRecipientClaims,
  renewOutboxClaim,
  withClaimHeartbeat,
} from "@/lib/notification-outbox/claims";
import {
  FROZEN_NOTIFICATION_NEXT_RUN_AT,
  MAX_NOTIFICATION_ATTEMPTS,
  nextNotificationClaimExpiry,
  nextNotificationRetryAt,
} from "@/lib/notification-outbox/constants";
import { coordinateOutboxRecipientsForClaim } from "@/lib/notification-outbox/recipient-coordination";
import { updateOutboxStatusFromRecipients } from "@/lib/notification-outbox/status-summary";
import type { NotificationDeliveryClaim } from "@/lib/notification-outbox/types";

export async function sendOutboxNotificationByRecipient(
  row: NotificationOutbox,
  claim: NotificationDeliveryClaim,
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
      attempts: { lt: MAX_NOTIFICATION_ATTEMPTS },
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
  claim: NotificationDeliveryClaim,
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
    nextRunAt: nextNotificationRetryAt(attempts),
  });
}

async function sendOutboxRecipient(
  row: NotificationOutbox,
  recipient: NotificationOutboxRecipient,
  outboxClaim: NotificationDeliveryClaim,
  resolveChannel: NotificationChannelResolver,
) {
  if (!(await renewOutboxClaim(row.id, outboxClaim))) return;
  const lockedUntil = nextNotificationClaimExpiry();
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
      () => resolveChannel(row.channel).sendToRecipient(row, recipient.openId),
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isCanceledNotificationError(error)) {
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
    const nonRetryable = isNonRetryableNotificationError(error);
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
      attempts: nonRetryable ? MAX_NOTIFICATION_ATTEMPTS : attempts,
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
        attempts: nonRetryable ? MAX_NOTIFICATION_ATTEMPTS : attempts,
        lastError: message.slice(0, 1000),
        nextRunAt: nonRetryable
          ? FROZEN_NOTIFICATION_NEXT_RUN_AT
          : nextNotificationRetryAt(attempts),
        lockedUntil: null,
      },
    });
  }
}
