import type {
  TaskMemberRole,
  TaskPriority,
  TaskStatus,
} from "@prisma/client";
import type { TaskPendingApproval } from "@/lib/project-management/task-approval-gate";
import type { PlanVersionSummary } from "@/lib/project-management/queries/task-plan-queries";

type TaskMemberSummary = {
  personId: string;
  role: TaskMemberRole;
  displayName: string;
};

export type TaskListItem = {
  id: string;
  title: string;
  description: string;
  team: string;
  techGroup: string;
  status: TaskStatus;
  priority: TaskPriority;
  project: { id: string; name: string; avatarPath: string | null } | null;
  currentPlanVersionNo: number;
  lockVersion: number;
  activeMilestone: {
    nodeId: string;
    goal: string;
    expectedCompletedAt: string;
  } | null;
  activeTermination: {
    nodeId: string;
    name: string;
    plannedAt: string;
  } | null;
  members: TaskMemberSummary[];
  updatedAt: string;
  createdAt: string;
};

export type TaskListResult = {
  items: TaskListItem[];
  nextCursor: string | null;
  hasMoreByQuery: boolean;
};

export type TaskWorkspace = {
  task: {
    id: string;
    title: string;
    description: string;
    team: string;
    techGroup: string;
    status: TaskStatus;
    priority: TaskPriority;
    relatedTaskId: string | null;
    projectId: string | null;
    project: { id: string; name: string; avatarPath: string | null } | null;
    currentPlanVersionId: string;
    activeMilestoneNodeId: string | null;
    lockVersion: number;
    startedAt: string | null;
    endedAt: string | null;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  members: TaskMemberSummary[];
  currentPlan: PlanVersionSummary;
  pendingApproval: TaskPendingApproval | null;
  pendingApprovalConflict: boolean;
  pendingRevisionPlanComparison: PendingRevisionPlanComparison | null;
  permissions: {
    canUpdateMetadata: boolean;
    canManageMembers: boolean;
    canActivate: boolean;
    canDeleteDraft: boolean;
    canCreateRevision: boolean;
    canSubmitMilestoneReview: boolean;
    canReviewMilestone: boolean;
    canSubmitTerminationReview: boolean;
    canReviewTermination: boolean;
    canViewHistory: boolean;
  };
};

export type PendingRevisionPlanComparison =
  | {
      status: "READY";
      revisionNodeId: string;
      revisionReason: string;
      revisionAt: string;
      plan: PlanVersionSummary;
    }
  | {
      status: "UNAVAILABLE";
      revisionNodeId: string;
      message: string;
    };
