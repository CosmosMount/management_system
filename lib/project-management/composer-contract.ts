export const TASK_COMPOSER_START_ID = "task-composer-start";

export type TaskMemberRoleValue = "OWNER" | "PARTICIPANT";
export type TaskPriorityValue = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type TaskComposerMilestone = {
  id: string;
  goal: string;
  completionCriteria: string;
  expectedCompletedAt: string;
  reviewRequirements: string;
  businessDescription: string;
};

export type TaskComposerNodeMeta = {
  lifecycle: "TEMPORARY" | "ESTABLISHED";
  lastValidAt: string;
};

export type TaskComposerRevisionAnchor = {
  id: string;
  reason: string;
  description: string;
  revisionAt: string;
  status: string;
};

export type TaskComposerRevisionContext = {
  markerId: string;
  reason: string;
  description: string;
  revisionAt: string;
  reviewRound: number;
  lockedMilestoneIds: string[];
  carriedAnchors: TaskComposerRevisionAnchor[];
};

export type TaskComposerSeed = {
  draftId: string;
  title: string;
  description: string;
  team: string;
  techGroup: string;
  priority: TaskPriorityValue;
  relatedTaskId: string | null;
  projectId?: string | null;
  members: Array<{ personId: string; role: TaskMemberRoleValue }>;
  plannedStartAt: string;
  milestones: TaskComposerMilestone[];
  termination: {
    id: string;
    name: string;
    plannedAt: string;
    plannedOutcomeCriteria: string;
    businessDescription: string;
  };
  selectedEntityId: string | null;
  revision?: TaskComposerRevisionContext;
  /** Composer-only presentation state. It is never included in the server payload. */
  nodeMeta?: Record<string, TaskComposerNodeMeta>;
};

export type TaskComposerInspectorDraft =
  | {
      kind: "START";
      entityId: typeof TASK_COMPOSER_START_ID;
      plannedStartAt: string;
      returnEntityId: string | null;
    }
  | {
      kind: "MILESTONE";
      entityId: string;
      milestone: TaskComposerMilestone;
      isNew: boolean;
      returnEntityId: string | null;
    }
  | {
      kind: "TERMINATION";
      entityId: string;
      termination: TaskComposerSeed["termination"];
      returnEntityId: string | null;
    }
  | {
      kind: "REVISION";
      entityId: string;
      revision: TaskComposerRevisionAnchor;
      isCurrent: boolean;
      returnEntityId: string | null;
    };

export type TaskComposerValidationIssue = {
  key: string;
  message: string;
  entityId?: string;
};

export type TaskComposerMode =
  | { kind: "CREATE" }
  | {
      kind: "EDIT_DRAFT";
      taskId: string;
      planVersionId: string;
      expectedLockVersion: number;
      existingNodeIds: string[];
      canManageMembers: boolean;
    }
  | {
      kind: "CREATE_REVISION";
      taskId: string;
      basePlanVersionId: string;
      baseVersionNo: number;
      baseTaskLockVersion: number;
    }
  | {
      kind: "RESUBMIT_REVISION";
      taskId: string;
      revisionNodeId: string;
      basePlanVersionId: string;
      baseVersionNo: number;
      baseTaskLockVersion: number;
      targetVersionNo: number;
      expectedTargetPlanUpdatedAt: string;
    };
