import { createHash } from "node:crypto";
import { stableStringify } from "@/lib/project-management/application/stable-serialization";

export type PlanSnapshotNode = {
  sequence: number;
  nodeId: string;
  type: "MILESTONE" | "REVISION" | "TERMINATION";
  businessDescription: string;
  milestone: {
    goal: string;
    completionCriteria: string;
    expectedCompletedAt: string;
    reviewRequirements: string;
  } | null;
  revision: {
    reason: string;
    revisionAt: string;
    reviewRound: number;
    basePlanVersionId: string;
  } | null;
  termination: {
    name?: string;
    plannedOutcomeCriteria: string;
    plannedAt: string;
  } | null;
};

export function hashPlanSnapshot(input: {
  plannedStartAt: string | null;
  nodes: PlanSnapshotNode[];
}): string {
  return createHash("sha256")
    .update(stableStringify(normalizeSnapshot(input)))
    .digest("hex");
}

function normalizeSnapshot(input: {
  plannedStartAt: string | null;
  nodes: PlanSnapshotNode[];
}) {
  return {
    ...input,
    nodes: input.nodes.map((node) => {
      if (!node.termination || node.termination.name !== "Terminal") {
        return node;
      }
      const termination = { ...node.termination };
      delete termination.name;
      return { ...node, termination };
    }),
  };
}
