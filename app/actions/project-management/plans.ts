"use server";

import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import {
  comparePlanVersions as comparePlanVersionsQuery,
  getPlanVersion as getPlanVersionQuery,
  getTaskWorkspace as getTaskWorkspaceQuery,
  listTaskPlanVersions as listTaskPlanVersionsQuery,
  type PlanVersionDiff,
  type PlanVersionSummary,
  type TaskWorkspace,
} from "@/lib/project-management/queries/task-queries";
import {
  getTaskLifecycleViews as getTaskLifecycleViewsQuery,
  type TaskLifecycleViews,
} from "@/lib/project-management/queries/task-lifecycle-queries";
import {
  comparePlanVersionsInputSchema,
  planVersionQueryInputSchema,
  taskLifecycleViewsInputSchema,
  taskWorkspaceQueryInputSchema,
} from "@/lib/project-management/validations/lifecycle";

export async function getTaskWorkspace(
  taskId: string,
): Promise<ProjectManagementActionResult<TaskWorkspace>> {
  return runProjectManagementAction({
    event: "pm.task.workspace.view",
    action: "getTaskWorkspace",
    callback: async (log) => {
      const parsed = taskWorkspaceQueryInputSchema.parse({ taskId });
      log.setTaskId(parsed.taskId);
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return getTaskWorkspaceQuery({ actor, taskId: parsed.taskId });
    },
  });
}

export async function getPlanVersion(
  planVersionId: string,
): Promise<ProjectManagementActionResult<PlanVersionSummary>> {
  return runProjectManagementAction({
    event: "pm.plan.view",
    action: "getPlanVersion",
    callback: async (log) => {
      const parsed = planVersionQueryInputSchema.parse({ planVersionId });
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return getPlanVersionQuery({
        actor,
        planVersionId: parsed.planVersionId,
      });
    },
  });
}

export async function listTaskPlanVersions(
  taskId: string,
): Promise<ProjectManagementActionResult<
  Awaited<ReturnType<typeof listTaskPlanVersionsQuery>>
>> {
  return runProjectManagementAction({
    event: "pm.plan.history.list",
    action: "listTaskPlanVersions",
    callback: async (log) => {
      const parsed = taskWorkspaceQueryInputSchema.parse({ taskId });
      log.setTaskId(parsed.taskId);
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return listTaskPlanVersionsQuery({ actor, taskId: parsed.taskId });
    },
  });
}

export async function comparePlanVersions(input: {
  fromPlanVersionId: string;
  toPlanVersionId: string;
}): Promise<ProjectManagementActionResult<PlanVersionDiff>> {
  return runProjectManagementAction({
    event: "pm.plan.compare",
    action: "comparePlanVersions",
    callback: async (log) => {
      const parsed = comparePlanVersionsInputSchema.parse(input);
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return comparePlanVersionsQuery({ actor, ...parsed });
    },
  });
}

export async function getTaskLifecycleViews(
  input: unknown,
): Promise<ProjectManagementActionResult<TaskLifecycleViews>> {
  return runProjectManagementAction({
    event: "pm.task.lifecycle_views.view",
    action: "getTaskLifecycleViews",
    callback: async (log) => {
      const parsed = taskLifecycleViewsInputSchema.parse(input);
      log.setTaskId(parsed.taskId);
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return getTaskLifecycleViewsQuery({ actor, ...parsed });
    },
  });
}
