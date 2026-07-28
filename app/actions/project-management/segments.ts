"use server";

import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import {
  batchCreatePlannedSegments as batchCreatePlannedSegmentsService,
  cancelPlannedSegment as cancelPlannedSegmentService,
  confirmPlannedSegment as confirmPlannedSegmentService,
  createActualSegment as createActualSegmentService,
  createWorkSegment as createWorkSegmentService,
  mergePlannedSegments as mergePlannedSegmentsService,
  movePlannedSegments as movePlannedSegmentsService,
  partiallyConfirmSegment as partiallyConfirmSegmentService,
  relinkPlannedSegment as relinkPlannedSegmentService,
  scanSegmentTransitions as scanSegmentTransitionsService,
  softDeleteActualSegment as softDeleteActualSegmentService,
  splitPlannedSegment as splitPlannedSegmentService,
  updateWorkSegment as updateWorkSegmentService,
} from "@/lib/project-management/application/segment-service";
import { assertAuthorized } from "@/lib/project-management/authorization";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import {
  getWorkSegment as getWorkSegmentQuery,
  listWorkSegmentChanges as listWorkSegmentChangesQuery,
  listWorkSegments as listWorkSegmentsQuery,
} from "@/lib/project-management/queries/resource-queries";
import { revalidateProjectManagement } from "@/lib/revalidate";

export async function createWorkSegment(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof createWorkSegmentService>>>> {
  return runSegmentAction("pm.segment.create", "createWorkSegment", input, createWorkSegmentService);
}

export async function batchCreatePlannedSegments(
  input: unknown,
): Promise<
  ProjectManagementActionResult<Awaited<ReturnType<typeof batchCreatePlannedSegmentsService>>>
> {
  return runSegmentAction(
    "pm.segment.create",
    "batchCreatePlannedSegments",
    input,
    batchCreatePlannedSegmentsService,
  );
}

export async function updateWorkSegment(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof updateWorkSegmentService>>>> {
  return runSegmentAction("pm.segment.update", "updateWorkSegment", input, updateWorkSegmentService);
}

export async function movePlannedSegments(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof movePlannedSegmentsService>>>> {
  return runSegmentAction("pm.segment.update", "movePlannedSegments", input, movePlannedSegmentsService);
}

export async function splitPlannedSegment(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof splitPlannedSegmentService>>>> {
  return runSegmentAction("pm.segment.split", "splitPlannedSegment", input, splitPlannedSegmentService);
}

export async function mergePlannedSegments(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof mergePlannedSegmentsService>>>> {
  return runSegmentAction("pm.segment.merge", "mergePlannedSegments", input, mergePlannedSegmentsService);
}

export async function cancelPlannedSegment(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof cancelPlannedSegmentService>>>> {
  return runSegmentAction("pm.segment.cancel", "cancelPlannedSegment", input, cancelPlannedSegmentService);
}

export async function confirmPlannedSegment(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof confirmPlannedSegmentService>>>> {
  return runSegmentAction("pm.segment.confirm", "confirmPlannedSegment", input, confirmPlannedSegmentService);
}

export async function partiallyConfirmSegment(
  input: unknown,
): Promise<
  ProjectManagementActionResult<Awaited<ReturnType<typeof partiallyConfirmSegmentService>>>
> {
  return runSegmentAction(
    "pm.segment.confirm",
    "partiallyConfirmSegment",
    input,
    partiallyConfirmSegmentService,
  );
}

export async function createActualSegment(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof createActualSegmentService>>>> {
  return runSegmentAction("pm.segment.create", "createActualSegment", input, createActualSegmentService);
}

export async function relinkPlannedSegment(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof relinkPlannedSegmentService>>>> {
  return runSegmentAction("pm.segment.relink", "relinkPlannedSegment", input, relinkPlannedSegmentService);
}

export async function softDeleteActualSegment(
  input: unknown,
): Promise<
  ProjectManagementActionResult<Awaited<ReturnType<typeof softDeleteActualSegmentService>>>
> {
  return runSegmentAction(
    "pm.segment.delete",
    "softDeleteActualSegment",
    input,
    softDeleteActualSegmentService,
  );
}

export async function listWorkSegments(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof listWorkSegmentsQuery>>>> {
  return runProjectManagementAction({
    event: "pm.segment.list",
    action: "listWorkSegments",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return listWorkSegmentsQuery({ actor, input });
    },
  });
}

export async function getWorkSegment(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof getWorkSegmentQuery>>>> {
  return runProjectManagementAction({
    event: "pm.segment.get",
    action: "getWorkSegment",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return getWorkSegmentQuery({ actor, input });
    },
  });
}

export async function listWorkSegmentChanges(
  input: unknown,
): Promise<ProjectManagementActionResult<Awaited<ReturnType<typeof listWorkSegmentChangesQuery>>>> {
  return runProjectManagementAction({
    event: "pm.segment.changes",
    action: "listWorkSegmentChanges",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return listWorkSegmentChangesQuery({ actor, input });
    },
  });
}

export async function scanSegmentTransitions(): Promise<
  ProjectManagementActionResult<Awaited<ReturnType<typeof scanSegmentTransitionsService>>>
> {
  return runProjectManagementAction({
    event: "pm.segment.scan_transitions",
    action: "scanSegmentTransitions",
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      assertAuthorized({
        actor,
        action: "segment.manage_others",
        resource: { type: "system" },
      });
      const result = await scanSegmentTransitionsService();
      revalidateProjectManagement();
      return result;
    },
  });
}

async function runSegmentAction<T>(
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
      revalidateProjectManagement(firstTaskId(result));
      return result;
    },
  });
}

function firstTaskId(result: unknown) {
  const record = result && typeof result === "object" ? result : null;
  if (!record) return undefined;
  const segment = "segment" in record ? record.segment : null;
  if (segment && typeof segment === "object" && "taskId" in segment) {
    const taskId = segment.taskId;
    return typeof taskId === "string" ? taskId : undefined;
  }
  const segments = "segments" in record ? record.segments : null;
  if (Array.isArray(segments)) {
    for (const item of segments) {
      if (item && typeof item === "object" && "taskId" in item) {
        const taskId = item.taskId;
        if (typeof taskId === "string") return taskId;
      }
    }
  }
  return undefined;
}
