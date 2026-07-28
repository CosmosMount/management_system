"use server";

import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import {
  reviewMilestone as reviewMilestoneService,
  submitMilestoneForReview as submitMilestoneForReviewService,
  type MilestoneReviewMutationResult,
} from "@/lib/project-management/application/lifecycle-service";
import {
  getCurrentProjectManagementActor,
  type ProjectManagementActor,
} from "@/lib/project-management/identity";
import { revalidateProjectManagement } from "@/lib/revalidate";

export async function submitMilestoneForReview(
  input: unknown,
): Promise<
  ProjectManagementActionResult<
    MilestoneReviewMutationResult & { created: boolean }
  >
> {
  return runMilestoneAction(
    "pm.milestone.review.submit",
    "submitMilestoneForReview",
    (actor) => submitMilestoneForReviewService(actor, input),
  );
}

export async function approveMilestoneReview(input: {
  reviewId: string;
  comment?: string;
}): Promise<ProjectManagementActionResult<MilestoneReviewMutationResult>> {
  return runMilestoneAction(
    "pm.milestone.review.approve",
    "approveMilestoneReview",
    (actor) =>
      reviewMilestoneService(actor, {
        ...input,
        result: "APPROVED",
      }),
  );
}

export async function rejectMilestoneReview(input: {
  reviewId: string;
  comment: string;
}): Promise<ProjectManagementActionResult<MilestoneReviewMutationResult>> {
  return runMilestoneAction(
    "pm.milestone.review.reject",
    "rejectMilestoneReview",
    (actor) =>
      reviewMilestoneService(actor, {
        ...input,
        result: "REJECTED",
      }),
  );
}

export async function requireMilestoneRevision(input: {
  reviewId: string;
  comment: string;
}): Promise<ProjectManagementActionResult<MilestoneReviewMutationResult>> {
  return runMilestoneAction(
    "pm.milestone.review.require_revision",
    "requireMilestoneRevision",
    (actor) =>
      reviewMilestoneService(actor, {
        ...input,
        result: "REVISION_REQUIRED",
      }),
  );
}

async function runMilestoneAction<T extends MilestoneReviewMutationResult>(
  event: string,
  action: string,
  callback: (actor: ProjectManagementActor) => Promise<T>,
): Promise<ProjectManagementActionResult<T>> {
  return runProjectManagementAction({
    event,
    action,
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      const result = await callback(actor);
      log.setTaskId(result.taskId);
      revalidateProjectManagement(result.taskId);
      return result;
    },
  });
}
