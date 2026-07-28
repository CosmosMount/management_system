"use server";

import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import {
  acknowledgeConflict as acknowledgeConflictService,
  applyConflictSuggestion as applyConflictSuggestionService,
  ignoreConflict as ignoreConflictService,
  previewConflictSuggestion as previewConflictSuggestionService,
  resolveConflict as resolveConflictService,
  scanConflictsForPerson as scanConflictsForPersonService,
  scanResourceConflicts as scanResourceConflictsService,
} from "@/lib/project-management/application/conflict-service";
import { assertAuthorized } from "@/lib/project-management/authorization";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import {
  getResourceConflict as getResourceConflictQuery,
  listResourceConflicts as listResourceConflictsQuery,
} from "@/lib/project-management/queries/resource-queries";
import { revalidateProjectManagement } from "@/lib/revalidate";

export async function scanConflictsForPerson(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof scanConflictsForPersonService>>>> {
  return runAdminConflictAction(
    "pm.conflict.scan",
    "scanConflictsForPerson",
    input,
    async () => scanConflictsForPersonService(input),
  );
}

export async function scanResourceConflicts(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof scanResourceConflictsService>>>> {
  return runAdminConflictAction(
    "pm.conflict.scan",
    "scanResourceConflicts",
    input,
    async () => scanResourceConflictsService(input),
  );
}

export async function listResourceConflicts(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof listResourceConflictsQuery>>>> {
  return runProjectManagementAction({
    event: "pm.conflict.list",
    action: "listResourceConflicts",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return listResourceConflictsQuery({ actor, input });
    },
  });
}

export async function getResourceConflict(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof getResourceConflictQuery>>>> {
  return runProjectManagementAction({
    event: "pm.conflict.get",
    action: "getResourceConflict",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return getResourceConflictQuery({ actor, input });
    },
  });
}

export async function acknowledgeConflict(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof acknowledgeConflictService>>>> {
  return runConflictMutation(
    "pm.conflict.acknowledge",
    "acknowledgeConflict",
    input,
    acknowledgeConflictService,
  );
}

export async function resolveConflict(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof resolveConflictService>>>> {
  return runConflictMutation(
    "pm.conflict.resolve",
    "resolveConflict",
    input,
    resolveConflictService,
  );
}

export async function ignoreConflict(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof ignoreConflictService>>>> {
  return runConflictMutation(
    "pm.conflict.ignore",
    "ignoreConflict",
    input,
    ignoreConflictService,
  );
}

export async function previewConflictSuggestion(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof previewConflictSuggestionService>>>> {
  return runProjectManagementAction({
    event: "pm.conflict.preview_suggestion",
    action: "previewConflictSuggestion",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return previewConflictSuggestionService(actor, input);
    },
  });
}

export async function applyConflictSuggestion(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof applyConflictSuggestionService>>>> {
  return runConflictMutation(
    "pm.conflict.apply_suggestion",
    "applyConflictSuggestion",
    input,
    applyConflictSuggestionService,
  );
}

async function runConflictMutation<T>(
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

async function runAdminConflictAction<T>(
  event: string,
  action: string,
  input: unknown,
  callback: () => Promise<T>,
): Promise<ProjectManagementActionResult<T>> {
  return runProjectManagementAction({
    event,
    action,
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      assertAuthorized({
        actor,
        action: "conflict.resolve",
        resource: { type: "system" },
      });
      const result = await callback();
      revalidateProjectManagement();
      return result;
    },
  });
}
