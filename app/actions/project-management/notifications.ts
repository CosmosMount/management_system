"use server";

import {
  markAllInAppNotificationsRead as markAllInAppNotificationsReadService,
  markInAppNotificationRead as markInAppNotificationReadService,
} from "@/lib/project-management/application/notification-service";
import { updateNotificationPreference as updateNotificationPreferenceService } from "@/lib/project-management/application/notification-preference-service";
import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import { revalidateProjectManagement } from "@/lib/revalidate";

export async function markInAppNotificationRead(
  input: unknown,
): Promise<
  ProjectManagementActionResult<
    Awaited<ReturnType<typeof markInAppNotificationReadService>>
  >
> {
  return runProjectManagementAction({
    event: "pm.notification.read",
    action: "markInAppNotificationRead",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      const result = await markInAppNotificationReadService(actor, input);
      revalidateProjectManagement();
      return result;
    },
  });
}

export async function markAllInAppNotificationsRead(
  input: unknown = {},
): Promise<
  ProjectManagementActionResult<
    Awaited<ReturnType<typeof markAllInAppNotificationsReadService>>
  >
> {
  return runProjectManagementAction({
    event: "pm.notification.read_all",
    action: "markAllInAppNotificationsRead",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      const result = await markAllInAppNotificationsReadService(actor, input);
      revalidateProjectManagement();
      return result;
    },
  });
}

export async function updateNotificationPreference(
  input: unknown,
): Promise<
  ProjectManagementActionResult<
    Awaited<ReturnType<typeof updateNotificationPreferenceService>>
  >
> {
  return runProjectManagementAction({
    event: "pm.notification.preference.update",
    action: "updateNotificationPreference",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      const result = await updateNotificationPreferenceService(actor, input);
      revalidateProjectManagement();
      return result;
    },
  });
}
