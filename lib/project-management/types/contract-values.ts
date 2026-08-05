export const workSegmentTypeValues = ["PLANNED", "ACTUAL"] as const;

export const workSegmentStatusValues = [
  "PLANNED",
  "IN_PROGRESS",
  "PENDING_CONFIRMATION",
  "CONFIRMED",
  "CANCELLED",
] as const;

export const taskPriorityValues = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
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
  "PARTICIPANT",
] as const;

export type ActiveTaskMemberRole = (typeof taskMemberRoleValues)[number];

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
