import type { NotificationOutbox } from "@prisma/client";
import type { FeishuReceiveIdType } from "@/lib/feishu-recipient";

export type NotificationRecipientPlan =
  | {
      supported: true;
      openIds: string[];
      directOpenIds?: string[];
      requiresDirectRecipient?: boolean;
    }
  | { supported: false };

export class NonRetryableNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableNotificationError";
  }
}

export function isNonRetryableNotificationError(
  error: unknown,
): error is NonRetryableNotificationError {
  return error instanceof NonRetryableNotificationError;
}

export type NotificationDeliveryTarget = {
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
} | null;

export interface NotificationChannelAdapter {
  readonly channel: string;
  resolveRecipientPlan(
    row: NotificationOutbox,
  ): Promise<NotificationRecipientPlan>;
  sendToRecipient(
    row: NotificationOutbox,
    recipientOpenId: string,
  ): Promise<NotificationDeliveryTarget>;
  sendComposite(row: NotificationOutbox): Promise<void>;
  beforeRecipientDelivery?(row: NotificationOutbox): Promise<void>;
}
