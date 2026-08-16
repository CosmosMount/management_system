"use server";

import {
  runProjectManagementAction,
  type ProjectManagementActionResult,
} from "@/lib/project-management/application/action-result";
import {
  reviewTermination as reviewTerminationService,
  submitTerminationForReview as submitTerminationForReviewService,
  type TerminationReviewMutationResult,
} from "@/lib/project-management/application/lifecycle-service";
import {
  getCurrentProjectManagementActor,
  type ProjectManagementActor,
} from "@/lib/project-management/identity";
import { revalidateProjectManagement } from "@/lib/revalidate";

export async function submitTerminationForReview(
  input: unknown,
): Promise<
  ProjectManagementActionResult<
    TerminationReviewMutationResult & { created: boolean }
  >
> {
  return runTerminationAction(
    "pm.termination.review.submit",
    "submitTerminationForReview",
    (actor) => submitTerminationForReviewService(actor, input),
  );
}

export async function approveTerminationReview(input: {
  reviewId: string;
  comment?: string;
}): Promise<ProjectManagementActionResult<TerminationReviewMutationResult>> {
  return runTerminationAction(
    "pm.termination.review.approve",
    "approveTerminationReview",
    (actor) =>
      reviewTerminationService(actor, { ...input, result: "APPROVED" }),
  );
}

export async function rejectTerminationReview(input: {
  reviewId: string;
  comment: string;
}): Promise<ProjectManagementActionResult<TerminationReviewMutationResult>> {
  return runTerminationAction(
    "pm.termination.review.reject",
    "rejectTerminationReview",
    (actor) =>
      reviewTerminationService(actor, { ...input, result: "REJECTED" }),
  );
}

export async function requireTerminationRevision(input: {
  reviewId: string;
  comment: string;
}): Promise<ProjectManagementActionResult<TerminationReviewMutationResult>> {
  return runTerminationAction(
    "pm.termination.review.require_revision",
    "requireTerminationRevision",
    (actor) =>
      reviewTerminationService(actor, {
        ...input,
        result: "REVISION_REQUIRED",
      }),
  );
}

async function runTerminationAction<T extends TerminationReviewMutationResult>(
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
