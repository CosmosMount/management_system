import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { taskReadableWhere } from "@/lib/project-management/authorization";
import { queryLimitExceededError } from "@/lib/project-management/application/errors";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import type { TimeCanvasTaskAnchorDto } from "@/lib/project-management/types/time-canvas";
import {
  MAX_TIME_CANVAS_ANCHOR_NODES,
  type GetTimeCanvasDataInput,
} from "@/lib/project-management/validations/time-canvas";
import {
  anchorTaskSelect,
  type CanvasTask,
  type FullSegment,
} from "@/lib/project-management/queries/time-canvas-records";
import { toTaskAnchorDto } from "@/lib/project-management/queries/time-canvas-dto";

export async function loadTaskAnchors(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  scopeTask: CanvasTask | null,
  rowIds: string[],
  segments: FullSegment[],
): Promise<TimeCanvasTaskAnchorDto[]> {
  const candidateIds = new Set<string>();
  if (input.groupBy === "TASK") {
    rowIds.forEach((taskId) => candidateIds.add(taskId));
  } else {
    if (scopeTask) candidateIds.add(scopeTask.id);
    input.taskIds.forEach((taskId) => candidateIds.add(taskId));
    segments.forEach((segment) => {
      if (segment.taskId) candidateIds.add(segment.taskId);
    });
  }
  if (candidateIds.size === 0) return [];
  const anchorWhere: Prisma.TaskWhereInput = {
    AND: [{ id: { in: [...candidateIds] } }, taskReadableWhere(actor)],
  };
  const candidates = await prisma.task.findMany({
    where: anchorWhere,
    select: { id: true, currentPlanVersionId: true },
    orderBy: [{ title: "asc" }, { id: "asc" }],
  });
  const nodeCount = await prisma.planVersionNode.count({
    where: {
      planVersionId: {
        in: candidates.map((task) => task.currentPlanVersionId),
      },
      node: { deletedAt: null },
    },
  });
  if (nodeCount > MAX_TIME_CANVAS_ANCHOR_NODES) {
    throw queryLimitExceededError(
      "授权过滤后的 anchor Node 超过 5000 条，请缩小范围后重试",
    );
  }
  const tasks = await prisma.task.findMany({
    where: {
      AND: [
        { id: { in: candidates.map((task) => task.id) } },
        taskReadableWhere(actor),
      ],
    },
    select: anchorTaskSelect,
    orderBy: [{ title: "asc" }, { id: "asc" }],
  });
  const serializedNodeCount = tasks.reduce(
    (count, task) => count + task.currentPlanVersion.nodes.length,
    0,
  );
  if (serializedNodeCount > MAX_TIME_CANVAS_ANCHOR_NODES) {
    throw queryLimitExceededError(
      "授权过滤后的 anchor Node 超过 5000 条，请缩小范围后重试",
    );
  }
  return tasks.map((task) => toTaskAnchorDto(actor, task));
}
