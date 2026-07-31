"use server";

import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import {
  listTagOptions as listTagOptionsQuery,
  searchPeople as searchPeopleQuery,
  searchTaskOptions as searchTaskOptionsQuery,
} from "@/lib/project-management/queries/option-queries";
import type {
  PersonOptionPage,
  TagOptionPage,
  TaskOptionPage,
} from "@/lib/project-management/types/time-canvas";

export async function searchPeopleOptions(
  input: unknown,
): Promise<ProjectManagementActionResult<PersonOptionPage>> {
  return runProjectManagementAction({
    event: "pm.options.people.search",
    action: "searchPeopleOptions",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return searchPeopleQuery({ actor, input });
    },
  });
}

export async function searchTaskOptions(
  input: unknown,
): Promise<ProjectManagementActionResult<TaskOptionPage>> {
  return runProjectManagementAction({
    event: "pm.options.tasks.search",
    action: "searchTaskOptions",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return searchTaskOptionsQuery({ actor, input });
    },
  });
}

export async function searchTagOptions(
  input: unknown,
): Promise<ProjectManagementActionResult<TagOptionPage>> {
  return runProjectManagementAction({
    event: "pm.options.tags.search",
    action: "searchTagOptions",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return listTagOptionsQuery({ actor, input });
    },
  });
}
