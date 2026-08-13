import { hashPlanSnapshot } from "@/lib/project-management/application/plan-snapshot";
import type {
  PlanForMutation,
  TaskMutationPlanEntry,
} from "@/lib/project-management/application/task-mutation-records";

const PLAN_AUDIT_NODE_DETAIL_LIMIT = 201;

export function hashTaskMutationPlan(plan: PlanForMutation): string {
  return hashPlanSnapshot({
    plannedStartAt: plan.plannedStartAt?.toISOString() ?? null,
    nodes: plan.nodes.map((entry) => ({
      sequence: entry.sequence,
      nodeId: entry.nodeId,
      type: entry.node.type,
      businessDescription: entry.node.businessDescription,
      milestone: entry.node.milestone
        ? {
            goal: entry.node.milestone.goal,
            completionCriteria: entry.node.milestone.completionCriteria,
            expectedCompletedAt:
              entry.node.milestone.expectedCompletedAt.toISOString(),
            reviewRequirements: entry.node.milestone.reviewRequirements,
          }
        : null,
      revision: entry.node.revision
        ? {
            reason: entry.node.revision.reason,
            revisionAt: entry.node.revision.revisionAt.toISOString(),
            reviewRound: entry.node.revision.reviewRound,
            basePlanVersionId: entry.node.revision.basePlanVersionId,
          }
        : null,
      termination: entry.node.termination
        ? {
            ...(entry.node.termination.name !== "Terminal"
              ? { name: entry.node.termination.name }
              : {}),
            plannedOutcomeCriteria:
              entry.node.termination.plannedOutcomeCriteria,
            plannedAt: entry.node.termination.plannedAt.toISOString(),
          }
        : null,
    })),
  });
}

export function auditPlanState(plan: PlanForMutation) {
  return {
    plannedStartAt: plan.plannedStartAt?.toISOString() ?? null,
    snapshotHash: plan.snapshotHash,
    nodeCount: plan.nodes.length,
  };
}

export function summarizePlanChanges(
  beforePlan: PlanForMutation,
  afterPlan: PlanForMutation,
) {
  const beforeById = new Map(
    beforePlan.nodes.map((entry) => [entry.nodeId, entry] as const),
  );
  const afterById = new Map(
    afterPlan.nodes.map((entry) => [entry.nodeId, entry] as const),
  );
  const retained = afterPlan.nodes.filter((entry) => beforeById.has(entry.nodeId));
  const added = afterPlan.nodes.filter((entry) => !beforeById.has(entry.nodeId));
  const removed = beforePlan.nodes.filter((entry) => !afterById.has(entry.nodeId));
  const reordered = retained.flatMap((entry) => {
    const before = beforeById.get(entry.nodeId);
    if (!before || before.sequence === entry.sequence) return [];
    return [{
      nodeId: entry.nodeId,
      type: entry.node.type,
      beforeSequence: before.sequence,
      afterSequence: entry.sequence,
    }];
  });
  const changedNodes = retained.flatMap((entry) => {
    const before = beforeById.get(entry.nodeId);
    if (!before) return [];
    const beforeFields = planNodeComparableFields(before);
    const afterFields = planNodeComparableFields(entry);
    const fields = Object.keys(afterFields).filter(
      (field) => beforeFields[field] !== afterFields[field],
    );
    return fields.length > 0
      ? [{ nodeId: entry.nodeId, type: entry.node.type, fields }]
      : [];
  });
  const fieldCounts: Record<string, number> = {};
  for (const node of changedNodes) {
    for (const field of node.fields) {
      fieldCounts[field] = (fieldCounts[field] ?? 0) + 1;
    }
  }
  return {
    retained: boundedPlanAuditDetails(retained.map(planNodeIdentity)),
    added: boundedPlanAuditDetails(added.map(planNodeIdentity)),
    removed: boundedPlanAuditDetails(removed.map(planNodeIdentity)),
    reordered: boundedPlanAuditDetails(reordered),
    fieldChanges: {
      plannedStartAtChanged:
        beforePlan.plannedStartAt?.toISOString() !==
        afterPlan.plannedStartAt?.toISOString(),
      nodeCount: changedNodes.length,
      byField: fieldCounts,
      nodes: boundedPlanAuditDetails(changedNodes),
    },
  };
}

function planNodeIdentity(entry: TaskMutationPlanEntry) {
  return { nodeId: entry.nodeId, type: entry.node.type };
}

function boundedPlanAuditDetails<T>(entries: T[]) {
  return {
    totalCount: entries.length,
    truncated: entries.length > PLAN_AUDIT_NODE_DETAIL_LIMIT,
    entries: entries.slice(0, PLAN_AUDIT_NODE_DETAIL_LIMIT),
  };
}

function planNodeComparableFields(
  entry: TaskMutationPlanEntry,
): Record<string, string | null> {
  return {
    type: entry.node.type,
    businessDescription: entry.node.businessDescription,
    goal: entry.node.milestone?.goal ?? null,
    completionCriteria: entry.node.milestone?.completionCriteria ?? null,
    expectedCompletedAt:
      entry.node.milestone?.expectedCompletedAt.toISOString() ?? null,
    reviewRequirements: entry.node.milestone?.reviewRequirements ?? null,
    plannedOutcomeCriteria:
      entry.node.termination?.plannedOutcomeCriteria ?? null,
    terminationName: entry.node.termination?.name ?? null,
    plannedAt: entry.node.termination?.plannedAt.toISOString() ?? null,
  };
}
