import Link from "next/link";
import { AlertTriangle, ArrowRight, Clock3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  formatDateTime,
  taskMemberRoleLabels,
  taskPriorityLabels,
  taskStatusLabels,
} from "@/lib/project-management/labels";
import type { TaskListItem } from "@/lib/project-management/queries/task-queries";
import { routes } from "@/lib/routes";

export function TaskList({ tasks }: { tasks: TaskListItem[] }) {
  if (tasks.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        当前没有可见 Task。
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {tasks.map((task) => (
        <Link
          key={task.id}
          href={routes.progress.taskDetail(task.id)}
          className="block rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/40"
        >
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-base font-medium">{task.title}</h2>
                <Badge>{taskStatusLabels[task.status]}</Badge>
                <Badge variant="secondary">
                  {taskPriorityLabels[task.priority]}
                </Badge>
              </div>
              {task.description && (
                <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                  {task.description}
                </p>
              )}
              <p className="mt-2 text-sm text-muted-foreground">
                {task.team || "未设置战队"} / {task.techGroup || "未设置组别"} ·
                当前计划 v{task.currentPlanVersionNo}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {task.tags.map((tag) => (
                  <Badge key={tag.id} variant="outline">
                    {tag.name}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-2 text-sm text-muted-foreground lg:w-80">
              {task.activeMilestone ? (
                <p className="flex items-center gap-2">
                  <Clock3 className="h-4 w-4" aria-hidden="true" />
                  当前：{task.activeMilestone.goal} ·{" "}
                  {formatDateTime(task.activeMilestone.expectedCompletedAt)}
                </p>
              ) : task.activeTermination ? (
                <p className="flex items-center gap-2">
                  <Clock3 className="h-4 w-4" aria-hidden="true" />
                  当前：{task.activeTermination.name} ·{" "}
                  {formatDateTime(task.activeTermination.plannedAt)}
                </p>
              ) : (
                <p>当前没有 Active Milestone</p>
              )}
              <p>
                {task.members
                  .slice(0, 4)
                  .map(
                    (member) =>
                      `${member.displayName}(${taskMemberRoleLabels[member.role]})`,
                  )
                  .join("、")}
              </p>
              {task.segmentNeedsReviewCount > 0 && (
                <p className="flex items-center gap-2 text-amber-700">
                  <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                  {task.segmentNeedsReviewCount} 条计划关联待确认
                </p>
              )}
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <span className="inline-flex items-center gap-1 text-sm text-primary">
              打开工作台
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}
