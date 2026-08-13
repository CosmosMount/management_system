export const MAX_NOTIFICATION_ATTEMPTS = 8;
export const FROZEN_NOTIFICATION_NEXT_RUN_AT = new Date(
  "9999-12-31T00:00:00.000Z",
);

const DEFAULT_RECIPIENT_LOCK_MS = 2 * 60 * 1000;

export function notificationRecipientLockMs(): number {
  if (process.env.NODE_ENV !== "test") return DEFAULT_RECIPIENT_LOCK_MS;
  const override = Number(process.env.NOTIFICATION_OUTBOX_TEST_LOCK_MS);
  return Number.isFinite(override) && override >= 100
    ? override
    : DEFAULT_RECIPIENT_LOCK_MS;
}

export function nextNotificationClaimExpiry() {
  return new Date(Date.now() + notificationRecipientLockMs());
}

export function nextNotificationRetryAt(attempts: number): Date {
  const delaySeconds = Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + delaySeconds * 1000);
}
