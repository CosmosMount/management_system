"use server";

import {
  createTag as createTagService,
  deleteTag as deleteTagService,
  setTagArchived as setTagArchivedService,
  updateTag as updateTagService,
} from "@/lib/project-management/application/tag-service";
import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import { revalidateProjectManagement } from "@/lib/revalidate";

export async function createTag(input: unknown) {
  return runTagAction("pm.tag.create", "createTag", input, createTagService);
}

export async function updateTag(input: unknown) {
  return runTagAction("pm.tag.update", "updateTag", input, updateTagService);
}

export async function archiveTag(input: unknown) {
  return runTagAction("pm.tag.archive", "archiveTag", input, (actor, value) =>
    setTagArchivedService(actor, value, true),
  );
}

export async function restoreTag(input: unknown) {
  return runTagAction("pm.tag.restore", "restoreTag", input, (actor, value) =>
    setTagArchivedService(actor, value, false),
  );
}

export async function deleteTag(input: unknown) {
  return runTagAction("pm.tag.delete", "deleteTag", input, deleteTagService);
}

function runTagAction<T>(
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
      revalidateProjectManagement();
      return result;
    },
  });
}
