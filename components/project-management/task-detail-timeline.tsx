"use client";

import { useMemo, useState } from "react";
import { getRevisionBasePlan } from "@/app/actions/project-management/plans";
import {
  ResourcePlannerCanvasClient,
  type TimeCanvasPresentationOverlay,
} from "@/components/project-management/resource-planner-canvas-client";
import {
  TaskPlanNodeNavigator,
  type TaskPlanNavigatorNode,
} from "@/components/project-management/task-plan-node-navigator";
import type { TimeCanvasModel } from "@/components/project-management/time-canvas/types";
import {
  revisionStatusLabel,
  taskNodeStatusLabels,
} from "@/lib/project-management/labels";
import type {
  PendingRevisionPlanComparison,
  PlanVersionSummary,
  RevisionBasePlanDetails,
  TaskWorkspace,
} from "@/lib/project-management/queries/task-queries";
import type {
  PersonOptionDto,
  TaskOptionPage,
} from "@/lib/project-management/types/time-canvas";

export const TASK_DETAIL_START_ID = "task-detail-start";

export function buildTaskNavigatorNodes(
  workspace: TaskWorkspace,
): TaskPlanNavigatorNode[] {
  return [
    {
      id: TASK_DETAIL_START_ID,
      kind: "START",
      label: "开始节点",
      at: workspace.currentPlan.plannedStartAt ?? workspace.task.createdAt,
      status: workspace.task.status === "DRAFT" ? "草稿" : "已开始",
      completed: workspace.task.status !== "DRAFT",
    },
    ...workspace.currentPlan.nodes.map((node): TaskPlanNavigatorNode => ({
      currentNodeDeadline: workspace.task.currentNodeDeadline?.nodeId === node.nodeId ? workspace.task.currentNodeDeadline : null,
      id: node.nodeId,
      kind: node.milestone ? "MILESTONE" : node.revision ? "REVISION" : "TERMINAL",
      label: node.milestone?.goal ?? node.revision?.reason ?? node.termination?.name ?? "未命名节点",
      at: node.milestone?.expectedCompletedAt ?? node.revision?.revisionAt ?? node.termination?.plannedAt ?? workspace.task.updatedAt,
      status: node.revision ? revisionStatusLabel(node.revision.status) : taskNodeStatusLabels[node.status],
      completed: node.status === "COMPLETED" || node.revision?.status === "EFFECTIVE",
    })),
  ];
}

