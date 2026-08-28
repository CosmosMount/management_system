export const NOTIFICATION_OUTBOX_CRON = "*/5 * * * * *";
export const PROJECT_MANAGEMENT_SEGMENT_TRANSITIONS_CRON = "*/5 * * * * *";

export function createNonOverlappingCronRunner(
  run: () => Promise<void>,
  onOverlap: () => void,
) {
  let running = false;

  return async (): Promise<boolean> => {
    if (running) {
      onOverlap();
      return false;
    }

    running = true;
    try {
      await run();
      return true;
    } finally {
      running = false;
    }
  };
}
