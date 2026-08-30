"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, LocateFixed, Plus } from "lucide-react";
import {
  CollaborationLeftSidebar,
  CollaborationRightSidebar,
  CreateRiskCard,
  type CollaborationInitialData,
} from "@/components/project-management/collaboration-panels";
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
import { taskNodeStatusLabels, taskStatusLabels } from "@/lib/project-management/labels";
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
  const timelineContainerRef = useRef<HTMLDivElement>(null);
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
      setRequestedAnchorId(timelineWindow.focusId);
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
    const timelineRoot = timelineContainerRef.current;
    if (
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
  }, [selectedAnchorId, timelineWindow.focusId]);

  const timelineUnavailableMessage = timelineError ?? resourceTimelineError;

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
    if (anchor && (anchor.atMs < model.range.startMs || anchor.atMs >= model.range.endMs)) {
      const url = new URL(window.location.href);
      url.searchParams.set("center", new Date(anchor.atMs).toISOString());
      url.searchParams.set("focus", anchor.id);
      router.push(`${url.pathname}?${url.searchParams.toString()}`);
      return;
    }
    const rowIndex = model.rows.findIndex((row) => row.sourceId === task.id);
    if (!anchor || rowIndex < 0) return;
    setRequestedAnchorId(anchor.id);
    timelineContainerRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
    requestAnimationFrame(() => {
      const root = timelineContainerRef.current;
      const scroller = root?.querySelector<HTMLElement>(
        "[data-testid='time-canvas-scroll']",
      );
      if (!scroller) return;
      const rowHeaderWidth =
        scroller
          .querySelector<HTMLElement>("[data-testid^='timeline-row-']")
          ?.firstElementChild instanceof HTMLElement
          ? scroller.querySelector<HTMLElement>("[data-testid^='timeline-row-']")!
              .firstElementChild!.clientWidth
          : 0;
      const duration = model.range.endMs - model.range.startMs;
      const ratio =
        duration > 0
          ? Math.max(
              0,
              Math.min(1, (anchor.atMs - model.range.startMs) / duration),
            )
          : 0;
      const timelineWidth = Math.max(0, scroller.scrollWidth - rowHeaderWidth);
      const targetX = rowHeaderWidth + ratio * timelineWidth;
      scroller.scrollTo({
        top: rowIndex * ROW_HEIGHT,
        left: Math.max(0, targetX - scroller.clientWidth / 2),
        behavior: "smooth",
      });
      requestAnimationFrame(() => {
        root
          ?.querySelector<HTMLElement>(`[data-canvas-object-key="anchor:${anchor.id}"]`)
          ?.focus({ preventScroll: true });
      });
    });
  }

  return (
    <div className="min-w-0 space-y-5" data-testid="project-task-workspace">
      <section
        className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5"
        data-testid="project-timeline-layer"
      >
        <div>
          <h2 className="font-semibold">Task 与人员投入时间线</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            已展示 {visibleTasks.length}/{tasks.length} 个 Project Task 计划 · Project/Task 成员的全部投入
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
            ref={timelineContainerRef}
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

      <div
        className="grid min-w-0 gap-5 xl:grid-cols-[300px_minmax(0,1fr)_300px]"
        data-testid="project-detail-lower-grid"
      >
        <main
          className="min-w-0 space-y-4 xl:col-start-2 xl:row-start-1"
          data-testid="project-detail-main-column"
        >
          <section className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-semibold">Task</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {completedTaskTotalCount}/{completionTaskTotalCount} 已完成
                </p>
              </div>
              {projectStatus === "ACTIVE" && canCreateTask && (
                <Link
                  href={`${routes.progress.taskNew}?projectId=${projectId}`}
                  className={cn(buttonVariants({ size: "sm" }))}
                >
                  <Plus />新建 Task
                </Link>
              )}
            </div>

            {tasks.length ? (
              <div
                className="mt-4 space-y-3"
                aria-label="Project Task 分组列表"
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
                          aria-label={`${expanded ? "收起" : "展开"}${statusLabel} Task 列表`}
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
                            {statusLabel} Task
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
                            aria-label={`${statusLabel} Task 列表`}
                          >
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-16 whitespace-normal text-center">时间线</TableHead>
                                <TableHead className="whitespace-normal">Task</TableHead>
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
                                  ?? (!displayed ? "请先勾选显示该 Task 时间线" : null);
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
              <p className="mt-4 text-sm text-muted-foreground">尚未关联 Task</p>
            )}
          </section>

          <CreateRiskCard
            targetType="PROJECT"
            targetId={projectId}
            canCreate={collaboration.capabilities.canCreateRisk}
          />
        </main>

        <aside
          className="min-w-0 space-y-4 xl:col-start-1 xl:row-start-1"
          data-testid="project-detail-left-column"
        >
          <CollaborationLeftSidebar data={collaboration} />
        </aside>

        <aside
          className="min-w-0 xl:col-start-3 xl:row-start-1"
          data-testid="project-detail-right-column"
        >
          <CollaborationRightSidebar data={collaboration} />
        </aside>
      </div>
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
      aria-label={`显示全部${statusLabel} Task 时间线`}
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
    sublabel: `Current Plan v${task.currentPlan.versionNo} · ${taskStatusLabels[task.status]}`,
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
      label: "Start",
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

function revisionStatusLabel(status: string) {
  return (
    {
      PENDING_APPROVAL: "待审批",
      REJECTED: "已驳回",
      CANCELLED: "已取消",
      EFFECTIVE: "已生效",
    } as Record<string, string>
  )[status] ?? status;
}
