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
import {
  replaceTaskDraftMembers as replaceTaskDraftMembersService,
  replaceTaskDraftPlan as replaceTaskDraftPlanService,
  replaceTaskMembers as replaceTaskMembersService,
  replaceTaskTags as replaceTaskTagsService,
  updateTaskDraft as updateTaskDraftService,
  updateTaskDraftMetadata as updateTaskDraftMetadataService,
  updateTaskMetadata as updateTaskMetadataService,
} from "@/lib/project-management/application/task-mutation-service";
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

export async function updateTaskDraftMetadata(
  input: unknown,
): Promise<
  ProjectManagementActionResult<
    Awaited<ReturnType<typeof updateTaskDraftMetadataService>>
  >
> {
  return runTaskMutationAction(
    "pm.task.draft_metadata.update",
    "updateTaskDraftMetadata",
    input,
    updateTaskDraftMetadataService,
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

export async function replaceTaskDraftMembers(
  input: unknown,
): Promise<
  ProjectManagementActionResult<
    Awaited<ReturnType<typeof replaceTaskDraftMembersService>>
  >
> {
  return runTaskMutationAction(
    "pm.task.draft_members.replace",
    "replaceTaskDraftMembers",
    input,
    replaceTaskDraftMembersService,
  );
}

export async function replaceTaskDraftPlan(
  input: unknown,
): Promise<
  ProjectManagementActionResult<
    Awaited<ReturnType<typeof replaceTaskDraftPlanService>>
  >
> {
  return runTaskMutationAction(
    "pm.task.draft_plan.replace",
    "replaceTaskDraftPlan",
    input,
    replaceTaskDraftPlanService,
  );
}

export async function updateTaskMetadata(
  input: unknown,
): Promise<
  ProjectManagementActionResult<
    Awaited<ReturnType<typeof updateTaskMetadataService>>
  >
> {
  return runTaskMutationAction(
    "pm.task.metadata.update",
    "updateTaskMetadata",
    input,
    updateTaskMetadataService,
  );
}

export async function replaceTaskMembers(
  input: unknown,
): Promise<
  ProjectManagementActionResult<
    Awaited<ReturnType<typeof replaceTaskMembersService>>
  >
> {
  return runTaskMutationAction(
    "pm.task.members.replace",
    "replaceTaskMembers",
    input,
    replaceTaskMembersService,
  );
}

export async function replaceTaskTags(
  input: unknown,
): Promise<
  ProjectManagementActionResult<
    Awaited<ReturnType<typeof replaceTaskTagsService>>
  >
> {
  return runTaskMutationAction(
    "pm.task.tags.replace",
    "replaceTaskTags",
    input,
    replaceTaskTagsService,
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
