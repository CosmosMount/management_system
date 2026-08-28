"use server";

import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import {
  getActionInbox,
  type ActionInboxPage,
} from "@/lib/project-management/queries/action-inbox-queries";

export async function loadActionInboxPage(
  input: unknown,
): Promise<ProjectManagementActionResult<ActionInboxPage>> {
  return runProjectManagementAction({
    event: "pm.action_inbox.list",
    action: "loadActionInboxPage",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return getActionInbox({ actor, input });
    },
  });
}
