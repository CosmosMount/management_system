import { prisma } from "@/lib/prisma";
import {
  FROZEN_NOTIFICATION_NEXT_RUN_AT,
  MAX_NOTIFICATION_ATTEMPTS,
  nextNotificationRetryAt,
} from "@/lib/notification-outbox/constants";
import type { NotificationDeliveryClaim } from "@/lib/notification-outbox/types";

export async function updateOutboxStatusFromRecipients(
  outboxId: string,
  claim: NotificationDeliveryClaim,
): Promise<{ completed: boolean }> {
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
    recipients.every(
      (item) => item.status === "SENT" || item.status === "CANCELED",
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
      item.attempts < MAX_NOTIFICATION_ATTEMPTS,
  );
  const recipientsExhausted = retryableRecipients.length === 0;
  const now = new Date();
  const nextRunAt =
    (recipientsExhausted
      ? FROZEN_NOTIFICATION_NEXT_RUN_AT
      : retryableRecipients
          .map((item) =>
            item.status === "PROCESSING" &&
            item.lockedUntil &&
            item.lockedUntil > now
              ? item.lockedUntil
              : item.nextRunAt,
          )
          .sort((a, b) => a.getTime() - b.getTime())[0]) ??
    nextNotificationRetryAt(MAX_NOTIFICATION_ATTEMPTS);
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
      attempts: recipientsExhausted ? MAX_NOTIFICATION_ATTEMPTS : undefined,
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
