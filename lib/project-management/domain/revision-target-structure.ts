type RevisionTargetStructureEntry = {
  nodeId: string;
  isCarryForward: boolean;
  node: {
    type: "MILESTONE" | "REVISION" | "TERMINATION";
    status: string;
    revision: {
      id: string;
      status: string;
    } | null;
    planVersionEntries: readonly {
      planVersionId: string;
    }[];
  };
};

type RevisionTargetStructurePlan = {
  plannedStartAt: Date | string | null;
  nodes: readonly RevisionTargetStructureEntry[];
};

export function isRevisionCarryForwardEntry(
  entry: RevisionTargetStructureEntry,
) {
  return (
    (entry.node.type === "MILESTONE" && entry.node.status === "COMPLETED") ||
    (entry.node.type === "REVISION" &&
      entry.node.revision?.status === "EFFECTIVE")
  );
}

export function inspectRevisionTargetStructure({
  basePlan,
  targetPlan,
  targetPlanVersionId,
  revisionId,
  revisionTaskNodeId,
}: {
  basePlan: RevisionTargetStructurePlan;
  targetPlan: RevisionTargetStructurePlan;
  targetPlanVersionId: string;
  revisionId: string;
  revisionTaskNodeId: string;
}): string[] {
  const issues: string[] = [];
  if (!sameInstant(basePlan.plannedStartAt, targetPlan.plannedStartAt)) {
    issues.push("Revision 不能修改计划开始时间");
  }

  const expectedCarryForward = basePlan.nodes.filter(
    isRevisionCarryForwardEntry,
  );
  for (const [index, expectedEntry] of expectedCarryForward.entries()) {
    const targetEntry = targetPlan.nodes[index];
    if (
      !targetEntry ||
      targetEntry.nodeId !== expectedEntry.nodeId ||
      !targetEntry.isCarryForward
    ) {
      issues.push("Revision 候选计划必须完整沿用已完成节点");
      break;
    }
  }

  const revisionIndex = expectedCarryForward.length;
  const revisionEntry = targetPlan.nodes[revisionIndex];
  if (
    !revisionEntry ||
    revisionEntry.nodeId !== revisionTaskNodeId ||
    revisionEntry.node.type !== "REVISION" ||
    revisionEntry.node.revision?.id !== revisionId ||
    revisionEntry.node.status !== "PENDING" ||
    revisionEntry.isCarryForward ||
    !belongsOnlyToTargetPlan(revisionEntry, targetPlanVersionId)
  ) {
    issues.push("待审批 Revision 必须紧随历史沿用节点");
  }

  const matchingRevisionCount = targetPlan.nodes.filter(
    (entry) =>
      entry.node.type === "REVISION" &&
      entry.node.revision?.id === revisionId,
  ).length;
  if (matchingRevisionCount !== 1) {
    issues.push("候选计划必须且只能包含当前待审批 Revision");
  }

  const replacementEntries = targetPlan.nodes.slice(revisionIndex + 1);
  const terminationEntry = replacementEntries.at(-1);
  const baseNodeIds = new Set(basePlan.nodes.map((entry) => entry.nodeId));
  if (
    replacementEntries.length === 0 ||
    terminationEntry?.node.type !== "TERMINATION" ||
    terminationEntry.isCarryForward ||
    replacementEntries
      .slice(0, -1)
      .some(
        (entry) =>
          entry.node.type !== "MILESTONE" || entry.isCarryForward,
      )
  ) {
    issues.push("待审批 Revision 后只能包含新 Milestone 和末尾 Terminal");
  }
  if (
    replacementEntries.some(
      (entry) =>
        entry.node.status !== "PENDING" ||
        !belongsOnlyToTargetPlan(entry, targetPlanVersionId),
    )
  ) {
    issues.push("Revision 候选计划后缀必须使用候选中新建的待处理节点");
  }
  if (replacementEntries.some((entry) => baseNodeIds.has(entry.nodeId))) {
    issues.push("Revision 候选计划不能复用基线中的待替换节点");
  }

  return [...new Set(issues)];
}

function belongsOnlyToTargetPlan(
  entry: RevisionTargetStructureEntry,
  targetPlanVersionId: string,
) {
  return (
    entry.node.planVersionEntries.length === 1 &&
    entry.node.planVersionEntries[0]?.planVersionId === targetPlanVersionId
  );
}

function sameInstant(
  left: Date | string | null,
  right: Date | string | null,
) {
  const leftTime = instantValue(left);
  const rightTime = instantValue(right);
  return leftTime !== null && leftTime === rightTime;
}

function instantValue(value: Date | string | null) {
  if (value === null) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}
