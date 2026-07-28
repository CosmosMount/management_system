import { feedbackNotificationChannel } from "@/lib/notification-channels/feedback";
import { procurementNotificationChannel } from "@/lib/notification-channels/procurement";
import {
  NonRetryableNotificationError,
  type NotificationChannelAdapter,
} from "@/lib/notification-channels/types";

const adapters = new Map<string, NotificationChannelAdapter>([
  [procurementNotificationChannel.channel, procurementNotificationChannel],
  [feedbackNotificationChannel.channel, feedbackNotificationChannel],
]);

export function getNotificationChannelAdapter(
  channel: string,
): NotificationChannelAdapter {
  const adapter = adapters.get(channel);
  if (!adapter) {
    throw new NonRetryableNotificationError(`未知通知通道: ${channel}`);
  }
  return adapter;
}
