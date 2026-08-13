import type { Prisma } from "@prisma/client";
import type { NotificationContext } from "@/lib/app-origin";
import type {
  FeedbackCreatedNotificationPayload,
  FeedbackReplyNotificationPayload,
  FeedbackStatusNotificationPayload,
} from "@/lib/feishu-feedback";
import { enqueueNotificationTx } from "@/lib/notification-outbox";
import type { FeedbackOutboxPayload } from "@/lib/notification-channels/feedback";

export async function enqueueFeedbackCreatedNotificationTx(
  tx: Prisma.TransactionClient,
  eventKey: string,
  payload: FeedbackCreatedNotificationPayload,
  context?: NotificationContext,
) {
  return enqueueNotificationTx(tx, {
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

export async function enqueueFeedbackReplyNotificationTx(
  tx: Prisma.TransactionClient,
  eventKey: string,
  payload: FeedbackReplyNotificationPayload,
  context?: NotificationContext,
) {
  if (!hasFeedbackReplyRecipient(payload)) return { created: false };
  return enqueueNotificationTx(tx, {
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

function hasFeedbackReplyRecipient(
  payload: FeedbackReplyNotificationPayload,
): boolean {
  return (
    !payload.actorIsAdmin ||
    (payload.recipientOpenIds?.some((openId) => openId.trim().length > 0) ?? false)
  );
}

export async function enqueueFeedbackStatusNotificationTx(
  tx: Prisma.TransactionClient,
  eventKey: string,
  payload: FeedbackStatusNotificationPayload,
  context?: NotificationContext,
) {
  return enqueueNotificationTx(tx, {
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
