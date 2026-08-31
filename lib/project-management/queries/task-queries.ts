export {
  comparePlanVersions,
  getMilestoneCompletionDetails,
  getPlanVersion,
  getRevisionBasePlan,
  listTaskPlanVersions,
} from "@/lib/project-management/queries/task-plan-queries";
export type {
  MilestoneCompletionDetails,
  PlanVersionDiff,
  PlanVersionSummary,
  RevisionBasePlanDetails,
} from "@/lib/project-management/queries/task-plan-queries";
export { listTasks } from "@/lib/project-management/queries/task-list-queries";
export {
  getTaskWorkspace,
} from "@/lib/project-management/queries/task-workspace-queries";
export type {
  PendingRevisionPlanComparison,
  TaskListItem,
  TaskListResult,
  TaskWorkspace,
} from "@/lib/project-management/queries/task-query-types";