export function TaskDetailTimeline({
  workspace,
  nodes,
  selectedId,
  onSelect,
  model,
  people,
  taskOptions,
  timelineWindow,
  focusRequest,
  pendingRevisionPlanIssue,
}: {
  workspace: TaskWorkspace;
  nodes: TaskPlanNavigatorNode[];
  selectedId: string;
  onSelect: (nodeId: string) => void;
  model: TimeCanvasModel;
  people: PersonOptionDto[];
  taskOptions: TaskOptionPage["items"];
  timelineWindow: {
    focusId: string | null;
    centerMs?: number;
    scale?: "WEEK" | "MONTH" | "QUARTER" | "YEAR";
  };
  focusRequest: {
    nodeId: string | null;
    revision: number;
    urlCenter: string | null;
  };
  pendingRevisionPlanIssue: string | null;
}) {
  const [visibleRevisionTaskNodeIds, setVisibleRevisionTaskNodeIds] = useState<
    string[]
  >([]);
  const [historyPlansByTaskNode, setHistoryPlansByTaskNode] = useState<
    Record<string, RevisionBasePlanDetails>
  >({});
  const [historyLoadStates, setHistoryLoadStates] = useState<
    Record<
      string,
      { status: "loading" } | { status: "error"; message: string }
    >
  >({});
  const revisionNodes = workspace.permissions.canViewHistory
    ? workspace.currentPlan.nodes.filter(
        (node) => node.revision?.status === "EFFECTIVE",
      )
    : [];
  const revisionByTaskNodeId = new Map(
    revisionNodes.flatMap((node) =>
      node.revision ? [[node.nodeId, node.revision] as const] : [],
    ),
  );

  const loadHistoryPlan = (revisionTaskNodeId: string) => {
    const revision = revisionByTaskNodeId.get(revisionTaskNodeId);
    if (!revision) return;
    setHistoryLoadStates((current) => ({
      ...current,
      [revisionTaskNodeId]: { status: "loading" },
    }));
    void getRevisionBasePlan({
      taskId: workspace.task.id,
      revisionNodeId: revision.id,
    }).then(
      (result) => {
        if (!result.ok) {
          setHistoryLoadStates((current) => ({
            ...current,
            [revisionTaskNodeId]: {
              status: "error",
              message: result.error.message,
            },
          }));
          return;
        }
        if (
          result.data.revisionNodeId !== revision.id ||
          result.data.plan.taskId !== workspace.task.id
        ) {
          setHistoryLoadStates((current) => ({
            ...current,
            [revisionTaskNodeId]: {
              status: "error",
              message: "修订前计划与当前任务不匹配，请刷新后重试。",
            },
          }));
          return;
        }
        setHistoryPlansByTaskNode((current) => ({
          ...current,
          [revisionTaskNodeId]: result.data,
        }));
        setHistoryLoadStates((current) => {
          const next = { ...current };
          delete next[revisionTaskNodeId];
          return next;
        });
      },
      () => {
        setHistoryLoadStates((current) => ({
          ...current,
          [revisionTaskNodeId]: {
            status: "error",
            message: "网络或服务暂时不可用，请重试。",
          },
        }));
      },
    );
  };

  const setHistoryVisible = (revisionTaskNodeId: string, checked: boolean) => {
    if (!revisionByTaskNodeId.has(revisionTaskNodeId)) return;
    setVisibleRevisionTaskNodeIds((current) =>
      checked
        ? current.includes(revisionTaskNodeId)
          ? current
          : [...current, revisionTaskNodeId]
        : current.filter((id) => id !== revisionTaskNodeId),
    );
    if (
      checked &&
      !historyPlansByTaskNode[revisionTaskNodeId] &&
      historyLoadStates[revisionTaskNodeId]?.status !== "loading"
    ) {
      loadHistoryPlan(revisionTaskNodeId);
    }
  };

  const visibleHistoryPlans = useMemo(
    () =>
      visibleRevisionTaskNodeIds
        .flatMap((revisionTaskNodeId) => {
          const history = historyPlansByTaskNode[revisionTaskNodeId];
          return history ? [history] : [];
        })
        .sort(
          (left, right) =>
            Date.parse(right.revisionAt) - Date.parse(left.revisionAt) ||
            left.revisionNodeId.localeCompare(right.revisionNodeId),
        ),
    [historyPlansByTaskNode, visibleRevisionTaskNodeIds],
  );
  const pendingRevisionPlan =
    !workspace.pendingApprovalConflict &&
    workspace.pendingApproval?.kind === "REVISION" &&
    workspace.pendingRevisionPlanComparison?.status === "READY" &&
    workspace.pendingRevisionPlanComparison.revisionNodeId ===
      workspace.pendingApproval.id
      ? workspace.pendingRevisionPlanComparison
      : null;
  const revisionPlanOverlay = useMemo(
    () =>
      buildRevisionPlanTimeCanvasOverlay(
        pendingRevisionPlan,
        visibleHistoryPlans,
      ),
    [pendingRevisionPlan, visibleHistoryPlans],
  );
  const revisionHistoryControls = {
    byNodeId: Object.fromEntries(
      revisionNodes.map((node) => {
        const checked = visibleRevisionTaskNodeIds.includes(node.nodeId);
        const loadState = historyLoadStates[node.nodeId];
        return [
          node.nodeId,
          {
            checked,
            loading: checked && loadState?.status === "loading",
            ...(checked && loadState?.status === "error"
              ? { error: loadState.message }
              : {}),
          },
        ];
      }),
    ),
    onCheckedChange: setHistoryVisible,
    onRetry: (revisionTaskNodeId: string) => {
      setVisibleRevisionTaskNodeIds((current) =>
        current.includes(revisionTaskNodeId)
          ? current
          : [...current, revisionTaskNodeId],
      );
      loadHistoryPlan(revisionTaskNodeId);
    },
  };

  return (
    <section
      className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5"
      data-testid="task-timeline-layer"
    >
      <div>
        <h2 className="font-semibold">计划与人员投入</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          当前计划 v{workspace.currentPlan.versionNo} · 按当前计划和投入自动确定范围
        </p>
      </div>
      {pendingRevisionPlanIssue && (
        <p
          className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          role="alert"
          data-testid="pending-revision-plan-warning"
        >
          {pendingRevisionPlanIssue} 当前时间线仅展示修改前的当前计划。
        </p>
      )}
      <div className="mt-4 min-w-0">
        <ResourcePlannerCanvasClient
          initialModel={model}
          presentationOverlay={revisionPlanOverlay}
          peopleOptions={people}
          peopleScope={{ purpose: "TASK_SEGMENT_CREATE", taskId: workspace.task.id }}
          taskOptions={taskOptions}
          defaultPersonId={workspace.members.find((member) => member.role === "OWNER")?.personId ?? workspace.members[0]?.personId ?? ""}
          defaultTaskId={workspace.task.id}
          defaultTaskTitle={workspace.task.title}
          allowIndependent={false}
          initialZoom={timelineWindow.scale}
          initialCenterMs={timelineWindow.centerMs}
          persistViewportInUrl
          adaptiveBlockQuery={{
            kind: "TASK",
            preferredCenterMs: timelineWindow.centerMs ?? Date.parse(model.generatedAt),
            taskId: workspace.task.id,
          }}
          mode="TASK_WORKBENCH"
          initialFocusId={
            selectedId === TASK_DETAIL_START_ID
              ? `plan-start:${workspace.task.id}`
              : selectedId
          }
          initialFocusRevision={focusRequest.revision}
          initialFocusRequestId={
            focusRequest.nodeId === TASK_DETAIL_START_ID
              ? `plan-start:${workspace.task.id}`
              : focusRequest.nodeId
          }
          initialFocusRequestUrlCenter={focusRequest.urlCenter}
        />
      </div>
      <div className="mt-4">
        <TaskPlanNodeNavigator
          nodes={nodes}
          selectedId={selectedId}
          onSelect={onSelect}
          label="任务时间线"
          revisionHistory={revisionHistoryControls}
        />
      </div>
    </section>
  );
}

