"use server";

import { z } from "zod";
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
import { getTimeCanvasData as getTimeCanvasDataQuery } from "@/lib/project-management/queries/time-canvas-queries";

const canvasQueryRequestSchema = z
  .object({
    operation: z.enum([
      "getTimeCanvasData",
      "searchPeople",
      "searchTaskOptions",
      "listTagOptions",
      "getMyWorkDashboard",
    ]),
    input: z.unknown().optional().default({}),
  })
  .strict();

type CanvasQueryResult =
  | Awaited<ReturnType<typeof getTimeCanvasDataQuery>>
  | Awaited<ReturnType<typeof searchPeopleQuery>>
  | Awaited<ReturnType<typeof searchTaskOptionsQuery>>
  | Awaited<ReturnType<typeof listTagOptionsQuery>>
  | Awaited<ReturnType<typeof getMyWorkDashboardQuery>>;

export async function dispatchCanvasQuery(
  request: unknown,
): Promise<ProjectManagementActionResult<CanvasQueryResult>> {
  return runProjectManagementAction({
    event: "pm.canvas.query.dispatch",
    action: "dispatchCanvasQuery",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      const parsed = canvasQueryRequestSchema.parse(request);
      switch (parsed.operation) {
        case "getTimeCanvasData":
          return getTimeCanvasDataQuery({ actor, input: parsed.input });
        case "searchPeople":
          return searchPeopleQuery({ actor, input: parsed.input });
        case "searchTaskOptions":
          return searchTaskOptionsQuery({ actor, input: parsed.input });
        case "listTagOptions":
          return listTagOptionsQuery({ actor, input: parsed.input });
        case "getMyWorkDashboard":
          return getMyWorkDashboardQuery({ actor, input: parsed.input });
      }
    },
  });
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
