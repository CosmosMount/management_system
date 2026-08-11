import { z } from "zod";
import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import { getMyWorkDashboard } from "@/lib/project-management/queries/dashboard-queries";
import {
  searchPeople,
  searchTaskOptions,
} from "@/lib/project-management/queries/option-queries";
import {
  getAdaptiveTimeCanvasBlock,
  getTimeCanvasData,
} from "@/lib/project-management/queries/time-canvas-queries";

const canvasQueryRequestSchema = z
  .object({
    operation: z.enum([
      "getTimeCanvasData",
      "getAdaptiveTimeCanvasBlock",
      "searchPeople",
      "searchTaskOptions",
      "getMyWorkDashboard",
    ]),
    input: z.unknown().optional().default({}),
  })
  .strict();

type CanvasQueryResult =
  | Awaited<ReturnType<typeof getTimeCanvasData>>
  | Awaited<ReturnType<typeof getAdaptiveTimeCanvasBlock>>
  | Awaited<ReturnType<typeof searchPeople>>
  | Awaited<ReturnType<typeof searchTaskOptions>>
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
        case "getAdaptiveTimeCanvasBlock":
          return getAdaptiveTimeCanvasBlock({ actor, input: parsed.input });
        case "searchPeople":
          return searchPeople({ actor, input: parsed.input });
        case "searchTaskOptions":
          return searchTaskOptions({ actor, input: parsed.input });
        case "getMyWorkDashboard":
          return getMyWorkDashboard({ actor, input: parsed.input });
      }
    },
  });
}
