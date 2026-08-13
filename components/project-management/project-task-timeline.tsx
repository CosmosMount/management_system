"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LocateFixed, Plus } from "lucide-react";
import { ResourcePlannerCanvasClient } from "@/components/project-management/resource-planner-canvas-client";
import { buildPlanPhaseBands } from "@/components/project-management/time-canvas/plan-phase-bands";
import { ViewportStateLink } from "@/components/project-management/time-canvas/viewport-state-link";
import type {
  TimeCanvasAnchor,
  TimeCanvasModel,
  TimeCanvasTone,
} from "@/components/project-management/time-canvas/types";
import type { PersonOptionDto } from "@/lib/project-management/types/time-canvas";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
const phaseTones: TimeCanvasTone[] = [
  "BLUE",
  "VIOLET",
  "AMBER",
  "EMERALD",
  "ROSE",
  "SLATE",
];

export function ProjectTaskTimeline({
  projectId,
  projectStatus,
  tasks,
  timelineError,
  taskTotalCount,
  completedTaskTotalCount,
  resourceModel,
  resourceTimelineError,
  peopleOptions,
  timelineWindow,
  timelineFocusError,
  nextPageHref,
}: {
  projectId: string;
  projectStatus: "DRAFT" | "PENDING_APPROVAL" | "ACTIVE" | "COMPLETED";
  tasks: ProjectTimelineTask[];
  timelineError: string | null;
  taskTotalCount: number;
  completedTaskTotalCount: number;
  resourceModel: TimeCanvasModel | null;
  resourceTimelineError: string | null;
  peopleOptions: PersonOptionDto[];
  timelineWindow: {
    focusId: string | null;
    centerMs?: number;
    scale?: "WEEK" | "MONTH" | "QUARTER" | "YEAR";
    taskCursor?: string;
  };
  timelineFocusError: string | null;
  nextPageHref: string | null;
}) {
  const router = useRouter();
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const model = useMemo(
    () => mergeProjectTimelineModel(tasks, resourceModel),
    [resourceModel, tasks],
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
  const selectedAnchorId = model.anchors.some(
    (anchor) => anchor.id === requestedAnchorId,
  )
    ? requestedAnchorId
    : null;

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
    <div className="min-w-0 space-y-4" data-testid="project-task-workspace">
      <section className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-semibold">Task</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {completedTaskTotalCount}/{taskTotalCount} 已完成
            </p>
          </div>
          {projectStatus === "ACTIVE" && (
            <Link
              href={`${routes.progress.taskNew}?projectId=${projectId}`}
              className={cn(buttonVariants({ size: "sm" }))}
            >
              <Plus />新建 Task
            </Link>
          )}
        </div>

        {tasks.length ? (
          <div className="mt-4 space-y-3">
            <ul className="divide-y rounded-lg border" aria-label="Project Task 列表">
              {tasks.map((task) => {
                const selected = model.anchors.some(
                  (anchor) =>
                    anchor.taskId === task.id && anchor.id === selectedAnchorId,
                );
                return (
                  <li
                    key={task.id}
                    className={cn(
                      "flex min-w-0 flex-wrap items-center gap-2 p-3",
                      selected && "bg-primary/5 ring-1 ring-inset ring-primary/30",
                    )}
                  >
                    <Link
                      href={routes.progress.taskDetail(task.id)}
                      className="min-w-0 flex-1 break-words font-medium hover:text-primary hover:underline"
                    >
                      {task.title}
                    </Link>
                    <Badge variant="secondary">{taskStatusLabels[task.status]}</Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={`在时间线中定位 ${task.title}`}
                      aria-pressed={selected}
                      disabled={Boolean(timelineError)}
                      title={timelineError ?? undefined}
                      onClick={() => locateTask(task)}
                    >
                      <LocateFixed />定位
                    </Button>
                  </li>
                );
              })}
            </ul>
            {nextPageHref && (
              <div className="flex justify-end">
                <ViewportStateLink
                  href={nextPageHref}
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                >
                  下一页 Task
                </ViewportStateLink>
              </div>
            )}
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">尚未关联 Task</p>
        )}
      </section>

      <section className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5">
        <div>
          <h2 className="font-semibold">Task 与人员投入时间线</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            当前页 Task · 按计划和投入自动确定范围
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
                taskCursor: timelineWindow.taskCursor,
              }}
              mode="TASK_WORKBENCH"
              allowCreate={false}
              readOnly
              initialFocusId={selectedAnchorId}
            />
          </div>
        )}
      </section>
    </div>
  );
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
    rows: [
      ...planModel.rows,
      ...(resourceModel?.rows
        .filter((row) => row.kind === "PERSON")
        .map((row) => ({ ...row, editable: false })) ?? []),
    ],
    segments: resourceModel?.segments ?? [],
    nextCursor: resourceModel?.nextCursor,
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
