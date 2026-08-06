import type { TaskNodeType } from "@prisma/client";
import { planChronologyInvalidError } from "@/lib/project-management/application/errors";
import {
  inspectPlanChronology,
  type PlanChronologyCompatibility,
  type PlanChronologyIssue,
} from "@/lib/project-management/domain/plan-chronology";

type PersistedPlanEntry = {
  nodeId: string;
  sequence: number;
  isCarryForward?: boolean;
  node: {
    type: TaskNodeType;
    milestone?: { expectedCompletedAt: Date | null } | null;
    termination?: { plannedAt: Date | null } | null;
  };
};

export function assertPersistedPlanChronologyValid(
  plan: { plannedStartAt: Date | null; nodes: PersistedPlanEntry[] },
  compatibility: PlanChronologyCompatibility = "STRICT",
) {
  const issues = inspectPlanChronology(
    {
      plannedStartAt: plan.plannedStartAt,
      nodes: plan.nodes.map((entry) => ({
        nodeId: entry.nodeId,
        sequence: entry.sequence,
        type: entry.node.type,
        isCarryForward: entry.isCarryForward,
        expectedCompletedAt: entry.node.milestone?.expectedCompletedAt ?? null,
        plannedAt: entry.node.termination?.plannedAt ?? null,
      })),
    },
    compatibility,
  );
  if (issues.length > 0) {
    throw planChronologyInvalidError(
      issues[0]?.message ?? "计划时间顺序不正确",
      chronologyFieldErrors(issues),
    );
  }
}

export function chronologyFieldErrors(
  issues: PlanChronologyIssue[],
): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of issues) {
    fieldErrors[issue.path] = [
      ...(fieldErrors[issue.path] ?? []),
      issue.message,
    ];
  }
  return fieldErrors;
}
