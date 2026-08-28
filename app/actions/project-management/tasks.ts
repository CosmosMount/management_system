"use server";

import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import {
  activateTask as activateTaskService,
  createTaskDraft as createTaskDraftService,
  deleteTaskDraft as deleteTaskDraftService,
  type CreateTaskDraftResult,
} from "@/lib/project-management/application/lifecycle-service";
import {
  updateActiveTask as updateActiveTaskService,
  updateTaskDraft as updateTaskDraftService,
} from "@/lib/project-management/application/task-mutation-service";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import { drainNotificationOutboxSoon } from "@/lib/notification-delivery";
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
      drainNotificationOutboxSoon();
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
      drainNotificationOutboxSoon();
      log.setTaskId(result.taskId);
      revalidateProjectManagement(result.taskId);
      return result;
    },
  });
}

export async function deleteTaskDraft(
  input: unknown,
): Promise<
  ProjectManagementActionResult<
    Awaited<ReturnType<typeof deleteTaskDraftService>>
  >
> {
  return runTaskMutationAction(
    "pm.task.draft.delete",
    "deleteTaskDraft",
    input,
    deleteTaskDraftService,
  );
}

export async function updateTaskDraft(
  input: unknown,
): Promise<
  ProjectManagementActionResult<Awaited<ReturnType<typeof updateTaskDraftService>>>
> {
  return runTaskMutationAction(
    "pm.task.draft.update",
    "updateTaskDraft",
    input,
    updateTaskDraftService,
  );
}

export async function updateActiveTask(
  input: unknown,
): Promise<
  ProjectManagementActionResult<Awaited<ReturnType<typeof updateActiveTaskService>>>
> {
  return runTaskMutationAction(
    "pm.task.update",
    "updateActiveTask",
    input,
    updateActiveTaskService,
  );
}

async function runTaskMutationAction<T>(
  event: string,
  action: string,
  input: unknown,
  service: (
    actor: Awaited<ReturnType<typeof getCurrentProjectManagementActor>>,
    input: unknown,
  ) => Promise<T>,
): Promise<ProjectManagementActionResult<T>> {
  return runProjectManagementAction({
    event,
    action,
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      const result = await service(actor, input);
      drainNotificationOutboxSoon();
      const taskId = taskIdFromMutationResult(result);
      log.setTaskId(taskId);
      revalidateProjectManagement(taskId);
      return result;
    },
  });
}

function taskIdFromMutationResult(result: unknown): string {
  if (
    !result ||
    typeof result !== "object" ||
    !("taskId" in result) ||
    typeof result.taskId !== "string"
  ) {
    throw new Error("Task mutation 未返回 taskId");
  }
  return result.taskId;
}
