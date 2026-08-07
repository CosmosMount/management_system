"use server";

import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import {
  createComment as createCommentService,
  createRisk as createRiskService,
  deleteComment as deleteCommentService,
  resolveRisk as resolveRiskService,
} from "@/lib/project-management/application/collaboration-service";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import {
  getActivityVersion as getActivityVersionQuery,
  getCommentPage as getCommentPageQuery,
  getRecentActivityPage as getRecentActivityPageQuery,
  getRiskPage as getRiskPageQuery,
  type CommentPageDto,
  type RecentActivityPageDto,
  type RiskPageDto,
} from "@/lib/project-management/queries/collaboration-queries";
import { revalidateProjectManagement } from "@/lib/revalidate";

export async function createRisk(input: unknown) {
  return runCollaborationMutation("pm.risk.create", "createRisk", input, createRiskService);
}

export async function resolveRisk(input: unknown) {
  return runCollaborationMutation("pm.risk.resolve", "resolveRisk", input, resolveRiskService);
}

export async function createComment(input: unknown) {
  return runCollaborationMutation("pm.comment.create", "createComment", input, createCommentService);
}

export async function deleteComment(input: unknown) {
  return runCollaborationMutation("pm.comment.delete", "deleteComment", input, deleteCommentService);
}

export async function loadRiskPage(
  input: unknown,
): Promise<ProjectManagementActionResult<RiskPageDto>> {
  return runCollaborationQuery("pm.risk.page", "loadRiskPage", input, getRiskPageQuery);
}

export async function loadCommentPage(
  input: unknown,
): Promise<ProjectManagementActionResult<CommentPageDto>> {
  return runCollaborationQuery("pm.comment.page", "loadCommentPage", input, getCommentPageQuery);
}

export async function loadRecentActivityPage(
  input: unknown,
): Promise<ProjectManagementActionResult<RecentActivityPageDto>> {
  return runCollaborationQuery(
    "pm.activity.page",
    "loadRecentActivityPage",
    input,
    getRecentActivityPageQuery,
  );
}

export async function getActivityVersion(
  input: unknown,
): Promise<ProjectManagementActionResult<{ token: string }>> {
  return runCollaborationQuery(
    "pm.activity.version",
    "getActivityVersion",
    input,
    getActivityVersionQuery,
  );
}

async function runCollaborationMutation<T>(
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
      const taskId = resultTaskId(result);
      const projectId = resultProjectId(result);
      if (taskId) log.setTaskId(taskId);
      revalidateProjectManagement(taskId ?? undefined, projectId ?? undefined);
      return result;
    },
  });
}

async function runCollaborationQuery<T>(
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

function resultTaskId(result: unknown) {
  if (!result || typeof result !== "object") return null;
  if (!("targetType" in result) || result.targetType !== "TASK") return null;
  return "targetId" in result && typeof result.targetId === "string"
    ? result.targetId
    : null;
}

function resultProjectId(result: unknown) {
  if (!result || typeof result !== "object") return null;
  if (!("targetType" in result) || result.targetType !== "PROJECT") return null;
  return "targetId" in result && typeof result.targetId === "string"
    ? result.targetId
    : null;
}
