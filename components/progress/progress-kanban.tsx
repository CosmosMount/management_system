"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  ClipboardCheck,
  Clock3,
  Filter,
  Flag,
} from "lucide-react";
import type {
  Importance,
  TaskStatus,
  Urgency,
} from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  taskStatusLabels,
  urgencyLabels,
  importanceLabels,
} from "@/lib/progress-labels";
import {
  getTaskDeadlineSortRank,
  type TaskDeadlineState,
} from "@/lib/progress-deadline";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

export type KanbanTask = {
  id: string;
  title: string;
  projectName: string;
  stageName: string | null;
  assigneeNames: string;
  team: string;
  techGroup: string;
  taskTechGroups: string[];
  urgency: Urgency;
  importance: Importance;
  status: TaskStatus;
  isOverdue: boolean;
  hasRisk: boolean;
  dueAt: string;
  updatedAt: string;
  deadlineState: TaskDeadlineState;
  deadlineLabel: string;
  daysDelta: number;
};

type Props = {
  tasks: KanbanTask[];
  columns?: TaskStatus[];
  dueSoonDays: number;
};

type BoardFilter =
  | "all"
  | "overdue"
  | "today"
  | "dueSoon"
  | "normal"
  | "pendingAcceptance"
  | "completed"
  | "risk";

type UrgencyFilter = "all" | Urgency;

const defaultColumns: TaskStatus[] = [
  "TODO",
  "IN_PROGRESS",
  "PENDING_ACCEPTANCE",
  "COMPLETED",
];

const riskFilterOptions: Array<{ key: BoardFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "overdue", label: "已超时" },
  { key: "today", label: "今日到期" },
  { key: "dueSoon", label: "即将超时" },
  { key: "risk", label: "有风险备注" },
];

const urgencyFilterOptions: Array<{ key: UrgencyFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "HIGH", label: "高" },
  { key: "MEDIUM", label: "中" },
  { key: "LOW", label: "低" },
];

const deadlineTone: Record<
  TaskDeadlineState,
  {
    card: string;
    stripe: string;
    badge: string;
  }
