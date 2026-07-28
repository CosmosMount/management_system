"use server";

import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import {
  activateTask as activateTaskService,
  createTaskDraft as createTaskDraftService,
  type CreateTaskDraftResult,
} from "@/lib/project-management/application/lifecycle-service";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import { revalidateProjectManagement } from "@/lib/revalidate";

export async function createTaskDraft(
  input: unknown,
): Promise<ProjectManagementActionResult<CreateTaskDraftResult>> {
  return runProjectManagementAction({
    event: "pm.task.create",
    action: "createTaskDraft",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      const result = await createTaskDraftService(actor, input);
      log.setTaskId(result.taskId);
      revalidateProjectManagement(result.taskId);
      return result;
    },
  });
}

export async function activateTask(
  input: unknown,
): Promise<
  ProjectManagementActionResult<Awaited<ReturnType<typeof activateTaskService>>>
> {
  return runProjectManagementAction({
    event: "pm.task.activate",
    action: "activateTask",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      const result = await activateTaskService(actor, input);
      log.setTaskId(result.taskId);
      revalidateProjectManagement(result.taskId);
      return result;
    },
  });
}
