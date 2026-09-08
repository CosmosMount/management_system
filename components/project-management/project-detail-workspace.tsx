"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, LocateFixed, Plus } from "lucide-react";
import {
  ActivityVersionPoller,
  CommentPanel,
  CreateRiskCard,
  RecentActivityPanel,
  RiskPanel,
  type CollaborationInitialData,
} from "@/components/project-management/collaboration-panels";
import {
  DetailViewNavigation,
  DetailViewPanel,
  useDetailView,
} from "@/components/project-management/detail-views";
import { ResourcePlannerCanvasClient } from "@/components/project-management/resource-planner-canvas-client";
import { buildPlanPhaseBands } from "@/components/project-management/time-canvas/plan-phase-bands";
import type {
  TimeCanvasAnchor,
  TimeCanvasModel,
  TimeCanvasTone,
} from "@/components/project-management/time-canvas/types";
import type { PersonOptionDto } from "@/lib/project-management/types/time-canvas";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  revisionStatusLabel,
  taskNodeStatusLabels,
  taskStatusLabels,
} from "@/lib/project-management/labels";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type { TaskNodeStatus, TaskStatus } from "@prisma/client";

type ProjectTimelineTask = {
  id: string;
  title: string;
  status: TaskStatus;
  activeMilestoneNodeId: string | null;
  createdAt: string;
  currentPlan: {
    versionNo: number;
    plannedStartAt: string | null;
    nodes: Array<{
      id: string;
      sequence: number;
      status: TaskNodeStatus;
      milestone: { goal: string; expectedCompletedAt: string } | null;
      revision: { reason: string; revisionAt: string; status: string } | null;
      termination: { name: string; plannedAt: string } | null;
    }>;
  };
};

const DAY_MS = 24 * 60 * 60 * 1_000;
const ROW_HEIGHT = 112;
const projectViews = ["overview", "plan", "collaboration", "activity"] as const;
const projectViewItems = [
  { value: "overview", label: "任务概览" },
  { value: "plan", label: "计划与投入" },
  { value: "collaboration", label: "风险与讨论" },
  { value: "activity", label: "活动记录" },
] as const;
const projectHashViews = { "#establishment": "overview", "#risks": "collaboration" };
const projectTaskStatusOrder = [
  "DRAFT",
  "ACTIVE",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "ARCHIVED",
] as const satisfies readonly TaskStatus[];
const phaseTones: TimeCanvasTone[] = [
  "BLUE",
  "VIOLET",
  "AMBER",
  "EMERALD",
  "ROSE",
  "SLATE",
];

