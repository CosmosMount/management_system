import type { NotificationOutbox } from "@prisma/client";

export type NotificationRecipientPlan =
  | {
      supported: true;
      openIds: string[];
      directOpenIds?: string[];
      requiresDirectRecipient?: boolean;
      cancelReason?: string;
      emptyRecipientReason?: string;
    }
  | { supported: false };

export class NonRetryableNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableNotificationError";
  }
}

export class CanceledNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanceledNotificationError";
  }
}

export function isCanceledNotificationError(
  error: unknown,
): error is CanceledNotificationError {
  return error instanceof CanceledNotificationError;
}

export function isNonRetryableNotificationError(
  error: unknown,
): error is NonRetryableNotificationError {
  return error instanceof NonRetryableNotificationError;
}

export type NotificationDeliveryTarget = {
  receiveId: string;
  receiveIdType: "open_id" | "union_id";
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

export type NotificationChannelResolver = (
  channel: string,
) => NotificationChannelAdapter;
