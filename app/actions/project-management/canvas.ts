"use server";

import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import { getMyWorkDashboard as getMyWorkDashboardQuery } from "@/lib/project-management/queries/dashboard-queries";
import {
  listTagOptions as listTagOptionsQuery,
  searchPeople as searchPeopleQuery,
  searchTaskOptions as searchTaskOptionsQuery,
} from "@/lib/project-management/queries/option-queries";
import {
  getAdaptiveTimeCanvasBlock as getAdaptiveTimeCanvasBlockQuery,
  getPersonalDueSegments as getPersonalDueSegmentsQuery,
  getTimeCanvasData as getTimeCanvasDataQuery,
} from "@/lib/project-management/queries/time-canvas-queries";
import { dispatchCanvasQueryRequest } from "@/lib/project-management/application/canvas-query-dispatcher";

export async function dispatchCanvasQuery(
  request: unknown,
) {
  return dispatchCanvasQueryRequest(request);
}

export async function getTimeCanvasData(
  input: unknown,
): Promise<
  ProjectManagementActionResult<
    Awaited<ReturnType<typeof getTimeCanvasDataQuery>>
  >
> {
  return runCanvasAction("pm.canvas.get", "getTimeCanvasData", input, (actor, value) =>
    getTimeCanvasDataQuery({ actor, input: value }),
  );
}

export async function getAdaptiveTimeCanvasBlock(input: unknown) {
  return runCanvasAction(
    "pm.canvas.block.get",
    "getAdaptiveTimeCanvasBlock",
    input,
    (actor, value) => getAdaptiveTimeCanvasBlockQuery({ actor, input: value }),
  );
}

export async function getPersonalDueSegments(input: unknown = {}) {
  return runCanvasAction(
    "pm.canvas.personal_due.get",
    "getPersonalDueSegments",
    input,
    (actor, value) => getPersonalDueSegmentsQuery({ actor, input: value }),
  );
}

export async function searchPeople(
  input: unknown,
): Promise<
  ProjectManagementActionResult<Awaited<ReturnType<typeof searchPeopleQuery>>>
> {
  return runCanvasAction("pm.canvas.people.search", "searchPeople", input, (actor, value) =>
    searchPeopleQuery({ actor, input: value }),
  );
}

export async function searchTaskOptions(
  input: unknown,
): Promise<
  ProjectManagementActionResult<
    Awaited<ReturnType<typeof searchTaskOptionsQuery>>
  >
> {
  return runCanvasAction(
    "pm.canvas.tasks.search",
    "searchTaskOptions",
    input,
    (actor, value) => searchTaskOptionsQuery({ actor, input: value }),
  );
}

export async function listTagOptions(
  input: unknown,
): Promise<
  ProjectManagementActionResult<Awaited<ReturnType<typeof listTagOptionsQuery>>>
> {
  return runCanvasAction("pm.canvas.tags.list", "listTagOptions", input, (actor, value) =>
    listTagOptionsQuery({ actor, input: value }),
  );
}

export async function getMyWorkDashboard(
  input: unknown = {},
): Promise<
  ProjectManagementActionResult<
    Awaited<ReturnType<typeof getMyWorkDashboardQuery>>
  >
> {
  return runCanvasAction(
    "pm.dashboard.my_work.get",
    "getMyWorkDashboard",
    input,
    (actor, value) => getMyWorkDashboardQuery({ actor, input: value }),
  );
}

async function runCanvasAction<T>(
  event: string,
  action: string,
  input: unknown,
  query: (
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
      return query(actor, input);
    },
  });
}
