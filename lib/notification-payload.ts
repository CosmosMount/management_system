import type { NotificationOutbox } from "@prisma/client";
import type { ZodType } from "zod";
import { NonRetryableNotificationError } from "@/lib/notification-channel-adapter";

export function parseNotificationPayload<T>(
  row: NotificationOutbox,
  schema: ZodType<T>,
  labels: {
    invalidJson: string;
    invalidPayload: string;
    metadata: (kind: unknown) => string;
  },
): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.payload);
  } catch {
    throw new NonRetryableNotificationError(labels.invalidJson);
  }
  const result = schema.safeParse(decoded);
  if (!result.success) {
    throw new NonRetryableNotificationError(labels.invalidPayload);
  }
  const data = result.data;
  if (
    !data ||
    typeof data !== "object" ||
    !("kind" in data) ||
    row.type !== data.kind
  ) {
    throw new NonRetryableNotificationError(
      labels.metadata(
        data && typeof data === "object" && "kind" in data ? data.kind : "未知",
      ),
    );
  }
  return data;
}
