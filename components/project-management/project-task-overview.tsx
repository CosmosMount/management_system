"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Popover } from "@base-ui/react/popover";
import { X } from "lucide-react";
import { TextTooltip } from "@/components/ui/text-tooltip";
import { deadlinePresentation } from "@/components/project-management/node-deadline";
import { evaluateDeadline } from "@/lib/project-management/current-node-deadline";
import type { ProjectTaskSummaryItem } from "@/lib/project-management/project-task-summary";
import { formatDateTime, taskStatusLabels } from "@/lib/project-management/labels";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

const deadlineDotClasses = { OVERDUE: "bg-red-500", DUE_SOON: "bg-amber-500", NOT_DUE: "bg-emerald-500", NONE: "bg-slate-400" };
const compactDeadlineLabels = { OVERDUE: "逾期", DUE_SOON: "临期", NOT_DUE: ">3天", NONE: "暂无" };

export function ProjectTaskOverview({ tasks, projectName, nowMs }: {
  tasks: readonly ProjectTaskSummaryItem[];
  projectName: string;
  nowMs: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(2);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      setColumns(Math.max(1, Math.min(4, Math.floor((entry.contentRect.width + 8) / 108))));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const capacity = columns * 2;
  const visibleCount = tasks.length > capacity ? capacity - 1 : capacity;
  const hiddenCount = Math.max(0, tasks.length - visibleCount);
  return <div ref={containerRef} className="min-w-0" data-testid="project-task-overview">
    {tasks.length === 0 ? <p className="text-xs leading-5 text-muted-foreground">暂无草稿或进行中的任务</p> : (
      <ul aria-label={`${projectName}任务概览`} className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 120px))` }}>
        {tasks.slice(0, visibleCount).map((task) => <li key={task.id} className="min-w-0"><ProjectTaskChip task={task} nowMs={nowMs} /></li>)}
        {hiddenCount > 0 && <li className="min-w-0">
          <Popover.Root>
            <Popover.Trigger className="flex h-12 w-full items-center justify-center rounded-lg border border-dashed bg-muted/20 px-1 text-sm font-medium text-primary hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-ring" aria-label={`查看${projectName}全部 ${tasks.length} 个草稿或进行中的任务`}>
              +{hiddenCount} 个任务
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner sideOffset={8} align="start" collisionPadding={16} className="z-50">
                <Popover.Popup className="flex max-h-[min(28rem,var(--available-height))] w-[min(30rem,calc(100vw-2rem))] flex-col rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg outline-none">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <Popover.Title className="min-w-0 break-words text-sm font-semibold [overflow-wrap:anywhere]">{projectName} · 任务概览</Popover.Title>
                    <Popover.Close aria-label="关闭任务概览" className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><X className="size-4" aria-hidden="true" /></Popover.Close>
                  </div>
                  <Popover.Description className="mt-1 text-xs text-muted-foreground">共 {tasks.length} 个草稿或进行中的任务，紧急优先。</Popover.Description>
                  <ul aria-label="全部草稿和进行中任务" className="mt-3 grid min-h-0 grid-cols-2 gap-2 overflow-y-auto overscroll-contain p-1 sm:grid-cols-3">
                    {tasks.map((task) => <li key={task.id} className="min-w-0"><ProjectTaskChip task={task} nowMs={nowMs} /></li>)}
                  </ul>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        </li>}
      </ul>
    )}
  </div>;
}

function ProjectTaskChip({ task, nowMs }: { task: ProjectTaskSummaryItem; nowMs: number }) {
  const deadline = evaluateDeadline(task.currentNodeDeadline, nowMs);
  const presentation = deadline === "NONE" ? null : deadlinePresentation[deadline];
  const state = taskStatusLabels[task.status];
  const deadlineText = presentation?.label ?? (task.status === "ACTIVE" ? "暂无期限" : "");
  const description = `${state}${deadlineText ? ` · ${deadlineText}` : ""}`;
  const tooltip = `${task.title}：${description}${task.currentNodeDeadline ? `，当前节点截止 ${formatDateTime(task.currentNodeDeadline.dueAt)}` : ""}`;
  return <TextTooltip text={tooltip}>
    <Link
      href={routes.progress.taskDetail(task.id)}
      aria-label={`${task.title}，${description}`}
      data-testid={`project-task-chip-${task.id}`}
      data-deadline-status={deadline}
      className={cn("flex h-12 min-w-0 flex-col justify-center gap-0.5 rounded-lg border px-2 text-sm transition-colors hover:brightness-95 focus-visible:outline-2 focus-visible:outline-ring", presentation?.className ?? "bg-muted/30 text-muted-foreground", "border-border/50")}
    >
      <span className="flex min-w-0 items-center gap-1.5"><span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-full", deadlineDotClasses[deadline])} /><span className="truncate font-medium text-foreground/85">{task.title}</span></span>
      <span className="whitespace-nowrap pl-4 text-[11px] leading-4" data-testid="task-chip-state">{state}{task.status === "ACTIVE" && ` · ${compactDeadlineLabels[deadline]}`}</span>
    </Link>
  </TextTooltip>;
}
