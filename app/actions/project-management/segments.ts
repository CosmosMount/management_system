"use server";

import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import {
  createWorkSegment as createWorkSegmentService,
  updateWorkSegment as updateWorkSegmentService,
  softDeleteWorkSegment as softDeleteWorkSegmentService,
  type SegmentMutationResult,
} from "@/lib/project-management/application/segment-service";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import {
  getWorkSegment as getWorkSegmentQuery,
  listWorkSegmentChanges as listWorkSegmentChangesQuery,
  listWorkSegments as listWorkSegmentsQuery,
} from "@/lib/project-management/queries/resource-queries";
import { revalidateProjectManagement } from "@/lib/revalidate";

export async function createWorkSegment(input: unknown) {
  return runSegmentAction("pm.segment.create", "createWorkSegment", input, createWorkSegmentService);
}

export async function updateWorkSegment(input: unknown) {
  return runSegmentAction("pm.segment.update", "updateWorkSegment", input, updateWorkSegmentService);
}

export async function softDeleteWorkSegment(input: unknown) {
  return runSegmentAction("pm.segment.delete", "softDeleteWorkSegment", input, softDeleteWorkSegmentService);
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

async function runSegmentAction<T extends SegmentMutationResult>(
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
      revalidateProjectManagement(result.segment.taskId ?? undefined);
      return result;
    },
  });
}
