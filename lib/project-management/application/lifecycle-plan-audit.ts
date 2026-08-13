import { createHash } from "node:crypto";
import { hashPlanSnapshot } from "@/lib/project-management/application/plan-snapshot";
import {
  boundedAuditText,
  stableStringify,
} from "@/lib/project-management/application/stable-serialization";
import type { LifecyclePlanEntry } from "@/lib/project-management/application/lifecycle-records";

export function hashLifecycleRequest(operation: string, input: unknown): string {
  return createHash("sha256")
    .update(stableStringify({ operation, input }))
    .digest("hex");
}

export function hashLifecyclePlan(plan: {
  plannedStartAt: Date | null;
  nodes: LifecyclePlanEntry[];
}): string {
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

export function revisionPlanAuditState(plan: {
  plannedStartAt: Date | null;
  nodes: LifecyclePlanEntry[];
}) {
  return {
    plannedStartAt: plan.plannedStartAt?.toISOString() ?? null,
    snapshotHash: hashLifecyclePlan(plan),
    nodeCount: plan.nodes.length,
    nodeOrder: plan.nodes.slice(0, 202).map((entry) => ({
      nodeId: entry.nodeId,
      sequence: entry.sequence,
      type: entry.node.type,
    })),
  };
}

export function summarizeRevisionPlanChanges(
  before: { plannedStartAt: Date | null; nodes: LifecyclePlanEntry[] },
  after: { plannedStartAt: Date | null; nodes: LifecyclePlanEntry[] },
) {
  const beforeById = new Map(before.nodes.map((entry) => [entry.nodeId, entry]));
  const afterById = new Map(after.nodes.map((entry) => [entry.nodeId, entry]));
  const removedEntries = before.nodes.filter(
    (entry) => !afterById.has(entry.nodeId),
  );
  const addedEntries = after.nodes.filter(
    (entry) => !beforeById.has(entry.nodeId),
  );
  const changedEntries = after.nodes.flatMap((entry) => {
    const previous = beforeById.get(entry.nodeId);
    if (!previous) return [];
    const previousView = revisionNodeAuditView(previous);
    const nextView = revisionNodeAuditView(entry);
    if (stableStringify(previousView) === stableStringify(nextView)) return [];
    return [{ nodeId: entry.nodeId, before: previousView, after: nextView }];
  });
  const removed = removedEntries.slice(0, 50).map(revisionNodeAuditView);
  const added = addedEntries.slice(0, 50).map(revisionNodeAuditView);
  const changed = changedEntries.slice(0, 50);
  return {
    plannedStartAtChanged:
      before.plannedStartAt?.toISOString() !== after.plannedStartAt?.toISOString(),
    removedTotal: removedEntries.length,
    addedTotal: addedEntries.length,
    changedTotal: changedEntries.length,
    removed,
    added,
    changed,
    truncated:
      removedEntries.length > removed.length ||
      addedEntries.length > added.length ||
      changedEntries.length > changed.length,
  };
}

function revisionNodeAuditView(entry: LifecyclePlanEntry) {
  return {
    nodeId: entry.nodeId,
    sequence: entry.sequence,
    type: entry.node.type,
    businessDescription: boundedAuditText(entry.node.businessDescription),
    milestone: entry.node.milestone
      ? {
          goal: boundedAuditText(entry.node.milestone.goal),
          completionCriteria: boundedAuditText(
            entry.node.milestone.completionCriteria,
          ),
          expectedCompletedAt:
            entry.node.milestone.expectedCompletedAt.toISOString(),
          reviewRequirements: boundedAuditText(
            entry.node.milestone.reviewRequirements,
          ),
        }
      : null,
    termination: entry.node.termination
      ? {
          name: boundedAuditText(entry.node.termination.name),
          plannedAt: entry.node.termination.plannedAt.toISOString(),
          plannedOutcomeCriteria: boundedAuditText(
            entry.node.termination.plannedOutcomeCriteria,
          ),
        }
      : null,
  };
}
