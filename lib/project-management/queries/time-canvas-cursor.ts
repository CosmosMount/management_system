import { createHash } from "node:crypto";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import type {
  TimeCanvasRowDto,
  TimeCanvasTaskAnchorDto,
} from "@/lib/project-management/types/time-canvas";
import type { GetTimeCanvasDataInput } from "@/lib/project-management/validations/time-canvas";

export function canvasCursorFilter(
  input: GetTimeCanvasDataInput,
  includeRange = true,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        scope: input.scope,
        range: includeRange
          ? [input.rangeStart.toISOString(), input.rangeEnd.toISOString()]
          : undefined,
        personIds: [...input.personIds].sort(),
        taskIds: [...input.taskIds].sort(),
        groupBy: input.groupBy,
        includeTaskAnchors: input.includeTaskAnchors,
        includeBusyBlocks: input.includeBusyBlocks,
      }),
    )
    .digest("base64url")
    .slice(0, 22);
}

export function createRowPageKey(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  rows: TimeCanvasRowDto[],
  anchors: TimeCanvasTaskAnchorDto[],
  logicalRange?: { startMs: number; endMs: number },
  segmentEpoch?: unknown,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        actorAccountId: actor.accountId,
        semanticFilter: canvasCursorFilter(input, !logicalRange),
        logicalRange: logicalRange
          ? [
              new Date(logicalRange.startMs).toISOString(),
              new Date(logicalRange.endMs).toISOString(),
            ]
          : [input.rangeStart.toISOString(), input.rangeEnd.toISOString()],
        rows,
        anchors: anchors.map((task) => [
          task.id,
          task.versionToken,
          task.nodes.map((node) => [node.id, node.versionToken]),
        ]),
        segmentEpoch,
      }),
    )
    .digest("base64url")
    .slice(0, 32);
}
