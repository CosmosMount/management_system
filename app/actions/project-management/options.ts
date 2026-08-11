"use server";

import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import {
  resolvePeopleOptionsByIds as resolvePeopleOptionsByIdsQuery,
  resolveTaskOptionsByIds as resolveTaskOptionsByIdsQuery,
  searchPeople as searchPeopleQuery,
  searchTaskOptions as searchTaskOptionsQuery,
} from "@/lib/project-management/queries/option-queries";
import type {
  PersonOptionDto,
  PersonOptionPage,
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

export async function resolvePeopleOptionsByIds(
  input: unknown,
): Promise<ProjectManagementActionResult<PersonOptionDto[]>> {
  return runProjectManagementAction({
    event: "pm.options.people.resolve",
    action: "resolvePeopleOptionsByIds",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return resolvePeopleOptionsByIdsQuery({ actor, input });
    },
  });
}

export async function resolveTaskOptionsByIds(
  input: unknown,
): Promise<ProjectManagementActionResult<TaskOptionPage["items"]>> {
  return runProjectManagementAction({
    event: "pm.options.tasks.resolve",
    action: "resolveTaskOptionsByIds",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return resolveTaskOptionsByIdsQuery({ actor, input });
    },
  });
}