> = {
  overdue: {
    card: "border-destructive/30 bg-destructive/5 hover:border-destructive/60",
    stripe: "border-l-destructive",
    badge: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  today: {
    card: "border-orange-300 bg-orange-50/80 hover:border-orange-400 dark:border-orange-900/60 dark:bg-orange-950/20",
    stripe: "border-l-orange-500",
    badge: "border-orange-300 bg-orange-100 text-orange-800 dark:border-orange-900/70 dark:bg-orange-950/40 dark:text-orange-200",
  },
  dueSoon: {
    card: "border-amber-300 bg-amber-50/70 hover:border-amber-400 dark:border-amber-900/60 dark:bg-amber-950/20",
    stripe: "border-l-amber-500",
    badge: "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-200",
  },
  normal: {
    card: "border-border/60 bg-background hover:border-primary/30",
    stripe: "border-l-border",
    badge: "border-border bg-muted/50 text-muted-foreground",
  },
  completed: {
    card: "border-emerald-200 bg-emerald-50/60 hover:border-emerald-300 dark:border-emerald-900/60 dark:bg-emerald-950/20",
    stripe: "border-l-emerald-500",
    badge: "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-200",
  },
};

export function ProgressKanban({
  tasks,
  columns = defaultColumns,
  dueSoonDays,
}: Props) {
  const [boardFilter, setBoardFilter] = useState<BoardFilter>("all");
  const [urgencyFilter, setUrgencyFilter] = useState<UrgencyFilter>("all");

  const sortedTasks = useMemo(() => {
    return [...tasks].sort(compareTasks);
  }, [tasks]);

  const visibleTasks = useMemo(() => {
    return sortedTasks.filter((task) => {
      if (!matchesBoardFilter(task, boardFilter)) return false;
      if (urgencyFilter !== "all" && task.urgency !== urgencyFilter) {
        return false;
      }
      return true;
    });
  }, [boardFilter, sortedTasks, urgencyFilter]);

  const riskTasks = visibleTasks.filter(isPriorityRisk);
  const stats = useMemo(() => getDashboardStats(tasks), [tasks]);
  const totalVisible = visibleTasks.length;

  const summaryItems = [
    {
      key: "overdue" as const,
      label: "已超时",
      count: stats.overdue,
      description: "超过截止时间",
      icon: AlertTriangle,
      className: "border-destructive/30 bg-destructive/5 text-destructive",
    },
    {
      key: "today" as const,
      label: "今日到期",
      count: stats.today,
      description: "今天需要处理",
      icon: CalendarClock,
      className:
        "border-orange-300 bg-orange-50 text-orange-800 dark:border-orange-900/60 dark:bg-orange-950/20 dark:text-orange-200",
    },
    {
      key: "dueSoon" as const,
      label: "即将超时",
      count: stats.dueSoon,
      description: `${dueSoonDays} 天内截止`,
      icon: Clock3,
      className:
        "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200",
    },
    {
      key: "normal" as const,
      label: "正常进行",
      count: stats.normal,
      description: "未进入风险窗口",
      icon: CircleDashed,
      className: "border-border bg-background text-foreground",
    },
    {
      key: "pendingAcceptance" as const,
      label: "待验收",
      count: stats.pendingAcceptance,
      description: "等待审批确认",
      icon: ClipboardCheck,
      className: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/20 dark:text-sky-200",
    },
    {
      key: "completed" as const,
      label: "已完成",
      count: stats.completed,
      description: "已完成未归档",
      icon: CheckCircle2,
      className:
        "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-200",
    },
  ];

  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {summaryItems.map((item) => {
          const Icon = item.icon;
          const active = boardFilter === item.key;
          return (
            <button
              key={item.key}
              type="button"
              aria-pressed={active}
              onClick={() => setBoardFilter(active ? "all" : item.key)}
              className={cn(
                "rounded-lg border p-3 text-left transition hover:-translate-y-0.5 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                item.className,
                active && "ring-2 ring-primary/40",
              )}
            >
              <span className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </span>
                <span className="text-2xl font-semibold leading-none">
                  {item.count}
                </span>
              </span>
              <span className="mt-2 block truncate text-xs opacity-80">
                {item.description}
              </span>
            </button>
          );
        })}
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-3 rounded-lg border bg-card/70 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground">
              <Filter className="size-4" />
              风险筛选
            </span>
            {riskFilterOptions.map((option) => (
              <Button
                key={option.key}
                type="button"
                size="sm"
                variant={boardFilter === option.key ? "default" : "outline"}
                aria-pressed={boardFilter === option.key}
                onClick={() => setBoardFilter(option.key)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground">
              <Flag className="size-4" />
              紧急度
            </span>
            {urgencyFilterOptions.map((option) => (
              <Button
                key={option.key}
                type="button"
                size="sm"
                variant={urgencyFilter === option.key ? "default" : "outline"}
                aria-pressed={urgencyFilter === option.key}
                onClick={() => setUrgencyFilter(option.key)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="text-sm text-muted-foreground">
          当前显示 {totalVisible} 个任务；临期窗口为 {dueSoonDays} 天。
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">风险任务</h2>
            <p className="text-sm text-muted-foreground">
              优先展示已超时、今日到期、即将超时和有风险备注的任务。
            </p>
          </div>
          <Badge variant="outline">{riskTasks.length}</Badge>
        </div>
        {riskTasks.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {riskTasks.map((task) => (
              <TaskCard key={task.id} task={task} />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed bg-muted/20 p-6 text-sm text-muted-foreground">
            当前筛选下暂无风险任务。
          </div>
        )}
      </section>

      <section className="grid gap-4 xl:grid-cols-4">
        {columns.map((col) => {
          const colTasks = visibleTasks.filter((task) => task.status === col);
          return (
            <Card key={col} className="bg-card/80">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between gap-3 text-sm font-medium">
                  <span>{taskStatusLabels[col]}</span>
                  <Badge variant="outline">{colTasks.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {colTasks.length === 0 && (
                  <p className="rounded-lg border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">
                    暂无任务
                  </p>
                )}
                {colTasks.map((task) => (
                  <TaskCard key={task.id} task={task} compact />
                ))}
              </CardContent>
            </Card>
          );
        })}
      </section>
    </div>
  );
}

function TaskCard({
  task,
  compact = false,
}: {
  task: KanbanTask;
  compact?: boolean;
}) {
  const tone = deadlineTone[task.deadlineState];
  return (
    <Link
      href={routes.progress.task(task.id)}
      className={cn(
        "block overflow-hidden rounded-lg border shadow-sm transition hover:-translate-y-0.5 hover:shadow-md",
        tone.card,
      )}
    >
      <div className={cn("border-l-4 p-3", tone.stripe)}>
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 flex-1 truncate font-medium leading-snug">
            {task.title}
          </p>
          <Badge variant="outline" className={cn("shrink-0", tone.badge)}>
            {task.deadlineLabel}
          </Badge>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {task.projectName}
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {task.hasRisk && (
            <Badge variant="destructive" className="text-xs">
              风险
            </Badge>
          )}
          <Badge variant="secondary" className="text-xs">
            {taskStatusLabels[task.status]}
          </Badge>
          {task.taskTechGroups.map((group) => (
            <Badge key={group} variant="outline" className="text-xs">
              {group}
            </Badge>
          ))}
          <Badge variant="outline" className="text-xs">
            紧急 {urgencyLabels[task.urgency]}
          </Badge>
          {!compact && (
            <Badge variant="outline" className="text-xs">
              重要 {importanceLabels[task.importance]}
            </Badge>
          )}
        </div>
        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          <p className="truncate">
            {task.assigneeNames || "未指定负责人"}
          </p>
          <p className="truncate">
            {task.stageName ? `阶段：${task.stageName}` : "阶段：无阶段"}
          </p>
        </div>
      </div>
    </Link>
  );
}

function compareTasks(a: KanbanTask, b: KanbanTask): number {
  const deadlineRank =
    getTaskDeadlineSortRank(a.deadlineState) -
    getTaskDeadlineSortRank(b.deadlineState);
  if (deadlineRank !== 0) return deadlineRank;

  const dueAtDiff = new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
  if (dueAtDiff !== 0) return dueAtDiff;

  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function matchesBoardFilter(task: KanbanTask, filter: BoardFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "overdue":
    case "today":
    case "dueSoon":
      return task.deadlineState === filter;
    case "normal":
      return (
        ["TODO", "IN_PROGRESS"].includes(task.status) &&
        task.deadlineState === "normal" &&
        !task.hasRisk
      );
    case "pendingAcceptance":
      return task.status === "PENDING_ACCEPTANCE";
    case "completed":
      return task.status === "COMPLETED";
    case "risk":
      return task.hasRisk;
  }
}

function isPriorityRisk(task: KanbanTask): boolean {
  return (
    ["overdue", "today", "dueSoon"].includes(task.deadlineState) ||
    task.hasRisk
  );
}

function getDashboardStats(tasks: KanbanTask[]) {
  return {
    overdue: tasks.filter((task) => task.deadlineState === "overdue").length,
    today: tasks.filter((task) => task.deadlineState === "today").length,
    dueSoon: tasks.filter((task) => task.deadlineState === "dueSoon").length,
    normal: tasks.filter(
      (task) =>
        ["TODO", "IN_PROGRESS"].includes(task.status) &&
        task.deadlineState === "normal" &&
        !task.hasRisk,
    ).length,
    pendingAcceptance: tasks.filter(
      (task) => task.status === "PENDING_ACCEPTANCE",
    ).length,
    completed: tasks.filter((task) => task.status === "COMPLETED").length,
  };
}