type ReadyPendingRevisionPlanComparison = Extract<
  PendingRevisionPlanComparison,
  { status: "READY" }
>;

type RevisionPlanOverlayEntry = {
  rowId: string;
  sourceId: string;
  anchorPrefix: string;
  label: string;
  sublabel: string;
  anchorStatus: string;
  tone: "AMBER" | "SLATE";
  plan: PlanVersionSummary;
};

function buildRevisionPlanTimeCanvasOverlay(
  pendingRevisionPlan: ReadyPendingRevisionPlanComparison | null,
  histories: RevisionBasePlanDetails[],
): TimeCanvasPresentationOverlay | undefined {
  const entries: RevisionPlanOverlayEntry[] = [
    ...(pendingRevisionPlan
      ? [
          {
            rowId: `revision-candidate:${pendingRevisionPlan.revisionNodeId}`,
            sourceId: pendingRevisionPlan.revisionNodeId,
            anchorPrefix: `revision-candidate:${pendingRevisionPlan.revisionNodeId}`,
            label: `计划修订「${pendingRevisionPlan.revisionReason}」修改后`,
            sublabel: `计划 v${pendingRevisionPlan.plan.versionNo} · 待审批候选（只读）`,
            anchorStatus: "待审批候选",
            tone: "AMBER" as const,
            plan: pendingRevisionPlan.plan,
          },
        ]
      : []),
    ...histories.map(
      (history): RevisionPlanOverlayEntry => ({
        rowId: `history-plan:${history.revisionNodeId}`,
        sourceId: history.revisionNodeId,
        anchorPrefix: `history:${history.revisionNodeId}`,
        label: `计划修订「${history.revisionReason}」之前`,
        sublabel: `计划 v${history.plan.versionNo} · 历史计划（只读）`,
        anchorStatus: "历史计划",
        tone: "SLATE",
        plan: history.plan,
      }),
    ),
  ];
  if (entries.length === 0) return undefined;

  const rows: TimeCanvasModel["rows"] = entries.map((entry) => ({
    id: entry.rowId,
    sourceId: entry.sourceId,
    kind: "PLAN",
    label: entry.label,
    sublabel: entry.sublabel,
    editable: false,
    height: 112,
    capacity: null,
  }));
  const anchors: TimeCanvasModel["anchors"] = entries.flatMap((entry) => {
    const versionToken = entry.plan.snapshotHash || entry.plan.updatedAt;
    const startAtMs = Date.parse(
      entry.plan.plannedStartAt ?? entry.plan.createdAt,
    );
    const planAnchors: TimeCanvasModel["anchors"] = Number.isFinite(startAtMs)
      ? [
          {
            id: `${entry.anchorPrefix}:start`,
            rowId: entry.rowId,
            taskId: entry.plan.taskId,
            kind: "PLAN_START",
            status: entry.anchorStatus,
            label: "开始节点",
            atMs: startAtMs,
            sequence: -1,
            editable: false,
            versionToken,
            tone: entry.tone,
          },
        ]
      : [];
    for (const node of entry.plan.nodes) {
      const plannedAt =
        node.milestone?.expectedCompletedAt ??
        node.revision?.revisionAt ??
        node.termination?.plannedAt;
      if (!plannedAt) continue;
      const atMs = Date.parse(plannedAt);
      if (!Number.isFinite(atMs)) continue;
      planAnchors.push({
        id: `${entry.anchorPrefix}:${node.nodeId}`,
        rowId: entry.rowId,
        taskId: entry.plan.taskId,
        kind: node.type,
        status: entry.anchorStatus,
        label:
          node.milestone?.goal ??
          node.revision?.reason ??
          node.termination?.name ??
          "未命名节点",
        atMs,
        sequence: node.sequence,
        editable: false,
        versionToken,
        tone: entry.tone,
      });
    }
    return planAnchors;
  });
  const range = rangeForTimes(anchors.map((anchor) => anchor.atMs));
  if (!range) return undefined;

  return {
    rows,
    anchors,
    range,
  };
}

function rangeForTimes(
  times: number[],
): { startMs: number; endMs: number } | null {
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const time of times) {
    if (!Number.isFinite(time)) continue;
    startMs = Math.min(startMs, time);
    endMs = Math.max(endMs, time + 1);
  }
  return Number.isFinite(startMs) && Number.isFinite(endMs)
    ? { startMs, endMs }
    : null;
}
