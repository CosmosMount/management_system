export type CurrentNodeDeadline = {
  nodeId: string;
  nodeType: "MILESTONE" | "TERMINATION";
  dueAt: string;
};

export type DeadlineStatus = "OVERDUE" | "DUE_SOON" | "NOT_DUE" | "NONE";

export const DEADLINE_WARNING_MS = 72 * 60 * 60 * 1_000;

type DeadlineNode = {
  id: string;
  type: string;
  status: string;
  deletedAt?: Date | string | null;
  milestone?: { expectedCompletedAt: Date | string | null } | null;
  termination?: { plannedAt: Date | string | null } | null;
};

export function resolveCurrentNodeDeadline({
  taskStatus,
  activeMilestoneNodeId,
  nodes,
}: {
  taskStatus: string;
  activeMilestoneNodeId: string | null;
  nodes: readonly DeadlineNode[];
}): CurrentNodeDeadline | null {
  if (taskStatus !== "ACTIVE") return null;
  const candidates = nodes.filter((node) =>
    node.status === "ACTIVE" && !node.deletedAt && (
      activeMilestoneNodeId !== null
        ? node.id === activeMilestoneNodeId && node.type === "MILESTONE"
        : node.type === "TERMINATION"
    ),
  );
  if (candidates.length !== 1) return null;
  const node = candidates[0];
  const dueAt = node.type === "MILESTONE"
    ? node.milestone?.expectedCompletedAt
    : node.termination?.plannedAt;
  if (!dueAt) return null;
  const dueAtMs = dueAt instanceof Date ? dueAt.getTime() : Date.parse(dueAt);
  if (!Number.isFinite(dueAtMs)) return null;
  return {
    nodeId: node.id,
    nodeType: activeMilestoneNodeId !== null ? "MILESTONE" : "TERMINATION",
    dueAt: new Date(dueAtMs).toISOString(),
  };
}

export function evaluateDeadline(
  target: CurrentNodeDeadline | null | undefined,
  nowMs: number,
): DeadlineStatus {
  if (!target || !Number.isFinite(nowMs)) return "NONE";
  const remainingMs = Date.parse(target.dueAt) - nowMs;
  if (!Number.isFinite(remainingMs)) return "NONE";
  if (remainingMs < 0) return "OVERDUE";
  return remainingMs <= DEADLINE_WARNING_MS ? "DUE_SOON" : "NOT_DUE";
}

const deadlineRank: Record<DeadlineStatus, number> = {
  OVERDUE: 0,
  DUE_SOON: 1,
  NOT_DUE: 2,
  NONE: 3,
};

type DeadlineTask = {
  id: string;
  title: string;
  currentNodeDeadline: CurrentNodeDeadline | null;
};

export function compareDeadlineTasks(left: DeadlineTask, right: DeadlineTask, nowMs: number) {
  const leftStatus = evaluateDeadline(left.currentNodeDeadline, nowMs);
  const rightStatus = evaluateDeadline(right.currentNodeDeadline, nowMs);
  return deadlineRank[leftStatus] - deadlineRank[rightStatus] ||
    (leftStatus !== "NONE" && rightStatus !== "NONE"
      ? Date.parse(left.currentNodeDeadline!.dueAt) - Date.parse(right.currentNodeDeadline!.dueAt)
      : 0) ||
    left.title.localeCompare(right.title, "zh-CN") || left.id.localeCompare(right.id);
}
