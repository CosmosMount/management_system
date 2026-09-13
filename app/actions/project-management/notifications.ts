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
import { runReminderNow as runReminderNowService } from "@/lib/project-management/application/reminder-execution-service";
import { runAdminGlobalSummaryNow as runSummaryNow, listAdminGlobalSummaryRuns as listSummaryRuns } from "@/lib/project-management/application/admin-global-summary-service";

export async function runReminderNow(input: unknown) {
  return runProjectManagementAction({ event: "pm.reminder.execute", action: "runReminderNow", callback: async (log) => {
    const actor = await getCurrentProjectManagementActor();
    log.setActorAccountId(actor.accountId);
    return runReminderNowService(actor, input);
  } });
}

export async function runAdminGlobalSummaryNow(input: unknown) {
  return runProjectManagementAction({ event: "pm.admin_global_summary.manual", action: "runAdminGlobalSummaryNow", callback: async (log) => {
    const actor = await getCurrentProjectManagementActor();
    log.setActorAccountId(actor.accountId);
    const result = await runSummaryNow(actor, input);
    revalidateProjectManagement();
    return result;
  } });
}

export async function listAdminGlobalSummaryRuns() {
  return runProjectManagementAction({ event: "pm.admin_global_summary.list", action: "listAdminGlobalSummaryRuns", callback: async (log) => {
    const actor = await getCurrentProjectManagementActor();
    log.setActorAccountId(actor.accountId);
    return listSummaryRuns(actor);
  } });
}

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

import {
  createReminderSetting as createReminderSettingService,
  deleteReminderSetting as deleteReminderSettingService,
  listReminderSettings as listReminderSettingsService,
  updateReminderSetting as updateReminderSettingService,
} from "@/lib/project-management/application/reminder-setting-service";

export async function listReminderSettings(): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof listReminderSettingsService>>>> {
  return runProjectManagementAction({ event: "pm.reminder_setting.list", action: "listReminderSettings", callback: async (log) => {
    const actor = await getCurrentProjectManagementActor(); log.setActorAccountId(actor.accountId); return listReminderSettingsService(actor);
  }});
}

export async function createReminderSetting(input: unknown): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof createReminderSettingService>>>> {
  return runProjectManagementAction({ event: "pm.reminder_setting.create", action: "createReminderSetting", callback: async (log) => {
    const actor = await getCurrentProjectManagementActor(); log.setActorAccountId(actor.accountId); return createReminderSettingService(actor, input);
  }});
}

export async function updateReminderSetting(input: unknown): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof updateReminderSettingService>>>> {
  return runProjectManagementAction({ event: "pm.reminder_setting.update", action: "updateReminderSetting", callback: async (log) => {
    const actor = await getCurrentProjectManagementActor(); log.setActorAccountId(actor.accountId); return updateReminderSettingService(actor, input);
  }});
}

export async function deleteReminderSetting(input: unknown): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof deleteReminderSettingService>>>> {
  return runProjectManagementAction({ event: "pm.reminder_setting.delete", action: "deleteReminderSetting", callback: async (log) => {
    const actor = await getCurrentProjectManagementActor(); log.setActorAccountId(actor.accountId); return deleteReminderSettingService(actor, input);
  }});
}
