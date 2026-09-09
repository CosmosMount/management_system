"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { DeadlineLegend, NodeDeadline } from "@/components/project-management/node-deadline";
import { useProgressNow } from "@/components/project-management/progress-clock";
import { compareDeadlineTasks } from "@/lib/project-management/current-node-deadline";
import { formatDateTime, taskStatusLabels } from "@/lib/project-management/labels";
import type { TaskOptionPage } from "@/lib/project-management/types/time-canvas";
import { routes } from "@/lib/routes";

export function ParticipatingTaskPreview({ tasks }: { tasks: TaskOptionPage["items"] }) {
  const nowMs = useProgressNow() ?? Number.NaN;
  const preview = [...tasks].sort((left, right) => compareDeadlineTasks(left, right, nowMs)).slice(0, 6);
  return <div className="space-y-3">
    <DeadlineLegend />
    <table className="w-full table-fixed text-left text-sm [overflow-wrap:anywhere]">
      <thead className="text-muted-foreground">
        <tr><th className="w-[35%] pb-2 font-medium">任务</th><th className="w-20 pb-2 font-medium">状态</th><th className="pb-2 font-medium">当前节点</th></tr>
      </thead>
      <tbody>
        {preview.map((task) => {
          const nodeName = task.activeMilestone?.goal ?? task.activeTermination?.name;
          const dueAt = task.activeMilestone?.expectedCompletedAt ?? task.activeTermination?.plannedAt;
          return <tr key={task.id} className="border-t border-border" data-testid={`participating-task-${task.id}`}>
            <td className="py-3 pr-3 align-top"><Link href={routes.progress.taskDetail(task.id)} className="line-clamp-2 break-words font-medium hover:underline" title={task.title}>{task.title}</Link></td>
            <td className="py-3 pr-2 align-top"><Badge variant="secondary">{taskStatusLabels[task.status]}</Badge></td>
            <td className="space-y-1 py-3 text-muted-foreground">
              <span className="line-clamp-2" title={nodeName}>{nodeName ?? "暂无"}</span>
              {dueAt && <time dateTime={dueAt} className="block text-xs">{formatDateTime(dueAt)}</time>}
              <NodeDeadline target={task.currentNodeDeadline} />
            </td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}
