import type { ProjectManagementNotificationPayload } from "@/lib/project-management/notifications/contract";

export const PROJECT_MANAGEMENT_NOTIFICATION_AGGREGATION_WINDOW_ENV =
  "PROJECT_MANAGEMENT_NOTIFICATION_AGGREGATION_WINDOW_SECONDS";
export const DEFAULT_PROJECT_MANAGEMENT_NOTIFICATION_AGGREGATION_WINDOW_SECONDS =
  30;
export const MAX_PROJECT_MANAGEMENT_NOTIFICATION_AGGREGATION_WINDOW_SECONDS =
  300;

const standaloneKinds = new Set<ProjectManagementNotificationPayload["kind"]>([
  "project_management_global_summary_daily",
  "project_management_personal_summary_daily",
]);

export function isProjectManagementNotificationAggregationEligible(
  payload: ProjectManagementNotificationPayload,
) {
  return (
    payload.purpose === "notification" &&
    !payload.mandatory &&
    !standaloneKinds.has(payload.kind)
  );
}

export function projectManagementNotificationAggregationWindowSeconds() {
  const raw = process.env[
    PROJECT_MANAGEMENT_NOTIFICATION_AGGREGATION_WINDOW_ENV
  ]?.trim();
  if (!raw) {
    return DEFAULT_PROJECT_MANAGEMENT_NOTIFICATION_AGGREGATION_WINDOW_SECONDS;
  }
  const seconds = Number(raw);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    seconds > MAX_PROJECT_MANAGEMENT_NOTIFICATION_AGGREGATION_WINDOW_SECONDS
  ) {
    throw new Error(
      `${PROJECT_MANAGEMENT_NOTIFICATION_AGGREGATION_WINDOW_ENV} 必须是 0-${MAX_PROJECT_MANAGEMENT_NOTIFICATION_AGGREGATION_WINDOW_SECONDS} 的整数`,
    );
  }
  return seconds;
}
