"use server";

import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import {
  confirmTermination as confirmTerminationService,
} from "@/lib/project-management/application/lifecycle-service";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import { revalidateProjectManagement } from "@/lib/revalidate";

export async function confirmTermination(
  input: unknown,
): Promise<
  ProjectManagementActionResult<
    Awaited<ReturnType<typeof confirmTerminationService>>
  >
> {
  return runProjectManagementAction({
    event: "pm.termination.confirm",
    action: "confirmTermination",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      const result = await confirmTerminationService(actor, input);
      log.setTaskId(result.taskId);
      revalidateProjectManagement(result.taskId);
      return result;
    },
  });
}
