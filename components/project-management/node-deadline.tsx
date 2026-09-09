"use client";

import { AlertTriangle, CalendarClock, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useProgressNow } from "@/components/project-management/progress-clock";
import { evaluateDeadline, type CurrentNodeDeadline, type DeadlineStatus } from "@/lib/project-management/current-node-deadline";
import { formatDateTime } from "@/lib/project-management/labels";
import { cn } from "@/lib/utils";

export const deadlinePresentation = {
  OVERDUE: { label: "已逾期", icon: AlertTriangle, className: "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200" },
  DUE_SOON: { label: "即将到期", icon: CalendarClock, className: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200" },
  NOT_DUE: { label: "距到期超过 3 天", icon: Clock, className: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" },
} satisfies Record<Exclude<DeadlineStatus, "NONE">, { label: string; icon: typeof Clock; className: string }>;

export function deadlineLabel(target: CurrentNodeDeadline | null | undefined, nowMs: number) {
  const status = evaluateDeadline(target, nowMs);
  return status === "NONE" ? "" : deadlinePresentation[status].label;
}

export function DeadlineStatusBadge({ status, className }: { status: DeadlineStatus; className?: string }) {
  if (status === "NONE") return null;
  const presentation = deadlinePresentation[status];
  const Icon = presentation.icon;
  return <Badge variant="outline" className={cn("h-auto min-h-5", presentation.className, className)} data-deadline-status={status}>
    <Icon aria-hidden="true" className="mr-1 size-3" />{presentation.label}
  </Badge>;
}

export function NodeDeadline({ target, showDate = false, nowMs, className }: {
  target: CurrentNodeDeadline | null | undefined;
  showDate?: boolean;
  nowMs?: number;
  className?: string;
}) {
  const sharedNowMs = useProgressNow();
  const status = evaluateDeadline(target, nowMs ?? sharedNowMs ?? Number.NaN);
  if (status === "NONE" || !target) return null;
  return <span className={cn("inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1", className)} data-deadline-node-id={target.nodeId}>
    <DeadlineStatusBadge status={status} />
    {showDate && <time dateTime={target.dueAt} className="text-xs text-muted-foreground">{formatDateTime(target.dueAt)}</time>}
  </span>;
}

export function DeadlineLegend() {
  return <span aria-label="节点到期图例" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
    <span>当前节点到期：</span>
    <DeadlineStatusBadge status="OVERDUE" />
    <span className="inline-flex items-center gap-1"><DeadlineStatusBadge status="DUE_SOON" />72 小时内</span>
    <DeadlineStatusBadge status="NOT_DUE" />
  </span>;
}
