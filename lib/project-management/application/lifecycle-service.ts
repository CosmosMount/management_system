export {
  activateTask,
  createTaskDraft,
  deleteTaskDraft,
} from "@/lib/project-management/application/task-lifecycle-commands";
export type {
  CreateTaskDraftResult,
  DeleteTaskDraftResult,
} from "@/lib/project-management/application/task-lifecycle-commands";

export {
  approveRevision,
  cancelRevision,
  createRevision,
  rejectRevision,
  reviseRejectedRevision,
} from "@/lib/project-management/application/revision-commands";
export type {
  RevisionMutationResult,
} from "@/lib/project-management/application/revision-commands";

export {
  reviewMilestone,
  submitMilestoneForReview,
} from "@/lib/project-management/application/milestone-review-commands";
export type {
  MilestoneReviewMutationResult,
} from "@/lib/project-management/application/milestone-review-commands";

export { confirmTermination } from "@/lib/project-management/application/termination-commands";
