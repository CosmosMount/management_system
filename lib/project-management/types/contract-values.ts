export const workSegmentTypeValues = ["PLANNED", "ACTUAL"] as const;

export const workSegmentStatusValues = [
  "PLANNED",
  "IN_PROGRESS",
  "PENDING_CONFIRMATION",
  "CONFIRMED",
  "CANCELLED",
] as const;

export const workSegmentRoleValues = [
  "OWNER",
  "LEAD",
  "DEVELOPER",
  "DESIGNER",
  "REVIEWER",
  "SUPPORT",
  "OBSERVER",
  "CUSTOM",
] as const;

export const taskPriorityValues = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
] as const;

export const resourceConflictStatusValues = [
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
  "IGNORED",
] as const;

export const resourceConflictKindValues = [
  "ALLOCATION_OVER_LIMIT",
  "MISSING_ALLOCATION",
  "HIGH_PRIORITY_OVERLAP",
  "LEAD_ROLE_OVERLAP",
  "UNAVAILABLE_TIME",
  "REVISION_OVERLAP",
  "ACTUAL_OVERLOAD",
] as const;

export const resourceConflictSeverityValues = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const;

export const taskStatusValues = [
  "DRAFT",
  "ACTIVE",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "ARCHIVED",
] as const;

export const taskNodeTypeValues = [
  "MILESTONE",
  "REVISION",
  "TERMINATION",
] as const;

export const taskNodeStatusValues = [
  "PENDING",
  "ACTIVE",
  "COMPLETED",
  "REVISED",
  "CANCELLED",
] as const;

export const taskMemberRoleValues = [
  "OWNER",
  "LEAD",
  "MEMBER",
  "REVIEWER",
  "VIEWER",
] as const;

export const revisionApprovalModeValues = [
  "DIRECT_BY_OWNER",
  "REVIEW_REQUIRED",
] as const;

export const milestoneReviewDecisionValues = [
  "APPROVED",
  "REJECTED",
  "REVISION_REQUIRED",
] as const;

export const terminationOutcomeValues = [
  "SUCCESS",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
] as const;

export const standaloneTimeCanvasScopeKindValues = [
  "PERSONAL",
  "DASHBOARD",
  "RESOURCE_PLANNER",
] as const;

export const taskScopedTimeCanvasScopeKind = "TASK_SCOPED" as const;

export const timeCanvasScopeKindValues = [
  taskScopedTimeCanvasScopeKind,
  ...standaloneTimeCanvasScopeKindValues,
] as const;

export const personTimeCanvasGrouping = "PERSON" as const;
export const taskTimeCanvasGrouping = "TASK" as const;

export const timeCanvasGroupByValues = [
  personTimeCanvasGrouping,
  taskTimeCanvasGrouping,
] as const;
