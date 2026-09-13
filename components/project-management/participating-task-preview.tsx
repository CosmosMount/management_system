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
  const sortedTasks = [...tasks].sort((left, right) => compareDeadlineTasks(left, right, nowMs));
  return <div className="mt-4 overflow-x-auto rounded focus-visible:outline-2 focus-visible:outline-ring" role="region" aria-label="参与任务表格滚动区域" tabIndex={0}>
    <table aria-label="参与任务列表" className="w-full min-w-[42rem] table-fixed text-left text-sm">
      <thead className="text-muted-foreground">
        <tr>
          <th scope="col" className="w-[30%] pb-2 font-medium">任务</th>
          <th scope="col" className="w-[16%] pb-2 font-medium">状态</th>
          <th scope="col" className="w-[42%] pb-2 font-medium">当前节点</th>
          <th scope="col" className="w-[12%] pb-2 font-medium">版本</th>
        </tr>
      </thead>
      <tbody>
        {sortedTasks.map((task) => {
          const nodeName = task.activeMilestone?.goal ?? task.activeTermination?.name;
          const dueAt = task.activeMilestone?.expectedCompletedAt ?? task.activeTermination?.plannedAt;
          return <tr key={task.id} className="border-t border-border" data-testid={`participating-task-${task.id}`}>
            <td className="py-3 pr-3 align-top">
              <Link href={routes.progress.taskDetail(task.id)} className="break-words rounded font-medium [overflow-wrap:anywhere] hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring" title={task.title}>{task.title}</Link>
            </td>
            <td className="py-3 pr-3 align-top"><Badge variant="secondary">{taskStatusLabels[task.status]}</Badge></td>
            <td className="py-3 pr-3 align-top">
              <div className="break-words text-muted-foreground [overflow-wrap:anywhere]">
                {nodeName ?? "暂无"}{dueAt && <> · <time dateTime={dueAt}>{formatDateTime(dueAt)}</time></>}
              </div>
              <NodeDeadline target={task.currentNodeDeadline} className="mt-2" />
            </td>
            <td className="py-3 align-top"><Badge variant="secondary">v{task.currentPlanVersionNo}</Badge></td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}
