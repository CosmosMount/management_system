export type PlanChronologyNode = {
  nodeId?: string;
  sequence: number;
  type: "MILESTONE" | "REVISION" | "TERMINATION";
  isCarryForward?: boolean;
  expectedCompletedAt?: Date | string | null;
  plannedAt?: Date | string | null;
};

export type PlanChronologyIssue = {
  path: string;
  message: string;
};

export type AuthoritativePlanChronology = {
  plannedStartAt: Date | string | null;
  nodes: readonly PlanChronologyNode[];
};

export type PlanChronologyCompatibility =
  | "STRICT"
  | "LEGACY_CURRENT_BASE";

/**
 * Validates the complete persisted plan rather than trusting a partial editor
 * payload. This module deliberately has no server or Prisma dependency so the
 * same chronology semantics can be reused by browser-side validation later.
 */
export function inspectPlanChronology(
  plan: AuthoritativePlanChronology,
  compatibility: PlanChronologyCompatibility = "STRICT",
): PlanChronologyIssue[] {
  const issues: PlanChronologyIssue[] = [];
  const plannedStartAt = validDate(plan.plannedStartAt);
  if (!plannedStartAt && compatibility !== "LEGACY_CURRENT_BASE") {
    issues.push({
      path: "plannedStartAt",
      message: "计划开始时间不能为空",
    });
  }

  const orderedNodes = [...plan.nodes].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const seenSequences = new Set<number>();
  let nonCarryForwardSeen = false;
  for (const [index, node] of orderedNodes.entries()) {
    if (
      !Number.isInteger(node.sequence) ||
      node.sequence < 1 ||
      seenSequences.has(node.sequence) ||
      node.sequence !== index + 1
    ) {
      issues.push({
        path: `nodes.${index}.sequence`,
        message: "计划节点序号必须唯一且从 1 连续递增",
      });
    }
    seenSequences.add(node.sequence);
    if (node.isCarryForward && nonCarryForwardSeen) {
      issues.push({
        path: `nodes.${index}.isCarryForward`,
        message: "历史沿用节点必须是计划的连续前缀",
      });
    }
    if (!node.isCarryForward) nonCarryForwardSeen = true;
  }

  const milestones = orderedNodes.filter(
    (node) => node.type === "MILESTONE",
  );
  if (
    compatibility !== "LEGACY_CURRENT_BASE" &&
    milestones.length > 200
  ) {
    issues.push({
      path: "nodes",
      message: "计划最多包含 200 个 Milestone",
    });
  }

  const terminations = orderedNodes.filter(
    (node) => node.type === "TERMINATION",
  );
  if (terminations.length !== 1) {
    issues.push({
      path: "nodes",
      message: "计划必须且只能包含一个 Termination",
    });
  }
  const termination = terminations[0];
  if (
    termination &&
    orderedNodes[orderedNodes.length - 1] !== termination
  ) {
    issues.push({
      path: `nodes.${orderedNodes.indexOf(termination)}.sequence`,
      message: "Termination 必须是计划的最后一个节点",
    });
  }

  let chronologyBoundary = plannedStartAt;
  let previousMilestoneAt: Date | null = null;
  for (const milestone of milestones) {
    const nodeIndex = orderedNodes.indexOf(milestone);
    const expectedCompletedAt = validDate(milestone.expectedCompletedAt);
    if (!expectedCompletedAt) {
      issues.push({
        path: `nodes.${nodeIndex}.expectedCompletedAt`,
        message: "Milestone 预期完成时间不能为空",
      });
      continue;
    }
    if (
      compatibility !== "LEGACY_CURRENT_BASE" &&
      plannedStartAt &&
      expectedCompletedAt <= plannedStartAt
    ) {
      issues.push({
        path: `nodes.${nodeIndex}.expectedCompletedAt`,
        message: "Milestone 必须晚于计划开始时间",
      });
    }
    if (
      compatibility !== "LEGACY_CURRENT_BASE" &&
      previousMilestoneAt &&
      expectedCompletedAt <= previousMilestoneAt
    ) {
      issues.push({
        path: `nodes.${nodeIndex}.expectedCompletedAt`,
        message: "Milestone 时间必须按 sequence 严格递增",
      });
    }
    previousMilestoneAt = expectedCompletedAt;
    if (
      !chronologyBoundary ||
      expectedCompletedAt.getTime() > chronologyBoundary.getTime()
    ) {
      chronologyBoundary = expectedCompletedAt;
    }
  }

  if (termination) {
    const terminationIndex = orderedNodes.indexOf(termination);
    const plannedAt = validDate(termination.plannedAt);
    if (!plannedAt) {
      issues.push({
        path: `nodes.${terminationIndex}.plannedAt`,
        message: "Termination 计划时间不能为空",
      });
    } else {
      if (
        compatibility !== "LEGACY_CURRENT_BASE" &&
        chronologyBoundary &&
        plannedAt <= chronologyBoundary
      ) {
        issues.push({
          path: `nodes.${terminationIndex}.plannedAt`,
          message: milestones.length > 0
            ? "Termination 必须晚于最后一个 Milestone"
            : "Termination 必须晚于计划开始时间",
        });
      }
    }
  }

  return deduplicateIssues(issues);
}

function validDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function deduplicateIssues(
  issues: PlanChronologyIssue[],
): PlanChronologyIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
