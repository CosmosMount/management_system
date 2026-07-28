"use server";

import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import {
  approveRevision as approveRevisionService,
  cancelRevision as cancelRevisionService,
  createRevisionDraft as createRevisionDraftService,
  rejectRevision as rejectRevisionService,
  submitRevision as submitRevisionService,
  type RevisionMutationResult,
} from "@/lib/project-management/application/lifecycle-service";
import {
  getCurrentProjectManagementActor,
  type ProjectManagementActor,
} from "@/lib/project-management/identity";
import { revalidateProjectManagement } from "@/lib/revalidate";

export async function createRevisionDraft(
  input: unknown,
): Promise<
  ProjectManagementActionResult<RevisionMutationResult & { created: boolean }>
> {
  return runRevisionAction("pm.revision.create", "createRevisionDraft", (actor) =>
    createRevisionDraftService(actor, input),
  );
}

export async function submitRevision(
  input: unknown,
): Promise<ProjectManagementActionResult<RevisionMutationResult>> {
  return runRevisionAction("pm.revision.submit", "submitRevision", (actor) =>
    submitRevisionService(actor, input),
  );
}

export async function approveRevision(
  input: unknown,
): Promise<ProjectManagementActionResult<RevisionMutationResult>> {
  return runRevisionAction("pm.revision.approve", "approveRevision", (actor) =>
    approveRevisionService(actor, input),
  );
}

export async function rejectRevision(
  input: unknown,
): Promise<ProjectManagementActionResult<RevisionMutationResult>> {
  return runRevisionAction("pm.revision.reject", "rejectRevision", (actor) =>
    rejectRevisionService(actor, input),
  );
}

export async function cancelRevision(
  input: unknown,
): Promise<ProjectManagementActionResult<RevisionMutationResult>> {
  return runRevisionAction("pm.revision.cancel", "cancelRevision", (actor) =>
    cancelRevisionService(actor, input),
  );
}

async function runRevisionAction<T extends RevisionMutationResult>(
  event: string,
  action: string,
  callback: (actor: ProjectManagementActor) => Promise<T>,
): Promise<ProjectManagementActionResult<T>> {
  return runProjectManagementAction({
    event,
    action,
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      const result = await callback(actor);
      log.setTaskId(result.taskId);
      revalidateProjectManagement(result.taskId);
      return result;
    },
  });
}
