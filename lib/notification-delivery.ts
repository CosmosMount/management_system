import { getNotificationChannelAdapter } from "@/lib/notification-channel-registry";
import { logger } from "@/lib/logger";
import { drainNotificationOutboxWithResolver } from "@/lib/notification-outbox";

type DrainNotificationOutboxOptions = {
  ignoreDeliveryDisabled?: boolean;
};

export function drainNotificationOutboxSoon(limit = 5) {
  if (process.env.NOTIFICATION_DELIVERY_DISABLED === "true") return;
  void drainNotificationOutbox(limit).catch((error) => {
    logger.error("notification.outbox.drain.failed", {
      module: "notification",
      action: "drainNotificationOutboxSoon",
      result: "failure",
      error,
    });
  });
}

export async function drainNotificationOutbox(
  limit = 20,
  options: DrainNotificationOutboxOptions = {},
): Promise<number> {
  return drainNotificationOutboxWithResolver(
    getNotificationChannelAdapter,
    limit,
    options,
  );
}