export function ProjectDetailWorkspace({
  projectId,
  initialView,
  projectStatus,
  canCreateTask,
  tasks,
  timelineError,
  completionTaskTotalCount,
  completedTaskTotalCount,
  resourceModel,
  resourceTimelineError,
  peopleOptions,
  timelineWindow,
  timelineFocusError,
  collaboration,
}: {
  projectId: string;
  initialView: string;
  projectStatus: "DRAFT" | "PENDING_APPROVAL" | "ACTIVE" | "COMPLETED";
  canCreateTask: boolean;
  tasks: ProjectTimelineTask[];
  timelineError: string | null;
  completionTaskTotalCount: number;
  completedTaskTotalCount: number;
  resourceModel: TimeCanvasModel | null;
  resourceTimelineError: string | null;
  peopleOptions: PersonOptionDto[];
  timelineWindow: {
    focusId: string | null;
    centerMs?: number;
    scale?: "WEEK" | "MONTH" | "QUARTER" | "YEAR";
  };
  timelineFocusError: string | null;
  collaboration: CollaborationInitialData;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { view, selectView } = useDetailView({
    initialView,
    views: projectViews,
    hashViews: projectHashViews,
  });
  const [timelineContainer, setTimelineContainer] = useState<HTMLDivElement | null>(null);
  const [pendingLocationId, setPendingLocationId] = useState<string | null>(null);
  const focusedTask = taskForTimelineFocus(tasks, timelineWindow.focusId);
  const [visibleTaskIds, setVisibleTaskIds] = useState<string[]>(() =>
    initialVisibleTaskIds(tasks, focusedTask),
  );
  const [expandedTaskStatuses, setExpandedTaskStatuses] = useState<TaskStatus[]>(
    () => initialExpandedTaskStatuses(tasks, focusedTask),
  );
  const taskGroups = useMemo(
    () =>
      projectTaskStatusOrder.flatMap((status) => {
        const statusTasks = tasks.filter((task) => task.status === status);
        return statusTasks.length > 0 ? [{ status, tasks: statusTasks }] : [];
      }),
    [tasks],
  );
  const visibleTaskIdSet = useMemo(
    () => new Set(visibleTaskIds),
    [visibleTaskIds],
  );
  const visibleTasks = useMemo(
    () =>
      taskGroups.flatMap((group) =>
        group.tasks.filter((task) => visibleTaskIdSet.has(task.id)),
      ),
    [taskGroups, visibleTaskIdSet],
  );
  const model = useMemo(
    () => mergeProjectTimelineModel(visibleTasks, resourceModel),
    [resourceModel, visibleTasks],
  );
  const [requestedAnchorId, setRequestedAnchorId] = useState<string | null>(timelineWindow.focusId);
  const externalTimelineFocusRef = useRef(timelineWindow.focusId);
  useEffect(() => {
    if (externalTimelineFocusRef.current === timelineWindow.focusId) return;
    const timer = window.setTimeout(() => {
      externalTimelineFocusRef.current = timelineWindow.focusId;
      if (timelineWindow.focusId) setRequestedAnchorId(timelineWindow.focusId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [timelineWindow.focusId]);
  const revealedExternalFocusRef = useRef(timelineWindow.focusId);
  useEffect(() => {
    const focusId = timelineWindow.focusId;
    if (revealedExternalFocusRef.current === focusId) return;
    const externalFocusedTask = taskForTimelineFocus(
      tasks,
      focusId,
    );
    if (!externalFocusedTask) {
      revealedExternalFocusRef.current = focusId;
      return;
    }
    const timer = window.setTimeout(() => {
      revealedExternalFocusRef.current = focusId;
      setVisibleTaskIds((current) =>
        current.includes(externalFocusedTask.id)
          ? current
          : [...current, externalFocusedTask.id],
      );
      setExpandedTaskStatuses((current) =>
        current.includes(externalFocusedTask.status)
          ? current
          : [...current, externalFocusedTask.status],
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [tasks, timelineWindow.focusId]);
  const selectedAnchorId = model.anchors.some(
    (anchor) => anchor.id === requestedAnchorId,
  )
    ? requestedAnchorId
    : null;
  const handledExternalFocusRef = useRef<string | null>(null);
  useEffect(() => {
    const focusId = timelineWindow.focusId;
    const timelineRoot = timelineContainer;
    if (
      view !== "plan" ||
      !focusId ||
      selectedAnchorId !== focusId ||
      handledExternalFocusRef.current === focusId ||
      !timelineRoot
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (handledExternalFocusRef.current === focusId) return;
      handledExternalFocusRef.current = focusId;
      timelineRoot.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedAnchorId, timelineWindow.focusId, timelineContainer, view]);

  useEffect(() => {
    if (view !== "plan" || !pendingLocationId || !timelineContainer) return;
    const anchor = model.anchors.find((item) => item.id === pendingLocationId);
    const rowIndex = model.rows.findIndex((row) => row.id === anchor?.rowId);
    if (!anchor || rowIndex < 0) return;
    let frame = requestAnimationFrame(() => {
      const scroller = timelineContainer.querySelector<HTMLElement>(
        "[data-testid='time-canvas-scroll']",
      );
      if (!scroller) return;
      timelineContainer.scrollIntoView({ behavior: "smooth", block: "start" });
      const rowHeader = scroller.querySelector<HTMLElement>("[data-testid^='timeline-row-']")
        ?.firstElementChild;
      const rowHeaderWidth = rowHeader instanceof HTMLElement ? rowHeader.clientWidth : 0;
      const duration = model.range.endMs - model.range.startMs;
      const ratio = duration > 0
        ? Math.max(0, Math.min(1, (anchor.atMs - model.range.startMs) / duration))
        : 0;
      const timelineWidth = Math.max(0, scroller.scrollWidth - rowHeaderWidth);
      scroller.scrollTo({
        top: rowIndex * ROW_HEIGHT,
        left: Math.max(0, rowHeaderWidth + ratio * timelineWidth - scroller.clientWidth / 2),
        behavior: "smooth",
      });
      frame = requestAnimationFrame(() => {
        timelineContainer
          .querySelector<HTMLElement>(`[data-canvas-object-key="anchor:${anchor.id}"]`)
          ?.focus({ preventScroll: true });
        setPendingLocationId(null);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [model, pendingLocationId, timelineContainer, view]);

  const timelineUnavailableMessage = timelineError ?? resourceTimelineError;
  const riskCount = collaboration.directActiveRisks.totalCount +
    (collaboration.taskActiveRisks?.totalCount ?? 0);
  const riskPreview = [
    ...collaboration.directActiveRisks.items,
    ...(collaboration.taskActiveRisks?.items ?? []),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    .slice(0, 3);
  const riskViewSearch = new URLSearchParams(searchParams.toString());
  riskViewSearch.set("section", "collaboration");

  function setTasksVisible(taskIds: string[], checked: boolean) {
    const targetTaskIds = new Set(taskIds);
    setVisibleTaskIds((current) => {
      const next = new Set(current);
      for (const taskId of targetTaskIds) {
        if (checked) next.add(taskId);
        else next.delete(taskId);
      }
      return tasks.flatMap((task) => (next.has(task.id) ? [task.id] : []));
    });
    if (
      !checked &&
      targetTaskIds.has(taskForTimelineFocus(tasks, requestedAnchorId)?.id ?? "")
    ) {
      setRequestedAnchorId(null);
    }
  }

  function toggleTaskStatus(status: TaskStatus) {
    setExpandedTaskStatuses((current) =>
      current.includes(status)
        ? current.filter((candidate) => candidate !== status)
        : [...current, status],
    );
  }

  function locateTask(task: ProjectTimelineTask) {
    const pointedMilestone = task.currentPlan.nodes.find(
      (node) =>
        node.id === task.activeMilestoneNodeId &&
        node.status === "ACTIVE" &&
        node.revision === null,
    );
    const activeNode =
      pointedMilestone ??
      task.currentPlan.nodes.find(
        (node) => node.status === "ACTIVE" && node.revision === null,
      );
    const preferredAnchorId = activeNode
      ? `project-node:${activeNode.id}`
      : `project-start:${task.id}`;
    const anchor = model.anchors.find((item) => item.id === preferredAnchorId) ??
      model.anchors.find((item) => item.taskId === task.id);
    if (!anchor) return;
    if (anchor.atMs < model.range.startMs || anchor.atMs >= model.range.endMs) {
      const url = new URL(window.location.href);
      url.searchParams.set("section", "plan");
      url.searchParams.set("center", new Date(anchor.atMs).toISOString());
      url.searchParams.set("focus", anchor.id);
      url.hash = "";
      router.replace(`${url.pathname}?${url.searchParams.toString()}`, { scroll: false });
      return;
    }
    selectView("plan");
    setRequestedAnchorId(anchor.id);
    setPendingLocationId(anchor.id);
  }

  return (
    <div className="min-w-0 space-y-5" data-testid="project-task-workspace">
      <DetailViewNavigation
        items={projectViewItems}
        view={view}
        onSelect={selectView}
        label="项目详情视图"
      />
      <DetailViewPanel value="plan" view={view} testId="project-plan-view">
      <section
        className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5"
        data-testid="project-timeline-layer"
      >
        <div>
          <h2 className="font-semibold">任务与人员投入时间线</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            已展示 {visibleTasks.length}/{tasks.length} 个项目任务计划 · 项目/任务成员的全部投入
          </p>
        </div>
        {timelineFocusError && (
          <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
            {timelineFocusError}
          </p>
        )}
        {timelineError || resourceTimelineError ? (
          <div
            className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
            role="alert"
          >
            {timelineError ?? resourceTimelineError}
          </div>
        ) : (
          <div
            ref={setTimelineContainer}
            className="mt-4 min-w-0 scroll-mt-24 overflow-hidden rounded-lg border border-border"
          >
            <ResourcePlannerCanvasClient
              initialModel={model}
              peopleOptions={peopleOptions}
              taskOptions={[]}
              defaultPersonId={peopleOptions[0]?.id ?? ""}
              initialZoom={timelineWindow.scale}
              initialCenterMs={timelineWindow.centerMs}
              persistViewportInUrl
              adaptiveBlockQuery={{
                kind: "PROJECT",
                preferredCenterMs: timelineWindow.centerMs ?? Date.parse(model.generatedAt),
                projectId,
              }}
              mode="TASK_WORKBENCH"
              allowCreate={false}
              readOnly
              initialFocusId={selectedAnchorId}
            />
          </div>
        )}
      </section>
      </DetailViewPanel>

      <DetailViewPanel value="overview" view={view} testId="project-summary-view" className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <section className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5" data-testid="project-tasks">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-semibold">任务</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {completedTaskTotalCount}/{completionTaskTotalCount} 已完成
                </p>
              </div>
              {projectStatus === "ACTIVE" && canCreateTask && (
                <Link
                  href={`${routes.progress.taskNew}?projectId=${projectId}`}
                  className={cn(buttonVariants({ size: "sm" }))}
                >
                  <Plus />新建任务
                </Link>
              )}
            </div>

            {tasks.length ? (
              <div
                className="mt-4 space-y-3"
                aria-label="项目任务分组列表"
              >
                {taskGroups.map((group) => {
                  const expanded = expandedTaskStatuses.includes(group.status);
                  const displayedCount = group.tasks.filter((task) =>
                    visibleTaskIdSet.has(task.id),
                  ).length;
                  const statusLabel = taskStatusLabels[group.status];
                  return (
                    <section
                      key={group.status}
                      className="min-w-0 overflow-hidden rounded-lg border border-border"
                      data-testid={`project-task-group-${group.status}`}
                    >
                      <div className="flex min-w-0 flex-col gap-2 bg-muted/30 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="min-w-0 justify-start px-1"
                          aria-expanded={expanded}
                          aria-controls={`project-task-group-body-${group.status}`}
                          aria-label={`${expanded ? "收起" : "展开"}${statusLabel}任务列表`}
                          onClick={() => toggleTaskStatus(group.status)}
                        >
                          <ChevronDown
                            className={cn(
                              "shrink-0 transition-transform",
                              !expanded && "-rotate-90",
                            )}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 break-words text-left">
                            {statusLabel}任务
                          </span>
                          <Badge variant="secondary">{group.tasks.length}</Badge>
                        </Button>
                        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                          <span
                            className="tabular-nums text-muted-foreground"
                            data-testid={`project-task-group-ratio-${group.status}`}
                          >
                            已展示 {displayedCount}/{group.tasks.length}
                          </span>
                          <label className="inline-flex min-w-0 items-center gap-2">
                            <StatusVisibilityCheckbox
                              statusLabel={statusLabel}
                              displayedCount={displayedCount}
                              totalCount={group.tasks.length}
                              disabled={Boolean(timelineUnavailableMessage)}
                              onCheckedChange={(checked) =>
                                setTasksVisible(
                                  group.tasks.map((task) => task.id),
                                  checked,
                                )
                              }
                            />
                            <span>全部显示</span>
                          </label>
                        </div>
                      </div>

                      {expanded && (
                        <div id={`project-task-group-body-${group.status}`}>
                          <Table
                            className="table-fixed"
                            aria-label={`${statusLabel}任务列表`}
                          >
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-16 whitespace-normal text-center">时间线</TableHead>
                                <TableHead className="whitespace-normal">任务</TableHead>
                                <TableHead className="w-20 whitespace-normal text-right">操作</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {group.tasks.map((task) => {
                                const displayed = visibleTaskIdSet.has(task.id);
                                const selected = model.anchors.some(
                                  (anchor) =>
                                    anchor.taskId === task.id &&
                                    anchor.id === selectedAnchorId,
                                );
                                const locateDisabledMessage = timelineUnavailableMessage
                                  ?? (!displayed ? "请先勾选显示该任务时间线" : null);
                                return (
                                  <TableRow
                                    key={task.id}
                                    className={cn(
                                      selected && "bg-primary/5 ring-1 ring-inset ring-primary/30",
                                    )}
                                  >
                                    <TableCell className="whitespace-normal text-center">
                                      <input
                                        type="checkbox"
                                        className="size-4 accent-primary"
                                        checked={displayed}
                                        disabled={Boolean(timelineUnavailableMessage)}
                                        aria-label={`在时间线中显示 ${task.title}`}
                                        title={timelineUnavailableMessage ?? undefined}
                                        onChange={(event) =>
                                          setTasksVisible(
                                            [task.id],
                                            event.currentTarget.checked,
                                          )
                                        }
                                      />
                                    </TableCell>
                                    <TableCell className="whitespace-normal">
                                      <div className="flex min-w-0 flex-col items-start gap-1.5">
                                        <Link
                                          href={routes.progress.taskDetail(task.id)}
                                          className="max-w-full break-words font-medium hover:text-primary hover:underline"
                                        >
                                          {task.title}
                                        </Link>
                                        <Badge variant="secondary">{statusLabel}</Badge>
                                      </div>
                                    </TableCell>
                                    <TableCell className="whitespace-normal text-right">
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        aria-label={`在时间线中定位 ${task.title}`}
                                        aria-pressed={selected}
                                        disabled={Boolean(locateDisabledMessage)}
                                        title={locateDisabledMessage ?? undefined}
                                        onClick={() => locateTask(task)}
                                      >
                                        <LocateFixed />定位
                                      </Button>
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">尚未关联任务</p>
            )}
          </section>
          <section className="min-w-0 rounded-xl border border-border bg-card p-4" data-testid="project-risk-summary">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-semibold">需要关注的风险 <span className="text-sm font-normal text-muted-foreground">{riskCount} 条未解决</span></h2>
              <Link
                href={`?${riskViewSearch.toString()}#risks`}
                className="rounded text-sm text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >查看全部风险与讨论</Link>
            </div>
            {riskPreview.length > 0 ? (
              <ul className="mt-3 divide-y divide-border">
                {riskPreview.map((risk) => (
                  <li key={risk.id} className="min-w-0 py-2">
                    <p className="text-xs text-muted-foreground">{risk.target.type === "PROJECT" ? "项目自身风险" : `任务：${risk.target.name}`}</p>
                    <p className="mt-1 line-clamp-2 break-words text-sm [overflow-wrap:anywhere]">{risk.content}</p>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-3 text-sm text-muted-foreground">当前没有未解决风险。</p>}
          </section>
      </DetailViewPanel>

      <DetailViewPanel value="collaboration" view={view} testId="project-collaboration-view" className="space-y-4">
          <RiskPanel data={collaboration} />
          {collaboration.capabilities.canCreateRisk && <details className="min-w-0 rounded-xl border border-border bg-card p-4">
            <summary className="w-fit cursor-pointer rounded text-sm font-medium text-primary focus-visible:outline-2 focus-visible:outline-ring">提出项目风险</summary>
            <div className="mt-3">
          <CreateRiskCard
            targetType="PROJECT"
            targetId={projectId}
            canCreate={collaboration.capabilities.canCreateRisk}
          />
            </div>
          </details>}
          <CommentPanel data={collaboration} />
      </DetailViewPanel>
      <DetailViewPanel value="activity" view={view} testId="project-activity-view">
        <RecentActivityPanel data={collaboration} />
      </DetailViewPanel>
      <ActivityVersionPoller
        targetType={collaboration.targetType}
        targetId={projectId}
        initialToken={collaboration.activityVersion}
      />
    </div>
  );
}

function StatusVisibilityCheckbox({
  statusLabel,
  displayedCount,
  totalCount,
  disabled,
  onCheckedChange,
}: {
  statusLabel: string;
  displayedCount: number;
  totalCount: number;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const checkboxRef = useRef<HTMLInputElement>(null);
  const checked = displayedCount === totalCount;
  const mixed = displayedCount > 0 && !checked;
  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={checkboxRef}
      type="checkbox"
      className="size-4 shrink-0 accent-primary"
      checked={checked}
      disabled={disabled}
      aria-label={`显示全部${statusLabel}任务时间线`}
      aria-checked={mixed ? "mixed" : checked}
      onChange={(event) => onCheckedChange(event.currentTarget.checked)}
    />
  );
}

function initialVisibleTaskIds(
  tasks: ProjectTimelineTask[],
  focusedTask: ProjectTimelineTask | null,
) {
  return tasks.flatMap((task) =>
    task.status === "ACTIVE" || task.id === focusedTask?.id ? [task.id] : [],
  );
}

function initialExpandedTaskStatuses(
  tasks: ProjectTimelineTask[],
  focusedTask: ProjectTimelineTask | null,
): TaskStatus[] {
  const statuses: TaskStatus[] = tasks.some((task) => task.status === "ACTIVE")
    ? ["ACTIVE"]
    : [];
  if (focusedTask && !statuses.includes(focusedTask.status)) {
    statuses.push(focusedTask.status);
  }
  return statuses;
}

function taskForTimelineFocus(
  tasks: ProjectTimelineTask[],
  focusId: string | null,
) {
  if (!focusId) return null;
  const taskId = focusId.startsWith("project-start:")
    ? focusId.slice("project-start:".length)
    : null;
  if (taskId) return tasks.find((task) => task.id === taskId) ?? null;
  const nodeId = focusId.startsWith("project-node:")
    ? focusId.slice("project-node:".length)
    : null;
  if (!nodeId) return null;
  return tasks.find((task) =>
    task.currentPlan.nodes.some((node) => node.id === nodeId),
  ) ?? null;
}

function mergeProjectTimelineModel(
  tasks: ProjectTimelineTask[],
  resourceModel: TimeCanvasModel | null,
) {
  const planModel = buildProjectTimelineModel(tasks);
  return {
    ...planModel,
    range: resourceModel?.range ?? planModel.range,
    fullRange: resourceModel?.fullRange,
    contentRange: resourceModel?.contentRange,
    rangeClipped: resourceModel?.rangeClipped,
    rowPageKey: resourceModel?.rowPageKey,
    loadedRanges: resourceModel?.loadedRanges,
    loadedLeafBlockCounts: resourceModel?.loadedLeafBlockCounts,
    failedRanges: resourceModel?.failedRanges,
    globalMarkers: resourceModel?.globalMarkers ?? [],
    rows: [
      ...planModel.rows,
      ...(resourceModel?.rows
        .filter((row) => row.kind === "PERSON")
        .map((row) => ({ ...row, editable: false })) ?? []),
    ],
    segments: resourceModel?.segments ?? [],
    generatedAt: resourceModel?.generatedAt ?? planModel.generatedAt,
  };
}

function buildProjectTimelineModel(tasks: ProjectTimelineTask[]): TimeCanvasModel {
  const rows = tasks.map((task) => ({
    id: `project-plan:${task.id}`,
    sourceId: task.id,
    kind: "PLAN" as const,
    label: task.title,
    sublabel: `当前计划 v${task.currentPlan.versionNo} · ${taskStatusLabels[task.status]}`,
    href: routes.progress.taskDetail(task.id),
    editable: false,
    height: ROW_HEIGHT,
    capacity: null,
  }));
  const anchors = tasks.flatMap((task) => taskAnchors(task));
  const validTimes = anchors.map((anchor) => anchor.atMs).filter(Number.isFinite);
  const minimum = validTimes.length ? Math.min(...validTimes) : 0;
  const maximum = validTimes.length ? Math.max(...validTimes) : DAY_MS;
  const duration = Math.max(DAY_MS, maximum - minimum);
  const padding = Math.max(DAY_MS, duration * 0.08);
  const phaseBands = rows.flatMap((row) =>
    buildPlanPhaseBands(
      anchors.filter((anchor) => anchor.rowId === row.id),
      row.id,
    ).map((band) => ({ ...band, id: `project-${row.sourceId}-${band.id}` })),
  );
  return {
    timezone: "Asia/Shanghai",
    range: {
      startMs: minimum - padding,
      endMs: maximum + padding + 1,
    },
    rows,
    anchors,
    phaseBands,
    segments: [],
    generatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function taskAnchors(task: ProjectTimelineTask): TimeCanvasAnchor[] {
  const rowId = `project-plan:${task.id}`;
  const startAt = task.currentPlan.plannedStartAt ?? task.createdAt;
  return [
    {
      id: `project-start:${task.id}`,
      rowId,
      taskId: task.id,
      kind: "PLAN_START",
      status: task.status === "DRAFT" ? "草稿" : "已开始",
      label: "开始节点",
      atMs: new Date(startAt).getTime(),
      sequence: 0,
      editable: false,
      versionToken: startAt,
      completed: task.status !== "DRAFT",
      tone: "BLUE",
    },
    ...task.currentPlan.nodes.map((entry, index): TimeCanvasAnchor => {
      const at =
        entry.milestone?.expectedCompletedAt ??
        entry.revision?.revisionAt ??
        entry.termination?.plannedAt ??
        startAt;
      return {
        id: `project-node:${entry.id}`,
        rowId,
        taskId: task.id,
        kind: entry.milestone
          ? "MILESTONE"
          : entry.revision
            ? "REVISION"
            : "TERMINATION",
        status: entry.revision
          ? revisionStatusLabel(entry.revision.status)
          : taskNodeStatusLabels[entry.status],
        label:
          entry.milestone?.goal ??
          entry.revision?.reason ??
          entry.termination?.name ??
          "未命名节点",
        atMs: new Date(at).getTime(),
        sequence: entry.sequence,
        editable: false,
        versionToken: at,
        completed:
          entry.status === "COMPLETED" ||
          entry.revision?.status === "EFFECTIVE",
        tone: phaseTones[index % phaseTones.length],
      };
    }),
  ];
}
