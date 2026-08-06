import { z } from "zod";
import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import { getMyWorkDashboard } from "@/lib/project-management/queries/dashboard-queries";
import {
  listTagOptions,
  searchPeople,
  searchTaskOptions,
} from "@/lib/project-management/queries/option-queries";
import { getTimeCanvasData } from "@/lib/project-management/queries/time-canvas-queries";

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
  | Awaited<ReturnType<typeof getTimeCanvasData>>
  | Awaited<ReturnType<typeof searchPeople>>
  | Awaited<ReturnType<typeof searchTaskOptions>>
  | Awaited<ReturnType<typeof listTagOptions>>
  | Awaited<ReturnType<typeof getMyWorkDashboard>>;

/** Shared application dispatcher used by both HTTP and Server Action transports. */
export async function dispatchCanvasQueryRequest(
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
          return getTimeCanvasData({ actor, input: parsed.input });
        case "searchPeople":
          return searchPeople({ actor, input: parsed.input });
        case "searchTaskOptions":
          return searchTaskOptions({ actor, input: parsed.input });
        case "listTagOptions":
          return listTagOptions({ actor, input: parsed.input });
        case "getMyWorkDashboard":
          return getMyWorkDashboard({ actor, input: parsed.input });
      }
    },
  });
}
