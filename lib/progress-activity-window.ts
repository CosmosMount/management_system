export const ACTIVITY_RECENT_DAYS = 7;

export function getRecentActivityCutoff(): Date {
  return new Date(
    Date.now() - ACTIVITY_RECENT_DAYS * 24 * 60 * 60 * 1000,
  );
}
