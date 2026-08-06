import "server-only";

import { randomUUID } from "node:crypto";
import type {
  TaskComposerRevisionAnchor,
  TaskComposerSeed,
} from "@/components/project-management/task-composer-client";
import { isoToShanghaiDateTimeLocal } from "@/lib/project-management/date-time";
import type {
  PlanVersionSummary,
  TaskWorkspace,
} from "@/lib/project-management/queries/task-queries";
import type { RevisionComposerRecord } from "@/lib/project-management/queries/task-lifecycle-queries";

export function buildCreateRevisionComposerSeed(
  workspace: TaskWorkspace,
): TaskComposerSeed | null {
  const terminationEntry = workspace.currentPlan.nodes.find(
    (entry) => entry.termination,
  );
  if (!terminationEntry?.termination || !workspace.currentPlan.plannedStartAt) {
    return null;
  }
  const lockedMilestoneIds = workspace.currentPlan.nodes.flatMap((entry) =>
    entry.milestone && entry.status === "COMPLETED" ? [entry.nodeId] : [],
  );
  const carriedAnchors = effectiveRevisionAnchors(workspace.currentPlan);
  const lowerBoundary = Math.max(
    new Date(workspace.currentPlan.plannedStartAt).getTime(),
    ...workspace.currentPlan.nodes.flatMap((entry) =>
      entry.milestone && entry.status === "COMPLETED"
        ? [new Date(entry.milestone.expectedCompletedAt).getTime()]
        : [],
    ),
    ...carriedAnchors.map((anchor) => localMs(anchor.revisionAt)),
  );
  const terminalAt = new Date(terminationEntry.termination.plannedAt).getTime();
  const revisionAt = Math.min(
    terminalAt,
    Math.max(lowerBoundary, Date.now()),
  );
  const markerId = `draft-revision-${randomUUID()}`;
  return baseSeed({
    workspace,
    plan: workspace.currentPlan,
    markerId,
    reason: "",
    description: "",
    revisionAt: new Date(revisionAt).toISOString(),
    reviewRound: 1,
    lockedMilestoneIds,
    carriedAnchors,
  });
}

export function buildResubmitRevisionComposerSeed({
  workspace,
  targetPlan,
  revision,
}: {
  workspace: TaskWorkspace;
  targetPlan: PlanVersionSummary;
  revision: RevisionComposerRecord;
}): TaskComposerSeed | null {
  if (!targetPlan.plannedStartAt) return null;
  const revisionIndex = targetPlan.nodes.findIndex(
    (entry) => entry.nodeId === revision.taskNodeId,
  );
  const terminationEntry = targetPlan.nodes.find((entry) => entry.termination);
  if (revisionIndex < 0 || !terminationEntry?.termination) return null;
  const carriedEntries = targetPlan.nodes.slice(0, revisionIndex);
  const lockedMilestoneIds = carriedEntries.flatMap((entry) =>
    entry.milestone ? [entry.nodeId] : [],
  );
  const carriedAnchors = carriedEntries.flatMap((entry) =>
    entry.revision
      ? [
          {
            id: entry.nodeId,
            reason: entry.revision.reason,
            description: entry.businessDescription,
            revisionAt: isoToShanghaiDateTimeLocal(entry.revision.revisionAt),
            status: entry.revision.status,
          },
        ]
      : [],
  );
  return baseSeed({
    workspace,
    plan: targetPlan,
    markerId: revision.taskNodeId,
    reason: revision.reason,
    description: revision.description,
    revisionAt: revision.revisionAt,
    reviewRound: revision.reviewRound,
    lockedMilestoneIds,
    carriedAnchors,
  });
}

function baseSeed({
  workspace,
  plan,
  markerId,
  reason,
  description,
  revisionAt,
  reviewRound,
  lockedMilestoneIds,
  carriedAnchors,
}: {
  workspace: TaskWorkspace;
  plan: PlanVersionSummary;
  markerId: string;
  reason: string;
  description: string;
  revisionAt: string;
  reviewRound: number;
  lockedMilestoneIds: string[];
  carriedAnchors: TaskComposerRevisionAnchor[];
}): TaskComposerSeed | null {
  const terminationEntry = plan.nodes.find((entry) => entry.termination);
  if (!terminationEntry?.termination || !plan.plannedStartAt) return null;
  return {
    draftId: randomUUID(),
    title: workspace.task.title,
    description: workspace.task.description,
    team: workspace.task.team,
    techGroup: workspace.task.techGroup,
    priority: workspace.task.priority,
    tagIds: workspace.tags.map((tag) => tag.id),
    relatedTaskId: workspace.task.relatedTaskId,
    projectId: workspace.task.projectId,
    members: workspace.members.flatMap(({ personId, role }) =>
      role === "OWNER" || role === "PARTICIPANT"
        ? [{ personId, role }]
        : [],
    ),
    plannedStartAt: isoToShanghaiDateTimeLocal(plan.plannedStartAt),
    milestones: plan.nodes.flatMap((entry) =>
      entry.milestone
        ? [
            {
              id: entry.nodeId,
              goal: entry.milestone.goal,
              completionCriteria: entry.milestone.completionCriteria,
              expectedCompletedAt: isoToShanghaiDateTimeLocal(
                entry.milestone.expectedCompletedAt,
              ),
              reviewRequirements: entry.milestone.reviewRequirements,
              businessDescription: entry.businessDescription,
            },
          ]
        : [],
    ),
    termination: {
      id: terminationEntry.nodeId,
      name: terminationEntry.termination.name,
      plannedAt: isoToShanghaiDateTimeLocal(
        terminationEntry.termination.plannedAt,
      ),
      plannedOutcomeCriteria:
        terminationEntry.termination.plannedOutcomeCriteria,
      businessDescription: terminationEntry.businessDescription,
    },
    selectedEntityId: markerId,
    revision: {
      markerId,
      reason,
      description,
      revisionAt: isoToShanghaiDateTimeLocal(revisionAt),
      reviewRound,
      lockedMilestoneIds,
      carriedAnchors,
    },
  };
}

function effectiveRevisionAnchors(plan: PlanVersionSummary) {
  return plan.nodes.flatMap((entry) =>
    entry.revision && entry.revision.status === "EFFECTIVE"
      ? [
          {
            id: entry.nodeId,
            reason: entry.revision.reason,
            description: entry.businessDescription,
            revisionAt: isoToShanghaiDateTimeLocal(entry.revision.revisionAt),
            status: entry.revision.status,
          },
        ]
      : [],
  );
}

function localMs(value: string) {
  return new Date(`${value}:00+08:00`).getTime();
}
