"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { NodeDeadline } from "@/components/project-management/node-deadline";
import { useProgressNow } from "@/components/project-management/progress-clock";
import { compareDeadlineTasks } from "@/lib/project-management/current-node-deadline";
import { formatDateTime, taskStatusLabels } from "@/lib/project-management/labels";
import type { TaskOptionPage } from "@/lib/project-management/types/time-canvas";
import { routes } from "@/lib/routes";

export function ParticipatingTaskPreview({ tasks }: { tasks: TaskOptionPage["items"] }) {
  const nowMs = useProgressNow() ?? Number.NaN;
  const preview = [...tasks].sort((left, right) => compareDeadlineTasks(left, right, nowMs)).slice(0, 6);
  return <ul aria-label="参与任务预览" className="divide-y divide-border text-sm">
        {preview.map((task) => {
          const nodeName = task.activeMilestone?.goal ?? task.activeTermination?.name;
          const dueAt = task.activeMilestone?.expectedCompletedAt ?? task.activeTermination?.plannedAt;
          return <li key={task.id} className="min-w-0 space-y-2 py-4" data-testid={`participating-task-${task.id}`}>
            <div className="flex items-start gap-3">
              <Link href={routes.progress.taskDetail(task.id)} className="min-w-0 flex-1 rounded font-medium hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring" title={task.title}><span className="line-clamp-2 break-words [overflow-wrap:anywhere]">{task.title}</span></Link>
              <Badge variant="secondary" className="shrink-0">{taskStatusLabels[task.status]}</Badge>
            </div>
            <div className="flex min-w-0 items-start gap-2 text-xs text-muted-foreground">
              <span className="shrink-0">当前节点</span>
              <span className="line-clamp-2 min-w-0 break-words [overflow-wrap:anywhere]" title={nodeName}>{nodeName ?? "暂无"}</span>
            </div>
            {(dueAt || task.currentNodeDeadline) && <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <NodeDeadline target={task.currentNodeDeadline} />
              {dueAt && <span className="text-xs text-muted-foreground">截止 <time dateTime={dueAt}>{formatDateTime(dueAt)}</time></span>}
            </div>}
          </li>;
        })}
  </ul>;
}
